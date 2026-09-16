# 质量飞轮设计：证据化评审 → 人工反馈 → 自动优化

> 2026-09-08 · prompt-master 插件质量提升专项设计
> 路线：路线 A（评审进管线）骨架，收编路线 C（多智能体辩论）的三个精华：
> 带证据评审、对抗性二轮、辩论留痕。
> 上游讨论：GitHub 对标调研（ComfyUI_DanTagGen / DART / ai-shortfilm-prompts /
> story-shot-agent / DSPy / promptfoo）+ 路线 A/C 对比，用户已确认。

## 0. 背景与目标

### 0.1 现状

PE-Framework 五层管线（intent → schema → dialect → audit → render）P0-P4 已完成：
`prompt_author` 主入口带规则审计 + 自动修正闭环（max 2 轮）；anima / h3 两个方言
已注册；golden 逐字节保真测试 621 条基线。

质量侧短板：

- `eval/judge.ts` 已有雏形但定位「可选路径」，未进主闭环
- 审计以确定性规则为主，语义层质量（tag 矛盾、镜头冗余、跨镜头角色不一致）无人守
- 没有人工反馈通道，生成质量无法迭代
- `model-capabilities` 只有 LLM 供应商家族参数，无目标模型语义知识

### 0.2 目标

1. `prompt_author` 出稿质量提升：语义层错误在出稿前被拦截并修正
2. 「按模型区分」正式落点：评审 rubric 进入方言注册表，与 dialect 同生命周期
3. 建立质量数据闭环：每次生成可追踪、可反馈、可复盘
4. 评测集积累到位后，intent persona 可用数据驱动方式自动优化

### 0.3 非目标（Non-Goals）

- 不新增目标模型方言（Flux/SDXL/可灵等另立专项，本设计的 rubric 机制是其前置）
- 不做运行时多智能体辩论（路线 C 全量版，成本 3-5 倍被否决，只收编机制）
- 不做 UI / Electron 任何回归
- 不改确定性编译路径（compile/audit 纯函数行为与 golden 全部不变）
- A3 自动优化不注册为 agent 工具（离线 CLI 级，防误触发烧 token）

## 1. 总体架构：三阶段飞轮

```
§1 证据化评审（运行时，即时提质量）
   prompt_author ─→ 规则审计 ─→ EvidenceCritic 评审 ─→（strict 时对抗二轮）─→ 出稿
                                        │ debate 全程留痕
§2 反馈通道（数据积累）                 ▼
   generations 表（自动）+ prompt_feedback 工具（人工）→ sqlite
                                        │ L1≥50 条（或 L1+L2≥80）
                                        ▼
§3 自动优化（离线，人审闸门）
   scoring harness → persona 变体迭代 → diff 报告 → 人审 → 固化提交
```

三阶段递进，每阶段独立可交付、独立可验收。§1 落地即有质量收益；
§2 只做存储不依赖 §3；§3 冷启动前 harness 本身可当回归工具。

## 2. §1 证据化评审基座

### 2.1 EvidenceCritic（judge.ts 升级）

```
judgeReview(stage: 'first' | 'revision', artifacts)
  输入：编译后 slots/shots + 规则审计结果 + 方言 rubric
  证据工具（评审中可调用）：
    ├─ catalog_search(tag)   → anima：tag 真实性/别名/风格证据
    ├─ tokenizer 预算查询    → h3：每镜头精确 token 占用
    └─ aesthetics/check      → 两者：具体性/保真词法检查
  输出（JSON schema 强约束）：
    { verdict: 'pass' | 'needs_revision',
      score: 0-100,
      findings: [{ severity: 'blocker'|'major'|'minor', dimension, problem,
                   evidence: { tool, query, result }, requiredFix }],
      praise?: string[] }
```

铁律：**每条 findings 必须带 evidence**。评审意见禁止无证据的 vibes
（「感觉不够美」），必须是「`cyberpunk` 在 catalog miss，建议 `science fiction`
（canonical 命中 3 次）」。findings 结构复用现有 Envelope 约定，
修正闭环 feedback 拼接逻辑零改动。`praise` 传给修正轮当锚点，防过修正。

**LLM 路线**：与 intent 阶段同一条 DSH subagent 路线（persona/schema 来自
rubric 定义，parent = 调用 Agent），复用 `intent/subagent-provider` 的注入机制；
不可用时按 §2.5 降级。judge 不新增独立 HTTP 供应商配置。

> **迁移事实（M1 必读）**：现 `eval/judge.ts`（spec §13 旧评估闭环）走的是
> `llm/complete` HTTP 直连（`JudgeRoute{provider,model}`），与目标路线不一致。
> M1 升级 EvidenceCritic 时将推理路线从 `llm/complete` 直连替换为
> subagent-provider；`judgeBlueprint` 的旧签名与 `tests/eval/judge.test.ts`
> 同步迁移。旧「coherence/fidelity/aesthetic 三维 0-10」评分形状由
> dimensions 加权 score + findings 结构取代，旧消费者（若有）一并更新。

**rubric 接口**（M1 契约，实施不得偏离）：

```ts
interface DialectRubric {
  dimensions: ReadonlyArray<{
    id: string; // 如 'tag-order' | 'cross-shot-consistency'
    weight: number; // 归一化权重，score 加权用
    instruction: string; // 评委 persona 注入的评审指令
  }>;
  severityRules: string; // blocker/major/minor 的判定标准文本
  evidenceTools: ReadonlyArray<'catalog' | 'tokenizer' | 'aesthetics'>;
  passThreshold: number; // 0-100，≥ 此值且无 blocker 才 verdict=pass
}
```

阈值进 rubric 不进代码：anima 初始 `passThreshold=80`、h3 初始 `75`
（h3 语义层主观性强，阈值放宽），上线后按 §3 的人工分对齐数据校准。

**audit_only 行为**：`prompt_author(audit_only=true)` 与独立 `prompt_audit`
工具**不触发评审**——它们是「只查不改」的确定性闸门，评审只属于完整生成链路。

**evidence 降级**：h3 无 catalog（tokenizer/aesthetics 可用）、或任一工具加载
失败时，该工具从 `evidenceTools` 中剔除并在 findings 允许缺证据的 dimension
白名单内放宽（advisory 标注 `evidence_partial: true`），不阻塞评审本身。

### 2.2 Rubric 按方言注册

`DialectContract` 增加可选字段 `rubric`，进 dialect registry（与
normalize/compile/audit/budget/targetSlotHint/intent 并列）。新方言不带 rubric
则自动跳过评审层（向后兼容）。

| 层                               | anima rubric                                                                                 | h3 rubric                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 语法层（规则闸门已守，评委抽查） | tag 顺序权重序（质量→主体→角色→特征→动作→构图→背景）                                         | 六段式完整、cut 时间戳                                                               |
| 语义层（主战场）                 | tag 自相矛盾（`1girl`+`multiple boys`）、正负提示词冲突、风格词 catalog 证据、负面模板完整度 | 镜头间信息增量（语义级，深于现有 CJK 感知 semanticShot）、分镜节奏、时长与内容量匹配 |
| 一致性层                         | 主体特征 slots 内外一致                                                                      | 跨镜头角色一致性：同角色跨 shots 描述/ref 引用矛盾（本设计最高价值点）               |
| 美学层                           | aesthetics lexicon 具体性                                                                    | 氛围段与画面段呼应                                                                   |

### 2.3 运行位置与成本模式

`runStage` 在规则审计之后插入评审阶段：

- `judge: 'off'`：现状，跳过评审（默认值可配，保守上线）
- `judge: 'fast'`：首轮评审一次，pass 即出稿（日常推荐，+1 次轻量调用）
- `judge: 'strict'`：needs_revision → 修正稿（修订者可带证据反驳，格式
  `{ rebuttal, evidence }`）→ **复审只验证 findings 关闭 + 反驳成立**（非全量重评）
  → 仍不过才计入现有修正闭环（max 2 不变）

规则审计出现 critical 时跳过评审直接进现有修正闭环（确定性错误不值得花评审 token）。

### 2.4 辩论留痕（收编自路线 C）

Envelope 新增：

```
debate: [{ round, reviewer: { findings[], score },
           reviser?: { changes[], rebuttals: [{ finding_id, rebuttal, evidence }] } }]
```

debate 是单一数据结构服务两个消费方：用户复盘（为什么这稿被改了）+
§3 自动优化（最高质量的失败模式语料）。

### 2.5 降级与永不阻塞

judge LLM 不可用 / 超时 / 输出不合 schema → `judge: { skipped: true }` +
advisory 透传，按纯规则审计结果出稿。评审层任何故障不得阻塞出稿。

## 3. §2 人工反馈通道

### 3.1 generation_id

每次 `prompt_author` 成功产出生成 `gen_<timestamp>_<rand>`，Envelope 顶层携带。
串联：生成记录 ↔ 人工反馈 ↔ §3 取样。

### 3.2 存储（node:sqlite DatabaseSync，复用 anima-knowledge 同款读写模式）

> 事实核正：原生插件持久化层是 `node:sqlite` `DatabaseSync`（见
> `anima-knowledge/relations.ts` 每次操作开/关连接的模式），不是旧 MCP 架构的
> sql.js。feedback store 沿用同一模式与工具函数。

```
generations:
  id, created_at, target, variant, judge_mode,
  input_digest(哈希), final_output, judge_score, judge_verdict,
  debate_json, repair_rounds

feedback:
  generation_id(FK), rating(1-5), tags_json, notes,
  actual_output_path, created_at
```

隐私边界：不落图片、不落 API key；`input_digest` 只存哈希，原始 input 仅在内存。
`feedback.generation_id` 联查 `generations.judge_score` 即得「评委分 vs 人工分」
对齐数据——这是未来校准 LLM 评委的唯一依据。

**大小与保留策略**：

- `debate_json` 单条上限 64KB（超长裁剪 minor findings，保留 blocker/major 全文，
  裁剪时标 `truncated: true`）；`final_output` 上限 32KB
- `generations` 保留 90 天，`feedback` 永久保留（反馈是稀缺数据）
- 清理在写入时懒执行（每次 record 顺带删过期），不加后台任务

**评分校准动作**（依赖 §3 数据，M2 之后持续）：`stats` 增加
「评委分 vs 人工分」相关性视图；偏差持续 >15 分时按 §4.3 变异流程校准 rubric
权重与 passThreshold——校准走同一条人审闸门，不自动生效。

**文档同步义务**：新错误码 `generation_not_found`、Envelope 新字段
（`generation_id` / `debate` / `judge`）必须同步进 preset 的
`docs/troubleshooting.md` 错误表与 AGENTS.md 约定，作为 M2 验收项之一。

### 3.3 prompt_feedback 工具（新工具，不塞进 profile_list）

```
action=record   { generation_id, rating, tags?, notes?, actual_output_path? }
action=list     { target?, min_rating?, max_rating?, limit }
action=get      { generation_id }
action=stats    { target? }   → 均分/分布/高频负反馈 tag
```

- `tags` 预置负反馈词表（anima：构图/肢体/风格偏差/…；h3：角色不一致/镜头冗余/
  节奏/…），自由扩展——A3 按「失败模式」分桶的维度
- `record` 最小必填 = generation_id + rating，其余全可选（低摩擦保反馈率）
- Envelope 永远带 generation_id，用户出图/出视频后一条动作完成回写

## 4. §3 DSPy 式自动优化（离线）

### 4.1 定位

不进运行时。产出物 = 更好的 intent persona / rubric 权重 / few-shot 样例，
经人审后以普通 git 提交固化（src 改动 → build → golden 全过，现有纪律）。

### 4.2 scoring harness

新增 `tests/eval/scoring`。评测集三层来源、按置信度加权：

| 层  | 来源                                     | 权重     |
| --- | ---------------------------------------- | -------- |
| L1  | 人工反馈 rating≥4（正例）/ ≤2（负例）    | 最高     |
| L2  | debate 中被 blocker 拦下并修复成功的案例 | 中       |
| L3  | 现有 golden 中 author 相关用例           | 回归兜底 |

```
scoring(generation, case) = 0.5 × judge_score（当前 rubric 重评）
                          + 0.3 × 规则审计通过率
                          + 0.2 × 人工评分（无人工数据时权重归还前两项）
```

### 4.3 变体迭代循环（GEPA 式简化版）

```
loop（离线全自动，人审闸门前）:
  1. 变异：强 LLM 读「负例 + debate findings」→ 提出 persona 修改候选
  2. 评测：候选 × evalset 全量跑 author（生成可用便宜模型，judge 与线上同配置）
  3. 择优：配对比较显著优于 incumbent → 提桓名单
  4. 报告：逐维得分、改善的失败模式、有无回归
```

**人审闸门**：候选不自动生效。产出 persona diff 报告（改哪句/为什么/数据支撑），
用户点头后改 `intent/` 源码 + 更新 golden + 提交。

### 4.4 冷启动门槛

某 target 的 L1≥50 条（或 L1+L2≥80 条）才跑迭代；此前只建 harness——
harness 本身即价值（每次手改 persona 前手动跑一遍当回归）。
评测集存 `assets/knowledge/<target>/evalset/`（版本化管理）。

## 5. 文件清单

新增：

```
src/pe-framework/eval/rubrics/anima.ts          §2.2 anima rubric
src/pe-framework/eval/rubrics/h3.ts             §2.2 h3 rubric
src/pe-framework/eval/critic.ts                 §2.1 EvidenceCritic（judge.ts 升级迁移）
src/pe-framework/eval/evidence.ts               §2.1 证据工具桥
src/pe-framework/feedback/store.ts              §3.2 generations + feedback 表
src/tools/prompt-feedback.ts                    §3.3 新工具
src/pe-framework/optimize/{harness,mutate,report}.ts   §4 离线优化（CLI 级）
tests/eval/…                                    各层测试（mock provider）
assets/knowledge/<target>/evalset/              §4.4 评测集（§3 落地后）
```

修改：

```
src/pe-framework/dialect/contract.ts            +rubric? 字段
src/pe-framework/dialect/{anima,h3}.ts          注册各自 rubric
src/pe-framework/pipeline/runStage.ts           +评审阶段（audit 后）
src/tools/prompt-author.ts                      +judge_mode / generation_id / debate 字段
```

## 6. 错误处理与降级汇总

| 故障                                    | 行为                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| judge LLM 不可用/超时/schema 不合       | `judge.skipped=true` + advisory，纯规则审计出稿       |
| 规则审计 critical                       | 跳过评审，直接现有修正闭环                            |
| strict 复审仍 needs_revision            | 计入修正闭环（max 2），loop_exhausted 照旧标注        |
| feedback record 的 generation_id 不存在 | envelope ok=false，code=`generation_not_found`        |
| sqlite 写失败                           | advisory 透传，出稿不受影响（反馈是增强层不是阻塞层） |

## 7. 测试策略

- critic 单测：schema 校验、rubric 加载、证据工具注入、mock LLM 全路径
- 评审闭环 e2e（mock provider）：fast / strict / off 三模式、降级路径
- feedback 存储单测：CRUD、联查、stats 聚合；工具 envelope 测试
- optimize 纯函数单测（scoring 计算、配对比较）
- **现有 621 golden 基线零破坏**（评审在运行时层，不进确定性编译路径）
- 验证命令沿用插件约定：`npx vitest run` / `npx tsc --noEmit` / `npm run build`

## 8. 交付顺序

| 阶段 | 内容                                            | 验收                                               |
| ---- | ----------------------------------------------- | -------------------------------------------------- |
| M1   | §2.1-2.5 critic + rubric + runStage 集成 + 降级 | vitest 全过；author 三模式行为正确；golden 零破坏  |
| M2   | §3 存储 + prompt_feedback 工具                  | CRUD/联查/stats 测试过；author 落 generations      |
| M3   | §4 harness（不跑迭代）                          | scoring 计算测试过；可手动跑评测集                 |
| M4   | §4 迭代循环 + 报告                              | 冷启动门槛前只验收代码；门槛后出首份 diff 报告人审 |

## 9. 设计自审记录

第三轮审（文档 vs 代码现实）发现并修复 2 处事实错误：

1. 存储层写错：文档声称 sql.js，实际原生插件用 `node:sqlite DatabaseSync`
   → §3.2 已核正，沿用 anima-knowledge 同款读写模式
2. judge 推理路线迁移事实缺失：现 judge.ts 走 `llm/complete` HTTP 直连而非
   subagent 路线，M1 是「替换」不是「叠加」→ §2.1 补迁移说明，
   旧三维评分形状废弃路径已写明
3. 顺带核实（无需改动）：`DialectContract` 现有 `intent?/capabilities?/aesthetics?`
   可选字段模式与新增 `rubric?` 完全兼容；`PipelineInputLike.auditOnly` 与
   `auditOnlyOk` 钩子已存在，§2.1 的 audit_only 决策可直接挂载

第二轮深审（用户质疑后重读全文，以「照此实施会否扯皮」为标准）发现并修复 7 处缺口：

1. judge 的 LLM 路线未写 → §2.1 明确与 intent 同一条 DSH subagent 路线
2. rubric 接口形状未定义 → §2.1 补 `DialectRubric` TS 契约
3. score 阈值未定 → §2.1 阈值进 rubric（anima 80 / h3 75），不进代码
4. `audit_only` / `prompt_audit` 与评审关系未覆盖 → §2.1 明确不触发评审
5. 表膨胀无策略 → §3.2 补 debate_json 64KB 裁剪、90 天懒清理、feedback 永久
6. 新错误码未同步 preset 文档 → §3.2 列为 M2 验收项
7. evidence 工具缺失降级 → §2.1 补 `evidence_partial` 放宽机制

首轮自审结论（维持有效）：

- 占位符扫描：无 TBD/TODO。
- 一致性：§2.3 strict 复审与 §6 降级表一致；max 2 修正闭环全程未变。
- 范围：单一实施计划可承载（M1-M4 线性依赖），无需再分解。
- 歧义检查：「复审只验证 findings 关闭」已明确为非全量重评；
  judge off 为保守默认值已明确；L1/L2 门槛数字已明确。
