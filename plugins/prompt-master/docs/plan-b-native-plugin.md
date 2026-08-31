# 方案 B：DSH 原生插件重构（正式 Spec）

> 版本：v1.1 · 状态：**已定稿（已按本机 DSH 0.1.1-rc.2 实测核验修订，修订记录见文末 §10）**
> ⚠️ **已被取代**：`docs/2026-08-27-native-plugin-design.md`（正式设计 Spec v1.0，2026-08-27）取代本文档作为实施蓝图；本文档保留作历史决策记录。
> 路径：Architectural（brainstorming 流程）
> 约定：本项目非 git 仓库，跳过设计中"commit to git"步骤（用户偏好：文档统一放 `docs/`）
> 参照目标：DeepSeek Harness 0.1.1-rc.2（本机 `@deepseek-ai/dsh` 全家桶，含 cordis 4.x / dsh-tools / dsh-llm / dsh-attachment / dsh-settings / dsh-agent / dsh-session）
> 已定决策：D1 跟随 agent 路由 · D2 ctx.settings 存自定义 profile · D3 本期做图片反推 · D4 不做 history · D5 仓库内重组 · D6 保留 minimax
> 实施批次：**一次性 P0→P4 全做完**（已确认）

## 1. 目标与原则

把「提示词大师」的 **PE 引擎**（扩写/反推/MiniMax H3 场景）从自建 MCP Server 重构为 **DSH 原生 Cordis 插件**：

| 原则 | 含义 |
|---|---|
| 模型调用全交给 DSH | 不再自写 HTTP client/provider 路由/API key 管理，用 `ctx.llm.stream()` |
| 工具注册全交给 DSH | 用 `ctx.tools.register(defineTool(...))`，工具名直接进系统提示词装配 |
| 运行/会话/历史全交给 DSH | 不再自跑 MCP server 进程；DSH agent loop + session log 承担执行与历史 |
| PE 引擎 1:1 保留 | `src/resolver/**`（纯函数、无 Electron、无 provider 依赖）原样迁移 |
| 不再有 MCP 形态 | 删除 `@modelcontextprotocol/sdk` 依赖与 stdio/SSE 入口 |

## 2. 目标架构

```
DSH Agent Runtime（ctx.agentLoop）
   │  模型请求 → ctx.llm.stream（DeepSeek adapter，Settings→Models 里配 key）
   ▼
ctx.tools 注册表  ── 工具：prompt_expand / prompt_reverse / minimax_scenario / profile_list
   ▲
prompt-master-dsh 插件（cordis plugin: name / inject / apply / Config）
   ├─ src/plugin/index.ts   插件入口（注册 4 个工具 + 生命周期）
   ├─ src/plugin/config.ts  schemastery Config（默认 provider/model、temperature）
   ├─ src/tools/*.ts        defineTool 定义：参数 → resolver 组装 → ctx.llm 调用 → sanitize → 返回
   ├─ src/llm/complete.ts   封装「一次性 completion」：stream + BlockAssembler → {text, usage}
   └─ src/resolver/**       1:1 迁移的 PE 引擎（不改）
```

**删除的层（不再存在）：** `src/index.ts`（MCP 入口）、`src/tools/*` 的旧 handler 包装、`src/provider/*`（client/models/index）、`src/db/*`（SQLite）、`src/config/*`、`.env`/`config.yaml`。

## 3. 模块映射表

| 现文件 | 处置 | 去向/说明 |
|---|---|---|
| `src/resolver/**`（index/types/renderer/taxonomy/profiles/minimax） | **1:1 保留** | 纯函数引擎，无任何外部依赖；原样复制进插件包 |
| `src/tools/prompt-expand.ts` 的 handler | **重写** | 变 `defineTool` 工具；`resolveProvider(...)` 改为 `ctx.llm.stream`；`recordHistory` 删除（DSH session log 承担） |
| `src/tools/prompt-reverse.ts` | **重写** | 同上；保留 `sanitizeFinalCaption` 清洗链（纯函数，继续用） |
| `src/tools/minimax-scenario.ts` | **重写** | 保留 dry_run/budget 审计逻辑；LLM 调用改 ctx.llm |
| `src/tools/profile-list.ts` | **重写** | 变为 `profile_list` 工具（list/save/delete，运行时组合的全部内置+自定义 profile 与 taxonomy，不硬编码数量）；自定义 profile 持久化改用 `ctx.settings`（见 §7 决策点） |
| `src/tools/provider-config.ts` | **删除** | provider/API key 由 DSH Settings→Models 管理，不再自建 |
| `src/provider/*` | **删除** | 换 `ctx.llm` |
| `src/db/*` | **删除** | API key → DSH credentials；history → DSH session log；provider_cache → 无；custom_profiles → ctx.settings 或放弃 |
| `src/config/*`、`.env.example`、`config.yaml.example` | **删除** | 插件 Config（schemastery）承担最小化配置 |
| `src/index.ts` | **删除** | 无 MCP server 进程 |
| `src/utils/length.ts` | **保留** | countChars 用于 minimax budget 审计；estimateTokens 可留作参考 |
| `tests/` | **处置见 §3.2** | 见测试资产处置表 |

### 3.1 resolver↔db 隐藏耦合处置（关键）

`src/resolver/profiles/index.ts` 是 resolver 引擎里**唯一** import DB 的文件（`listCustomProfiles`，经 grep 确认）。删 `src/db/*` 前必须先解除该耦合：

- `safeListCustomProfiles()` 改为模块级**可注入的 profile 源**：插件 `apply` 时注册一个读取器（从 `ctx.settings` 命名空间读自定义 profile JSON 数组）；未注入时返回 `[]`（与现状 DB 不可用时的 try/catch 行为一致，resolver 测试不受影响）。
- `clearProfileCache()` 语义保留：settings 变更后由 `profile_list` 工具调用。
- 文件分工：`src/resolver/profiles/index.ts` 只保留"源注入"契约 + 内置 profile 组合；源的具体实现（settings 读写）放工具层。

### 3.2 测试资产处置

| 文件 | 处置 | 理由 |
|---|---|---|
| `tests/resolver/{expand,reverse,length,tagLineSanitize}.test.ts`、`tests/fixtures/test-data.ts` | ✅ 保留 | 纯函数引擎测试，零 db/provider 依赖（已核验 import） |
| `tests/tools/handlers.test.ts` | ❌ 删除 | 被测的 MCP handler 层消失 |
| `tests/smoke.test.ts`、`tests/save-key.test.ts` | ❌ 删除 | 依赖 db 初始化 + 旧 handler |
| `tests/provider/client.test.ts` | ❌ 删除 | provider 层删除 |
| **新增** `tests/plugin/*.test.ts` | 🆕 新增 | cordis ctx **stub**（见下） |

**插件级测试设计（不 spin 真 DSH 即可跑）：**
- mock `ctx.tools.register`：收集注册的 ToolDefinition，断言名称/参数 schema/output schema 与 spec 一致；
- mock `ctx.llm.stream`：接受 `GenerateOptions`，喂固定 `StreamChunk` 序列（text-delta→block-end→usage→finish），断言工具把 `system`/`user`/`maxTokens` 正确传给了 LLM 请求；
- 断言 `sanitizeFinalCaption` 在 LLM 返回后被调用（reverse 路径）；
- 图片反推：mock `exec.agent.session.events` 含 `user/message` 事件（带 `image` block），断言工具把 `ImageAttachmentRef` 原样带进 `ctx.llm.stream` 的 messages；
- dry_run：断言不触发 LLM 调用。

## 4. 工具定义清单（defineTool）

统一输出约定：`output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }`。返回分两类：**纯文本类**（prompt_expand / prompt_reverse）直接回传正文 string；**结构化类**（minimax_scenario / profile_list）回传 JSON 字符串。**usage 一律不进返回文本**——DSH session log 已承担 token 记账，避免模型看到自身用量污染上下文。

| 工具名 | 参数 | 内部流程 | 返回 |
|---|---|---|---|
| `prompt_expand` | `text`(必), `profile`=pe_expand_natural, `output_lang`=zh, `length`=medium, `extra_prompt`='', `dry_run`=false | `resolveExpand(profile, params)` → 若 dry_run 直接返回 `{text: user, debug}`；否则 `ctx.llm.stream` 用组装好的 system/user 生成 → 返回扩写正文 | string |
| `prompt_reverse` | `image_description`(必), `profile`, `output_lang`, `length`, `extra_prompt`, `anima3_enhance` | `resolveReverse` 组装 → `ctx.llm.stream` → **`sanitizeFinalCaption`** 清洗 → 返回 | string（反推正文） |
| `minimax_scenario` | `scenario_id`(必), `form_fields`(对象), `output_lang`, `dry_run` | `resolveMinimaxScenarioExpand` 组装 → dry_run 直接返回；否则 LLM → 返回 prompt + sections + budget 审计 | JSON 字符串（{prompt, sections, budget}） |
| `profile_list` | `action`=list(默认)\|save\|delete, `kind`, `query`, `payload`(save 时) | list：查询全部内置+自定义 profile（运行时组合，数量随引擎演进，不硬编码）+ taxonomy，无 LLM；save/delete：写 `ctx.settings` 自定义 profile 命名空间（见 §7.2），写后调 `clearProfileCache()` | JSON 字符串 |

**provider/model 解析顺序（工具内）：**
```ts
const routed = exec.agent?.session.requestHeader()?.config      // 本轮会话所选 route
const provider = routed?.provider ?? exec.agent?.options.provider ?? config.defaultProvider ?? 'deepseek'
const model     = routed?.model    ?? exec.agent?.options.model    ?? config.defaultModel    ?? 'deepseek-chat'
```
（参考 `dsh-mcp-client` 的 `resolveImageAdmission` 取 route 方式；`exec.agent` 可能为空 → 全部回落到 `config`。）

## 5. LLM 调用封装（核心替换点）

新建 `src/llm/complete.ts`，一次性非流式 completion：

```ts
import { BlockAssembler, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

export interface CompleteOptions {
  provider: string
  model: string
  system: string
  user: string
  maxTokens: number
  temperature?: number
  signal: AbortSignal
}

export async function complete(ctx: Context, opts: CompleteOptions) {
  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({
    provider: opts.provider,
    model: opts.model,
    system: opts.system,
    messages: [createUserMessage({
      content: [{ type: 'text', text: opts.user }],
      source: { kind: 'plugin', plugin: 'prompt-master-dsh' },
    })],
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
  })
  for await (const chunk of stream) assembler.push(chunk)
  const text = assembler.blocks().filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text.trim()).join('\n')
  return { text, usage: assembler.usage, finish: assembler.finish }
}
```

- 失败路径：stream 以 `finish {kind:'error'|'aborted'}` 结束 → 抛错（保留 `LlmFailure.message/code`）；工具自动走 `isError`（模型看到失败原因，不崩溃）。
- 视觉能力校验失败（图片反推）：工具报错文案明确指引「Settings→Models 切换到支持图片输入的模型」。
- `exec.agent` 缺失（非 agent 上下文）：完整回落链已设计（agent route → config → 内置默认）。
- 取消：`exec.signal` 透传给 `GenerateOptions.signal`。
- usage：`assembler.usage`（inputTokens/outputTokens）**仅用于 minimax_scenario 的 budget 审计**（按 §4 契约返回在 JSON 字符串内）；prompt_expand / prompt_reverse 不回传 usage。

## 5.1 版本策略

依赖关系如下，peer 钉同版本，跟随 DSH 升级回归：

| 包 | 角色 | 版本 |
|---|---|---|
| `@deepseek-ai/cordis` | 插件框架（Context/inject/effect） | peer `^4.0.1`（本机 4.0.1） |
| `@deepseek-ai/dsh-tools` | `defineTool`/`ctx.tools.register` | peer `^0.1.1-rc.2` |
| `@deepseek-ai/dsh-llm` | `ctx.llm.stream`/`BlockAssembler`/`createUserMessage` | peer `^0.1.1-rc.2` |
| `@deepseek-ai/dsh-attachment` | 图片读取/准入（D3） | peer `^0.1.1-rc.2` |
| `@deepseek-ai/dsh-agent` | `Agent` 类型（exec.agent） | dev/type-only |
| `@deepseek-ai/dsh-session` | `Session.events`/`UserMessage` 类型（D3） | dev/type-only |
| `@deepseek-ai/dsh-settings` | `ctx.settings` 命名空间（D2） | peer `^0.1.1-rc.2` |
| `@deepseek-ai/schemastery` | 插件 Config / settings schema | peer `^3.18.1` |

## 6. 插件骨架与挂载

`src/plugin/index.ts`（参考 dsh-mcp-client 的 `name/inject/apply/Config` 模式）：

```ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { registerExpandTool } from '../tools/prompt-expand.js'
// ...

export const name = 'prompt-master'
export const inject = ['tools', 'llm']
export const Config = z.object({
  defaultProvider: z.string().default('deepseek'),
  defaultModel: z.string().default('deepseek-chat'),
  temperature: z.number().default(0.7),
})

export function apply(ctx: Context, config: Config) {
  for (const register of [registerExpandTool, registerReverseTool, registerMinimaxTool, registerProfileListTool]) {
    ctx.effect(() => {
      const disposers: (() => void)[] = []
      disposers.push(ctx.tools.register(register(ctx, config)))
      return () => { for (const d of disposers) d() }
    }, 'prompt-master.tools')
  }
}
```

**挂载进 DSH（本机 `~/.dsh/cordis.patch.yml`）：**
```yaml
- insert:
    - id: prompt-master
      name: '@prompt-master/dsh-plugin'     # 或本地路径 / workspace link
      config:
        defaultProvider: deepseek
        defaultModel: deepseek-chat
```
工具以 `prompt_expand` 等原生名出现在模型面前（不像 mcp-client 的 `mcp__xxx__` 长名）。

**开发循环（已核验 dsh CLI）：**
1. `dsh plugin --profile web add <本地包路径>`（转发 pnpm，把插件装进 profile）
2. `~/.dsh/cordis.patch.yml` 里 insert 引用该包名
3. 改 `cordis.patch.yml` / settings → HMR 热重载；改插件源码 → rebuild 后 DSH 重启生效

## 7. 已定决策（2025 确认）

| # | 决策 | 定案 |
|---|---|---|
| D1 | provider/model 来源 | **跟随当前 agent 路由**（`exec.agent.options` -> config 回落链） |
| D2 | 自定义 Profile | **用 `ctx.settings` 保存**（DSH per-namespace settings，注册 `prompt-master` 命名空间 schema，存自定义 profile 的 JSON） |
| D3 | 图片输入反推 | **本期就做图片附件模式**（详见 §7.1） |
| D4 | history | 不做，DSH session log 承担 |
| D5 | 项目形态 | 仓库内重组为单插件包，保留仓库与 tests |
| D6 | minimax_scenario | 保留 |

### 7.1 D3 图片反推实现（已核验 DSH 机制）

`defineTool` 参数 schema **没有 image 类型**，因此图片走「会话附件」而非参数：

```
用户 Web UI 贴图 → user message 带 image block（ImageBlock.attachment: ImageAttachmentRef，已在 session log）
   │
prompt_reverse 工具 execute:
   ├─ 1. exec.agent.session.events 反向找最近的 'user/message' 事件
   ├─ 2. 取其中最后一个 type:'image' block（原 ImageAttachmentRef，无需 readImage）
   ├─ 3. aws 模型能力：llm.resolveModelInfo(provider, model) → inputModalities 含 'image'，
   │       否则报错引导换视觉模型（如 DeepSeek-VL / 硅基流动 Qwen-VL）
   ├─ 4. ctx.llm.stream messages = [image block + 文本描述]（复用原 block，adapter 自己读附件）
   └─ 5. 返回 sanitizeFinalCaption 后的反推结果
```

- 工具参数保持 `image_description`（文本）**+ 自动检测会话最近图片**：两者至少其一必须存在，都有时以图片为准。
- DSH DeepSeek 适配器已有 `inputModalities`/`imagePixelBudget`/`maxImagesPerRequest` 图片请求管线（已核验 `dsh-llm-deepseek` adapter.d.ts），无需自研。
- 风险：主模型（deepseek-chat）不支持视觉时反推会被拒 → 工具报错信息明确告知"需在 Web UI Settings→Models 切换到支持图片输入的模型"。会话粒度（exec.agent 跟随 route）天然解决了"不同会话用不同模型"。

### 7.2 D2 ctx.settings 用法（已核验 dsh-settings 0.1.1-rc.2 签名）

```ts
import { settingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
// 插件 apply 内注册命名空间（注册是插件 fiber 上的 effect，卸载自动移除）：
const ns = settingsNamespace('prompt-master')
const scope: SettingsScope<{ customProfiles: Record<string, string> }> =
  ctx.settings.register(ns, z.object({ customProfiles: z.record(z.string(), z.string()).default({}) }))
// 工具内读写：
const current = scope.get()                                  // 读合并值（defaults→base→user）
await scope.update({ customProfiles: { ...current.customProfiles, [id]: json } })  // 合并写入并持久化
await scope.replace({ customProfiles: {} })                  // 整段重置（删除全部）
```
`profile_list` 工具的 save/delete 动作（见 §4 工具表 `action` 参数）走这个 scope，替代原 SQLite custom_profiles 表；写入后调用 `clearProfileCache()` 让 resolver 注入源重新读取。**可选增强**：用 `installSettingsSection(ctx, ns, schema, entry, hooks)`（dsh-settings 提供）把该命名空间挂到 Web UI Settings 页，自定义 profile 可在设置界面直接编辑；不挂接也不影响工具层读写。

## 8. 分阶段实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 骨架 | 建 `src/plugin`、`config.ts`、依赖声明（cordis 4.x / dsh-tools / dsh-llm / dsh-settings 为 peer）；tsc 通过；**收尾补一步最小链路验证**：写一个 10 行的 hello 工具插件 → `dsh plugin --profile web add <本地路径>` → `cordis.patch.yml` insert → 重启 Web UI 确认工具出现（把"本地包 patch 解析"这一最大外部不确定性提前消除；若解析不到，插件声明 `dsh.bundle.patch` 即成为 profile layer，机制已核验） | 编译零错误 + hello 工具出现在 Web UI |
| P1 最小闭环 | 只注册 `prompt_expand`（含 dry_run），挂进本地 `cordis.patch.yml`，重启 Web UI | Web UI 会话里能看到并调用 `prompt_expand`，无 MCP 名 |
| P2 全量工具 | reverse（文本+图片附件、sanitize 链）、minimax（含 budget）、profile_list（含 ctx.settings 自定义 profile）；`ctx.llm` 真实调用 | 4 工具全部可用；usage 正确返回 |
| P3 清理 | 删 provider/db/config/MCP 入口与依赖；resolver 测试保留并通过 | 依赖树只剩引擎 + DSH 全家桶；`npm test` 通过 |
| P4 图片反推联调 | 视觉模型 route 校验、image block 复用、错误引导文案；Web UI 实际贴图反推 | 贴图 → prompt_reverse 返回反推结果 |

## 9. 风险

1. **DSH 是 RC（README 明示会有 breaking changes）**：插件把 `@deepseek-ai/{cordis,dsh-tools,dsh-llm}` 声明为 peerDependencies，升级 DSH 时需回归。
2. **`exec.agent` 可能为空**（非 agent 上下文调用）：完整回落链已设计（agent route → config → 内置默认）。
3. **`ValueSchemaSpec` 是受限 JSON-Schema 子集**：我们的参数都是 string/number/boolean + 一个对象（form_fields），全在子集内，无风险。
4. **错误路径**：`ctx.llm.stream` 的 `finish error/aborted` 需转抛，避免工具"成功返回空字符串"。
5. **custom_profiles 与 provider_config 被裁剪**：功能上有损失，但符合"不自己写逻辑"的目标——provider 配置本来就该归 DSH Settings。
6. **一次性 P0→P4 全做完的验证集中风险**：已缓解（P0 收尾增补极简 hello 插件挂载验证，挂载链路风险提前消除）。若 DSH 环境后续出问题定位面仍较大。缓解：P1/P2 有 tsc + 插件级 stub 测试闸门，resolver 测试全程兜底引擎正确性。
7. **settings 命名空间唯一性**：`prompt-master` 命名空间若与未来其他插件冲突，register 会 fail loud（DSH 语义），起名加上前缀规避（如 `prompt-master-custom-profiles` 独立命名）。

## 10. v1.1 修订记录（2026-08-27，经本机实测核验）

对照本机 `@deepseek-ai/dsh` 0.1.1-rc.2 全家桶（dsh-llm / dsh-tools / dsh-settings / dsh-agent / dsh-session / cordis 4.0.1 / schemastery 3.18.1 / dsh-mcp-client）源码逐条核验后修订：

- **修正（笔误·会编译失败）**：§6 `import { z }` → 改为 **默认导入** `import z from '@deepseek-ai/schemastery'`（schemastery 3.18.1 仅 `export default Schema`，dsh-tools / dsh-settings / dsh-mcp-client 均为默认导入）。
- **修正（笔误·会装错包）**：§5.1 cordis peer 版本 `^0.4.1` → `^4.0.1`（本机实际 4.0.1；`^0.4.1` 不存在）。
- **修正（输出契约）**：§4 输出统一为「纯文本类 string / 结构化类 JSON 字符串」；**usage 不进返回文本**（仅 minimax budget 审计保留在 JSON 内，其余工具不回传；DSH session log 记账，避免污染模型上下文）；`profile_list` 定稿为 `action`=list|save|delete；去掉「56 个 profile」硬编码，改为运行时组合描述（8 expand + mirror + 3 reverse + 10 torii + 12 train + 10 minimax，随引擎演进）。同步修正 §3 模块映射表 profile_list 行与 §5 usage 说明。
- **增强（风险前置）**：§8 P0 增补最小 hello 插件挂载验证——「本地路径插件包 → `dsh plugin add` → `cordis.patch.yml` insert → Web UI 可见工具」是本设计唯一未实证的外部链路，提前到 P0 消除；已核验兜底机制：插件声明 `dsh.bundle.patch` 即成 profile layer（`dsh plugin` 命令 reconcilePlugins 语义）。
- **确认（核验通过，无需改动）**：`ctx.llm.stream` / `BlockAssembler` / `createUserMessage` / `MessageSource.plugin`；`ctx.tools.register` / `defineTool` / `exec.agent·signal`；`ctx.settings.register→SettingsScope.get/update/replace`；路由回落链与 dsh-mcp-client `resolveImageAdmission` 逐字一致；D3 全链路（`Session.events` 的 `'user/message'` 事件 + `ImageBlock` + DeepSeek 视觉模型 `deepseek-v4-flash-vision-exp`）；cordis `ctx.effect(fn, label)`；resolver↔db 唯一耦合（`profiles/index.ts:16`）与 try/catch 语义；老测试的保留/删除分类——全部与设计原稿一致。