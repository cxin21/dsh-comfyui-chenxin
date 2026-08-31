# Prompt Master DSH 插件 · 重新设计 Spec（方案 A：管线内核归位 + 方言注册表）

> 版本：v1.0 · 日期：2026-08-31 · 状态：brainstorming 五节全部确认，待实施
> 演进自：`docs/2026-08-27-prompt-engineering-framework-design.md`（原五层框架）、`docs/2026-08-27-native-plugin-design.md`（原 4 工具）
> 触发：DSH 0.1.2-alpha.2 更新后接口重审计 + 三份源码（提示词大师 3.1.0 / anima-prompt-v1 / minimax-h3-prompt）调研完成
> 依据调研：`temp/research/{dsh-interface-audit,promptmaster-3.1.0,anima-prompt-v1,minimax-h3-prompt}.md`

## 0. 第一性原理

**插件存在的唯一理由**：把三类提示词知识资产（提示词大师 PE 引擎、Anima catalog 证据库、MiniMax H3 官方方言）统一成"一条生成优秀提示词的管线"，让模型/用户以最少认知负担产出合规、可审计、可迭代的提示词。

由此推导的架构约束：
1. **管线只有一条，方言会变** → 内核不做 `if(target)`，方言按 target 注册（可扩展任何未来模型）。
2. **纯函数层与 IO 层分离** → runStage/dialect/audit 是纯函数（可测、可 trace），资源/subagent/日志在边界注入。
3. **数据资源归 preset 所有** → 插件是借用者，路径必须可注入，绝不硬编码。
4. **生产级 = 可观测 + 可对账** → 结构化日志贯穿，资产 manifest 每次运行时校验。

## 1. 总架构

```
                    ┌─────────────── runStage 内核（唯一，纯函数）───────────────┐
                    │  schema　　　dialect　　　audit　　　　render　　　　     │
PipelineInput ──▶  │  normalize → compile → audit+budget → envelope  │ ──▶ StageResult+trace
                    └──▲──────────▲───────────▲───────────▲──────────┘
                       │          │           │           │
                   schema/     dialect/    audit/      render/
                   normalize   registry    rules,budget   envelope
                       │          └── registerDialect(contract)（anima / h3 / 未来 mj…）
                       └── 资源层 resolveKnowledgePath + manifest 对账
```

```
工具视图（thin views，全部走 runStage 或轻 llm）：
  prompt_author  = intent(subagent) → runStage → 修正闭环
  prompt_compile = runStage（跳过 intent）
  prompt_audit   = runStage(auditOnly)
  prompt_expand / prompt_reverse = 意图层轻工具（直接 llm）
```

## 2. 内核契约

### 2.1 PipelineInput / StageResult（唯一形状）

```ts
// pe-framework/pipeline/types.ts
export interface PipelineInput {
  target: Target                       // 'anima' | 'h3' | 'sd' | 'generic'（开放式，见 §3.4）
  slots?: AnimaSlots                   // anima 侧
  variant?: 'aesthetic' | 'turbo' | 'base'
  shots?: H3ShotsInput                 // h3 侧
  stage?: string                       // 缺省由 dialect.normalize 推断
  scenarioId?: string
  formFields?: Record<string, unknown>
  auditOnly?: boolean
}

export interface StageResult {
  ok: boolean
  result: Record<string, unknown>      // anima: {positive,negative} | h3: {text,text_zh}
  gates: AuditGate[]
  advisories: string[]
  assumptions: string[]                // 显式记录（catalog_miss 等）——进入 Envelope
  budget?: Budget
  targetSlotHint: string
  trace?: PipelineTrace                // §5.2 可观测性
}

export interface PipelineTrace {
  stages: Array<{ name: 'schema'|'dialect'|'audit'|'budget'|'render'; ms: number }>
  catalogHits?: number
  tokenCounter?: 'official-tokenizer' | 'estimate'
  references?: number
}
```

- `StageResult` 提升自 `prompt-author.ts` 私有类型 → 内核公共类型（compile/audit 不再各拼 shapes）。
- `assumptions` 显式进入 Envelope（现状散落）；`catalog_miss` 等 assumption 既可做 advisory 展示也给 trace 统计。

### 2.2 runStage 调度（永不写 if(target)）

```ts
// pe-framework/pipeline/runStage.ts
export function runStage(input: PipelineInput): StageResult {
  const d = getDialect(input.target)
  if (!d) return DIALECT_NOT_AVAILABLE(input.target)
  const norm = d.normalize(input, { stage: input.stage, scenarioId, formFields })
  if (norm.error) throw new Error(norm.error)          // schema 校验失败 → 工具层转 isError
  const compiled = d.compile(norm.value, { variant, stage: norm.stage })
  const audit = d.audit(compiled, { stage: norm.stage, references: norm.references, shots: norm.value })  // 含 contractGates
  const budget = d.budget?.(compiled, { stage: norm.stage, references: norm.references })
  return assembleEnvelope({ ok, result: compiled, ...audit, budget, targetSlotHint: d.targetSlotHint })
}
```

- **错误路径统一**：`runStage` 只 throw（schema/dialect/audit 失败）；工具层 catch → `ctx.logger.error` 记堆栈 → `isError` 给模型可读 hint。不做"返回错误对象"的旁路，避免双语义。
- **auditOnly**：由 dialect 决定（`auditOnlyOk === false` 的方言在 auditOnly 时返回 `DIALECT_NOT_AVAILABLE` 或明确错误）；h3/anima 均支持：auditOnly 时不 emit `result` 正文（现有 compile 行为保留）。

## 3. 方言注册表（扩展性核心）

### 3.1 DialectContract

```ts
// pe-framework/dialect/contract.ts
export interface DialectContract<TSlots = unknown, TCompiled = unknown> {
  id: Target
  label: string
  auditOnlyOk: boolean
  normalize(input: PipelineInput, opts): {
    error?: string
    value?: TSlots
    stage?: string
    references?: Reference[]
  }
  compile(slots: TSlots, opts): TCompiled
  audit(compiled: TCompiled, ctx): { gates: AuditGate[]; assumptions?: string[] }
  budget?(compiled: TCompiled, opts): Budget | undefined
  targetSlotHint: string
  intent?: { persona: string; schema: string }
}
```

### 3.2 注册/查询/装配

```ts
// pe-framework/dialect/registry.ts
const dialects = new Map<Target, DialectContract>()
export function registerDialect(contract: DialectContract): void {
  if (dialects.has(contract.id)) throw new Error(`dialect already registered: ${contract.id}`)  // fail loud，拒绝静默覆盖
  dialects.set(contract.id, contract)
}
export function getDialect(target: Target): DialectContract | undefined
export function isDialectReady(target: Target): boolean   // = getDialect !== undefined（替换原状态机）
```

装配 = 插件 `apply` 前模块副作用注册：
```ts
// plugin/index.ts（顶部）
import './pe-framework/dialect/anima.js'   // 内部 registerDialect({id:'anima', ...})
import './pe-framework/dialect/h3.js'
```
（注册发生在 import 副作用阶段，先于任何 runStage 调用；两个模块在 apply 之前就绪。）

### 3.3 anima / h3 重构落点

| 现文件 | 重构后 |
|---|---|
| `prompt-author.ts` 的 `runDraftStage`/`inferH3Stage`/`toRefs` | **删除**，逻辑归 dialect.normalize + runStage |
| `prompt-compile.ts` 的 `inferH3Stage`/`toReferences`/`compileH3Envelope` | **删除**，变薄视图：`runStage({target:'h3', ...})` |
| `prompt-audit.ts` 的 `toRefs` | **删除**，薄视图：`runStage({target, auditOnly:true})` |
| `pe-framework/dialect/anima.ts` | `registerDialect({ id:'anima', normalize: validateAnimaSlots, compile: compileAnima, audit: auditAnima, targetSlotHint:'t2i.prompt', intent:{persona,schema} })` |
| `pe-framework/dialect/h3.ts` | `registerDialect({ id:'h3', normalize: normalizeH3Input(inferH3Stage+toRefs), compile: compileH3, audit: auditH3Full+contractGates, budget: buildH3Budget, targetSlotHint:'t2v.prompt', intent:{...} })` |

- `normalizeH3Input` 从三处重复收敛为 dialect/h3.ts 内唯一实现（stage 推断 + toRefs）。
- `validateAnimaSlots` 从 composition.py `_coerce_brief` 移植：AnimaSlot 键白名单 + 类型校验（narrative string、其余 string[]）。

### 3.4 Target 开放性

`Target` 类型保持 `'anima' | 'h3' | 'sd' | 'generic'`（现状），注册表以它为 key。未来加模型 = **扩展 Target 联合类型 + 新增 registerDialect + resolver profile**（配方与方言正交，§6）。sd/generic 未注册 → `DIALECT_NOT_AVAILABLE`（现在的行为，改为查表）。**内核零改动**。

## 4. 资源层

### 4.1 路径解析（唯一入口）

```ts
// pe-framework/resources/resolve.ts
export interface ResourceOptions { presetRoot?: string; skillDir: string; asset: string }
export function resolveKnowledgePath(opts: ResourceOptions): string
// 优先级：opts.presetRoot（plugin config）→ env DSH_COMFYUI_PRESET_ROOT → 插件包向上寻 preset 根
// 最终：<presetRoot>/skills/<skillDir>/knowledge/<asset>
export function setPresetRoot(root: string | undefined): void   // plugin apply 时注入（模块级单值）
```

**presetRoot 注入与多会话**：
- 值来自 **plugin config**（agent.cordis.yml 的 prompt-master `config.presetRoot`）——per-preset 配置，同一 preset 的多会话值相同。
- `setPresetRoot` 是模块级单值，假定**一个进程内同 preset 插件只挂一次**（preset 是 per-session 挂载——**多会话会各挂一个插件实例**）。
- **风险与定案**：两个不同 preset 引用同一插件包且配不同 presetRoot 时，模块级单值会互相覆盖。**本轮定案**：prompt-master 只服务 comfyui-chenxin preset（现状），单值足够；若未来多 preset 复用，升级为 `resolveKnowledgePath` 显式传参（config 每调用传入，去掉模块级单值）——**在 §10 决策记录标注此演进路径**。
- **loader 相对回退**（无 config 无 env 时）：插件 dist 位于 `<presetRoot>/plugins/prompt-master/dist/src/...`，向上 3 级到 `<presetRoot>/plugins`，再 1 级到 `<presetRoot>`（共 4 级 `..` 到 preset 根）。此路径仅作兜底，**推荐显式 config**（随 preset 迁移不碎）。

- `anima-catalog.ts`：删 DEFAULT_CATALOG_PATH / OVERLAY_PATH 硬编码 → `resolveKnowledgePath({skillDir:'anima-prompt-v1', asset:'tag-catalog.sqlite'})`；overlay 同（`relation-overlay.sqlite`）。
- `tokenizer-h3.ts`：`resolveKnowledgePath({skillDir:'minimax-h3-prompt', asset:'tokenizer.json'})` 所在目录。
- `plugin/config.ts`：加 `presetRoot?: string`（agent.cordis.yml 注入；loader 已有 presetRoot 先例，协议一致）。
- **缺失时**：显式抛错（可读：'catalog not found at ...；请确认 preset 完整或运行 scripts/setup.ps1'）。

### 4.2 资产版本对账（Lazy，首用一次）

```ts
// pe-framework/resources/manifest.ts
export function assertAssetPresent(skillDir: string, asset: string, manifestCheck: (m: unknown) => string | null): { ok: true } | { ok: false; reason: string }
// anima：manifest.json output checksum vs tag-catalog.sqlite 实算 → 不匹配 reason
// h3：manifest.json snapshot_id/integrity vs tokenizer 文件 → 不匹配 reason
```

- 校验失败 → **不硬崩**：`ctx.logger.warn(reason + '：资产与 golden 基线不同，请 re-run fidelity capture')` + 语义回退（tokenizer → counter='estimate'）。
- 这把双跑保真从一次性测试变运行时对账。

## 5. 生产级可观测性

### 5.1 原则
- 用 DSH `ctx.logger`（Cordis，包名标记 `prompt-master`），绝不用 console.log。
- 阶段日志打摘要（耗时/命中数/预算/stopReason），不打完整正文/图片/API key/customProfiles。
- 与会话日志互补：会话记"发生了什么"（tool/call+result），插件记"内部为什么"（阶段/回退/错误）。

### 5.2 注入模型
- **纯函数层**（runStage/dialect/audit）**零日志副作用** → 返回 `trace`（§2.1），由持有 ctx.logger 的工具层统一打。
- **IO 边界**（intent/subagent、资源层）→ 直接注入 ctx.logger。

### 5.3 日志清单

| 层 | 事件 | 级别 |
|---|---|---|
| 工具入口 | `prompt_author/compile/audit/expand/reverse 调用 target/variant/stage` | info |
| schema | normalize 失败（白名单/类型） | error（转 isError 给模型，日志记堆栈） |
| dialect | compile 完成 `→ keys + ms` | debug |
| audit | gates 数 + critical 数 + budget over 明细 | info |
| render | envelope 组装完成 | debug |
| intent | subagent start/childId/stopReason/timeout/重跑轮次 | info |
| 资源 | 路径解析 / manifest 校验通过·失败 / estimate 回退原因 | warn（回退时） |
| 修正闭环 | 每轮 feedback 摘要 + 收敛 / loop_exhausted | info |

### 5.4 错误可诊断
失败统一 `ctx.logger.error({target, stage, message, error})`；模型看到 isError 的可读 hint，日志保留完整堆栈。

## 6. intent 决策表

| 入口 | 任务形态 | 模型交互 | 理由 |
|---|---|---|---|
| `prompt_author` 首轮 | 一句话 → slots/shots | subagent（`getDialect(target).intent.persona/schema`） | 隔离、专用 persona、输出 schema 校验 |
| `prompt_author` 修正闭环 | 带 feedback 重拆 | subagent（同 persona） | 与首轮一致 |
| `prompt_expand` | 润色扩写 | 直接 llm（complete.ts） | 轻任务；subagent 浪费一次启动 |
| `prompt_reverse` | 图/描述 → 反推 | 直接 llm（completeWithBlocks） | 需图片 block 直传；subagent 会丢附件 |
| `prompt_compile`/`prompt_audit` | 无 LLM | —（纯函数 runStage） | — |

> 决策表写入 `usage-prompt-engineering.md`（分工标注，消除 double-implementation 歧义——延续设计文档 §11 风险 5 的处理）。

### 6.1 prompt_author 修正闭环（编排定稿）

```ts
// prompt-author.ts execute 的编排（唯一持有闭环逻辑；compile/audit 无闭环）
for (let round = 0; round <= MAX_CORRECTIONS; round++) {
  const draft = await intentProvider(req, exec)          // subagent；round>0 时带 feedback
  const stage = runStage({ target, slots/draft, ... })    // 内核；无 LLM
  if (stage.ok || !stage.gates.some(g => g.severity === 'critical')) break
  if (round === MAX_CORRECTIONS) { trail.push('loop_exhausted:true'); break }
  // feedback 来源 = critical gates 的 detail（非 assumptions——assumptions 只进 advisory）
  feedback = stage.gates.filter(g => g.severity === 'critical').map(g => `[${g.rule}] ${g.detail}`).join('\n')
  req = { ...req, round: round + 1, feedback }
}
return assembleEnvelope(stage, trail)
```

- **feedback 唯一来源**：critical gates 的 `[rule] detail`（现状行为，spec 定稿）；`assumptions`（如 `catalog_miss`）只进 advisory 与 trace，不驱动重跑。
- 闭环逻辑留在工具层（它依赖 intentProvider 的 subagent 交互，不适合下沉纯函数内核）；`runStage` 保持无 LLM、无循环。

## 7. 配方 × 方言（复用现有 resolver）

- resolver 层（提示词大师 PE 引擎 1:1 移植）不动，作为**配方**维度（怎么说）。
- 方言（dialect registry）作为**目标**维度（给谁看）。
- 补充核对（E1 遗留）：resolver 与 3.1.0 源码逐文件 diff；`getExpandFormatHint`/`sanitizeTagOutput`/`LEGACY_EXPAND_PE_ID_MAP` 兼容分支保留；Anima3 优先级规则与双语标点逐字保留（见 promptmaster-3.1.0.md §1.2/§7 调研结论）。

## 8. 测试策略

| 层 | 内容 |
|---|---|
| 内核单测 | `runStage` 各 target 分支、auditOnly、`DIALECT_NOT_AVAILABLE`、错误 throw |
| 注册表 | 重复注册拒绝、getDialect 查表、isDialectReady |
| 方言白盒 | normalize stage 推断/toRefs 唯一实现、validateAnimaSlots 白名单 |
| 资源层 | resolveKnowledgePath 优先级；manifest 通过/失败两分支 |
| 工具薄视图 | author/compile/audit 测 runStage 映射（内层已覆盖） |
| fidelity | 保留 golden；manifest 对账后资产变更 → re-capture 流程（pwsh 落文件，沙箱规则已在 harness.ts） |
| intent mock | subagent-provider 既有用例 + 修正闭环收敛（audit-loop） |
| 日志 | trace 断言（内核返回值）；工具层 logger 打点用 spy 断言级别与摘要字段（不含正文） |

## 9. 实施批次（writing-plans 细化）

| 批 | 内容 | 验收 |
|---|---|---|
| R1 | 资源层：resolveKnowledgePath + setPresetRoot + manifest 对账；替换 2 处硬编码 | tsc 干净；270 测试绿；硬编码消失 | 
| R2 | 方言注册表 + runStage 内核 + render/ 层（assembleEnvelope）+ StageResult 公有化 | registry/内核单测绿；author/compile/audit 改薄视图 |
| R3 | 删 3 处重复（inferH3Stage/toRefs/renderEnvelope 重复实现）；intent persona/schema 从 dialect 读 | 无重复；author/compile/audit 全走 runStage |
| R4 | budget 帧底精确化（countContext('', N)）+ intent 决策表文档化 | golden 新增帧底断言 |
| R5 | 日志贯穿（trace + logger 打点）+ resolver 与 3.1.0 diff 核对 | 日志清单全覆盖；diff 无遗漏 |
| R6 | 全量回归 + 真实会话 prompt_author 端到端（subagent intent）+ fidelity re-capture | prompt_author anima/h3 产出 Envelope；修正闭环收敛 |

## 10. 决策记录

- D1（用户裁决）：intent 层 subagent 交互（author 拆结构），轻任务 expand/reverse 直接 llm——决策表 §6。
- D2：camera-*/loader 集成层不动。
- D3：catalog 运行时 sqlite 直读（783 MiB 不可入内存）；node:sqlite readOnly。
- D4：方言注册表为扩展性合约（用户：考虑未来其他模型）。
- D5：H3 budget 精确化优先，estimate 仅显式回退。
- D6：render/ 独立成层（assembleEnvelope 唯一实现）。
- D7（用户）：生产级 = 结构化日志 + 运行时资产对账。
- D8：presetRoot 本轮用模块级单值（只服务 comfyui-chenxin）；**演进路径**：多 preset 复用插件时，`resolveKnowledgePath` 改为显式传参（config 每调用传入），去掉模块级单值（§4.1 已标注）。

## 11. 明确不做（范围外）

- camera-* 执行端（loader 集成层）
- 训练打标专属工具；JoyCaption 额外选项复活（需从原 PM 取实现文本）
- history/多用户/云端同步（DSH session log + settings 承担）