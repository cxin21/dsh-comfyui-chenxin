# 「提示词大师」DSH 原生插件重构 · 设计文档（正式 Spec）

> 版本：v1.0 · 日期：2026-08-27 · 状态：**已定稿**
> 路径：Architectural（brainstorming → spec → writing-plans）
> 取代：`docs/plan-b-native-plugin.md`（v1.1，保留为历史决策记录）
> 依据：本机 `@deepseek-ai/dsh` 0.1.1-rc.2 全家桶实测核验（cordis 4.0.1 / dsh-llm / dsh-tools / dsh-settings / dsh-agent / dsh-session / schemastery 3.18.1 / dsh-mcp-client）

## 1. 概述

### 1.1 目标

把「提示词大师」的 PE 引擎（扩写 / 反推 / MiniMax H3 场景）从自建 MCP Server 重构为 **DSH 原生 Cordis 插件**，一次完成 P0→P4：

| 原则 | 含义 |
|---|---|
| 模型调用全交给 DSH | 不再自写 HTTP client / provider 路由 / API key 管理，用 `ctx.llm.stream()` |
| 工具注册全交给 DSH | 用 `ctx.tools.register(defineTool(...))`，工具以原生名进系统提示词装配 |
| 运行/会话/历史全交给 DSH | 不再自跑 MCP server 进程；agent loop + session log 承担执行与历史 |
| PE 引擎 1:1 保留 | `src/resolver/**`（纯函数）原样迁移，**零裁剪**（见 §2 能力保全清单） |
| 不再有 MCP 形态 | 删除 `@modelcontextprotocol/sdk` 依赖与 stdio/SSE 入口 |

### 1.2 非目标

- 不做 MCP 形态、不写 provider / API key / HTTP client / SQLite / history
- 不做通用提示词平台（多用户、插件市场、云端同步）
- 不迁移 `tests/` 中的 db / provider / handler 测试（删除，见 §10）

### 1.3 已定决策（D1–D6，追溯记录见 §13）

D1 跟随 agent 路由 · D2 ctx.settings 存自定义 profile · D3 本期做图片反推 · D4 不做 history · D5 仓库内重组 · D6 保留 minimax。

## 2. 能力保全清单（硬约束，缺一项即失败）

> 用户明确要求：**保留完整的扩写、生成提示词能力，零裁剪**。以下每一项必须在本设计中可触达、可验收。

| 能力域 | 内容 |
|---|---|
| 扩写（expand） | 8 种 EXPAND_RULES（含 natural/其余 7 种）+ expand-mirror 镜像生成 profile + 语言/长度/extra_prompt 处理链（`applyExpandLength` / `applyUserExtraPrompt` / `applyOutputLanguage`） |
| 生成提示词（反推） | 3 内置反推（Descriptive / SD / Danbooru）+ 10 Torii + ComfyUI / Anima3 / Prose 专属路由 + 长度控制（`resolveCaptionMaxNewTokens`）+ `sanitizeFinalCaption` 清洗链（`tagLineSanitize`） |
| MiniMax H3 生成 | 10 个场景（catalog）+ `assemble.ts`（dry_run / budget 审计）+ h3-reference 三语模板（en/ja/zh）+ 空 `scenario_id` 时返回场景列表 |
| 训练 | 12 个 train profile |
| 基础设施 | taxonomy 标签（`REVERSE_TAGS` / `ALL_SUBJECT_DOMAIN_IDS` / `enrichProfileTaxonomy`）+ renderer 模板解析 + `countChars` / `estimateTokens` |

**保全验收**：迁移后 `getDefaultBuiltinProfiles()` 输出与迁移前逐项一致（唯一差异：自定义 profile 来源 SQLite → settings 注入）；全部 resolver 测试原样通过；上述每个能力仍被至少一个工具触达。

## 3. 目标架构与模块划分

```
DSH Agent Runtime（ctx.agentLoop）
   │  模型请求 → ctx.llm.stream（provider/model 由会话路由决定）
   ▼
ctx.tools 注册表  ── 工具：prompt_expand / prompt_reverse / minimax_scenario / profile_list
   ▲
prompt-master 插件（cordis plugin: name / inject / apply / Config）
   ├─ src/plugin/index.ts   插件入口（注册 4 工具 + settings 命名空间 + 注入自定义 profile 源）
   ├─ src/plugin/config.ts  schemastery Config（defaultProvider / defaultModel / temperature）
   ├─ src/tools/*.ts        defineTool 定义：参数 → resolver 组装 → ctx.llm 调用 → sanitize/审计 → 返回
   ├─ src/llm/complete.ts   封装「一次性 completion」：stream + BlockAssembler → {text, usage, finish}
   └─ src/resolver/**       1:1 迁移的 PE 引擎（仅 profiles/index.ts 的 DB 耦合改可注入源）
tests/
   ├─ plugin/*.test.ts      新增：cordis ctx stub（不 spin 真 DSH）
   ├─ resolver/*.test.ts    保留：纯函数引擎测试（能力保全闸门）
   └─ fixtures/test-data.ts 保留
```

**删除的层**：`src/index.ts`（MCP 入口）、`src/provider/*`、`src/db/*`、`src/config/*`、`src/tools/provider-config.ts`、`.env` / `config.yaml`。

### 3.1 模块职责（做什么 / 怎么用 / 依赖什么）

| 单元 | 做什么 | 依赖 |
|---|---|---|
| `plugin/index.ts` | apply 时注册 4 工具、注册 settings 命名空间、注入自定义 profile 源；卸载自动清理 | tools/*、resolver、ctx.settings |
| `plugin/config.ts` | Config schema：`defaultProvider='deepseek'`、`defaultModel='deepseek-chat'`、`temperature=0.7` | schemastery |
| `tools/*.ts` | 薄层无状态：参数校验 → resolver 组装 → ctx.llm → sanitize/审计 → 按 §6 契约返回 | resolver、llm/complete |
| `llm/complete.ts` | 一次性 completion：组装 messages → stream → BlockAssembler → {text, usage, finish}；error/aborted 转抛 | dsh-llm |
| `resolver/**` | 纯函数引擎，零 DSH 依赖；唯一注入点 = 自定义 profile 源（未注入返回 `[]`） | 无 |

### 3.2 resolver↔db 隐藏耦合处置

`src/resolver/profiles/index.ts:16` 是 resolver 引擎唯一 import DB 的文件（`listCustomProfiles`，已核验）：

- `safeListCustomProfiles()` 改为模块级**可注入的 profile 源**：插件 `apply` 时注册读取器（从 `ctx.settings` 命名空间读自定义 profile JSON 数组）；未注入返回 `[]`（与现状 DB 不可用时的 try/catch 行为一致，resolver 测试不受影响）。
- `clearProfileCache()` 语义保留：settings 变更后由 `profile_list` 工具调用。
- `src/resolver/profiles/index.ts` 只保留「源注入」契约 + 内置 profile 组合；源实现（settings 读写）放工具层。

## 4. 依赖与版本策略

peer 钉同版本，跟随 DSH 升级回归：

| 包 | 角色 | 版本 |
|---|---|---|
| `@deepseek-ai/cordis` | 插件框架（Context/inject/effect） | peer `^4.0.1`（本机 4.0.1） |
| `@deepseek-ai/dsh-tools` | `defineTool` / `ctx.tools.register` | peer `^0.1.1-rc.2` |
| `@deepseek-ai/dsh-llm` | `ctx.llm.stream` / `BlockAssembler` / `createUserMessage` | peer `^0.1.1-rc.2` |
| `@deepseek-ai/dsh-attachment` | 图片引用类型（D3，type-only 为主） | peer `^0.1.1-rc.2` |
| `@deepseek-ai/dsh-settings` | `ctx.settings` 命名空间（D2） | peer `^0.1.1-rc.2` |
| `@deepseek-ai/schemastery` | 插件 Config / settings schema | peer `^3.18.1` |
| `@deepseek-ai/dsh-agent` / `dsh-session` | `Agent` / `Session` 类型（exec.agent / D3） | dev + type-only |

## 5. 核心封装：路由解析与 LLM 调用

### 5.1 provider/model 解析顺序（工具内，与 dsh-mcp-client `resolveImageAdmission` 逐字一致）

```ts
const routed = exec.agent?.session.requestHeader()?.config      // 本轮会话所选 route
const provider = routed?.provider ?? exec.agent?.options.provider ?? config.defaultProvider ?? 'deepseek'
const model     = routed?.model    ?? exec.agent?.options.model    ?? config.defaultModel    ?? 'deepseek-chat'
```

`exec.agent` 可能为空（非 agent 上下文）→ 全部回落到 `config`。

### 5.2 `src/llm/complete.ts`（核心替换点）

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
      source: { kind: 'plugin', plugin: 'prompt-master' },
    })],
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
  })
  for await (const chunk of stream) assembler.push(chunk)
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    throw new Error(assembler.finish.failure.message)   // 保留 failure.code 用于诊断
  }
  const text = assembler.blocks().filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text.trim()).join('\n')
  return { text, usage: assembler.usage, finish: assembler.finish }
}
```

- 视觉能力校验（图片反推）：`llm.resolveModelInfo(provider, model)` → `inputModalities` 含 `'image'`，否则工具报错引导「Settings→Models 切换到支持图片输入的模型」。
- 取消：`exec.signal` 透传 `GenerateOptions.signal`。
- usage：仅 `minimax_scenario` 的 budget 审计使用（见 §6）；expand / reverse 不回传。

## 6. 工具契约（defineTool）

统一输出约定：`output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }`。返回分两类：**纯文本类**（prompt_expand / prompt_reverse）回传正文 string；**结构化类**（minimax_scenario / profile_list）回传 JSON 字符串。**usage 一律不进返回文本**（session log 已记账；minimax budget 审计除外）。

> 契约校正（相对源码/plan-b 表格）：① profile_list 的 `action` 全集为源码既有 **list|search|get|save|delete**（保全能力，不止 list/save/delete）；② prompt_expand 默认 `profile` 修正为 `pe_expand_natural`（源码写 `expand_natural` 会在 findProfileById 中查不到，属 bug）；③ prompt_reverse 补齐 plan-b 表格漏列的 `quality_prompt_enabled` / `quality_prompt_prefix`。

| 工具名 | 参数 | 内部流程 | 返回 |
|---|---|---|---|
| `prompt_expand` | `text`(必), `profile`=`pe_expand_natural`, `output_lang`=`zh`, `length`=`medium`, `extra_prompt`=`''`, `dry_run`=`false` | `resolveExpand(profile, {outputLang, expandLen, userExtraPrompt, shortText})` → 若 dry_run 直接返回 `{system, user, maxTokens}`（JSON 字符串 + profile_meta）；否则 `complete()` → 返回扩写正文 | string |
| `prompt_reverse` | `image_description`(必), `profile`=`pe_reverse_descriptive`, `output_lang`=`zh`, `length`=`medium`, `extra_prompt`=`''`, `anima3_enhance`=`false`, `quality_prompt_enabled`=`false`, `quality_prompt_prefix`=`''` | `resolveReverse(profile, {caption_lang, len, media_target:'image', extra_prompt, anima3_enhance})` → system + user（userLead/userBody/outputConstraints/userTail 拼接；空则用 image_description）→ 会话最近图片附件并入 messages（见 §7.2）→ `complete()`（maxTokens=512，与源码一致）→ **`sanitizeFinalCaption`** 清洗 → 返回 | string（反推正文） |
| `minimax_scenario` | `scenario_id`(必，空则返回场景列表), `form_fields`(对象), `output_lang`=`zh`, `dry_run`=`false` | 空 id → 场景列表；否则 `resolveMinimaxScenarioExpand` 组装 → dry_run 不调 LLM；否则 `complete()` → `splitSections`（full_reference 六段：主体定义/摘要/保留分析/详细描述/整体声景/非叙事配乐）→ budget 审计（按 stage：t2va=1200 / i2va=1500 / fl2va=1700 / l2va=1700 / ref2va=2400 tokens，字符上限 7000；`pickStage` 按 outputMode/scenarioId 推断） | JSON 字符串 `{prompt, sections, scenario, budget, dry_run?}` |
| `profile_list` | `action`=`list`(默认)\|search\|get\|save\|delete, `kind`, `query`, `id`, `profile`(save 时对象) | list/search：组合内置+自定义 profile（精简字段）+ taxonomy，无 LLM；get：custom 优先再 builtin；save：`{...profile, id, builtin:false}` 写 settings 命名空间；delete：内置不可删；写后调 `clearProfileCache()` | JSON 字符串 |

## 7. 数据流

### 7.1 通用路由与 LLM 调用流

工具 execute → §5.1 解析 provider/model → §5.2 `complete()` → 组装 messages（`source: {kind:'plugin', plugin:'prompt-master'}`）→ `ctx.llm.stream` → BlockAssembler → 文本提取/清洗 → 按契约返回。错误走 §8。

### 7.2 图片反推流（D3）

```
Web UI 贴图 → user message 带 image block（ImageBlock.attachment: ImageAttachmentRef，已在 session log）
   │
prompt_reverse execute:
   ├─ 1. exec.agent.session.events 反向找最近的 'user/message' 事件
   ├─ 2. 取其中最后一个 type:'image' block（原 ImageAttachmentRef，复用，无需 readImage）
   ├─ 3. llm.resolveModelInfo(provider, model) → inputModalities 含 'image'，否则报错引导换视觉模型
   ├─ 4. messages = [image block + 文本描述]（复用原 block，adapter 自己读附件）
   └─ 5. complete() → sanitizeFinalCaption → 返回
```

`image_description`（文本）与会话最近图片至少其一必须存在；都有时以图片为准。

### 7.3 settings 自定义 profile 流（D2）

```ts
import { settingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
// 插件 apply 内注册命名空间（注册是 fiber 上的 effect，卸载自动移除）：
const ns = settingsNamespace('prompt-master-custom-profiles')   // 独立命名，规避冲突 fail loud
const scope: SettingsScope<{ customProfiles: Record<string, string> }> =
  ctx.settings.register(ns, z.object({ customProfiles: z.dict(z.string(), z.string()).default({}) }))
// 工具内：读合并值 / 合并写入 / 整段重置
const current = scope.get()
await scope.update({ customProfiles: { ...current.customProfiles, [id]: json } })
await scope.replace({ customProfiles: {} })
```

`profile_list` 的 save/delete 走此 scope；写后调 `clearProfileCache()` 让 resolver 注入源重新读取。

**可选增强**：用 `installSettingsSection(ctx, ns, schema, entry, hooks)`（dsh-settings 提供）把该命名空间挂到 Web UI Settings 页，自定义 profile 可在设置界面编辑；不挂接不影响工具层读写。

## 8. 错误处理与边界

| 场景 | 处理 |
|---|---|
| LLM 失败（finish error/aborted） | `complete()` 转抛（保留 `failure.message/code`）；工具 execute 自然失败走 isError，模型看到失败原因，不崩溃 |
| 视觉能力不支持（图片反推） | 报错文案明确指引「Settings→Models 切换到支持图片输入的模型」；会话粒度跟 route，天然支持不同会话不同模型 |
| `exec.agent` 缺失（非 agent 上下文） | §§5.1 回落链 → config 默认 |
| settings 命名空间冲突 | register fail loud（DSH 语义）；用独立命名 `prompt-master-custom-profiles` 规避 |
| 参数错误 / profile 不存在 | defineTool schema 校验；`profile_not_found` / `scenario_not_found` 等结构化错误 |
| 取消 | `exec.signal` 透传 `GenerateOptions.signal`；模型切换/工具中断正常响应 |
| ValueSchemaSpec 子集 | 参数均为 string/number/boolean + 对象（form_fields / profile），全在子集内 |

## 9. 插件骨架与挂载

### 9.1 `src/plugin/index.ts`

```ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { registerExpandTool } from '../tools/prompt-expand.js'
// ... registerReverseTool / registerMinimaxTool / registerProfileListTool

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
  // D2：注册 settings 命名空间 + 注入 resolver 自定义 profile 源（§7.3）
}
```

### 9.2 挂载（本机 `~/.dsh/cordis.patch.yml`）

```yaml
- insert:
    - id: prompt-master
      name: '@prompt-master/dsh-plugin'     # pnpm 安装后的真实包名
      config:
        defaultProvider: deepseek
        defaultModel: deepseek-chat
```

**开发循环**：
1. `dsh plugin --profile web add <本地包路径>`（转发 pnpm，装进 profile）
2. `~/.dsh/cordis.patch.yml` insert 引用该包名
3. 改 `cordis.patch.yml` / settings → HMR 热重载；改插件源码 → rebuild 后 DSH 重启生效

**挂载兜底（已核验）**：若 patch insert 无法解析本地安装包，插件在 `package.json` 声明 `dsh.bundle.patch` 即成为 profile layer（`dsh plugin` 命令的 reconcilePlugins 语义），自动加入 bundles 层。P0 将以 hello 插件实证该链路（§11）。

## 10. 测试设计

| 层 | 文件 | 内容 |
|---|---|---|
| resolver 纯函数（保留） | `tests/resolver/{expand,reverse,length,tagLineSanitize}.test.ts` + `tests/fixtures/test-data.ts` | 引擎能力保全直接闸门，零 db/provider 依赖 |
| 插件级 stub（新增） | `tests/plugin/{registry,expand,reverse,minimax,profile-list,complete}.test.ts` | 不 spin 真 DSH，mock 最小 ctx：`ctx.tools.register` 收集注册面（4 工具 name/参数/output 与 §6 一致）；`ctx.llm.stream` 喂固定 StreamChunk 序列（text-delta→block-end→usage→finish），断言 system/user/maxTokens/dry_run 传递；reverse 断言 `sanitizeFinalCaption` 被调用；图片路径 mock `exec.agent.session.events` 含 `'user/message'`（image block），断言 `ImageAttachmentRef` 原样进 messages；profile_list mock settings scope，断言 get/update + `clearProfileCache()` |
| complete() 单测 | 同上 | BlockAssembler 正常文本 / finish error/aborted 转抛两分支 |

删除：`tests/handlers.test.ts`、`smoke.test.ts`、`save-key.test.ts`、`provider/client.test.ts`（被测层消失）。

## 11. 实施批次与验收

| 批次 | 内容 | 验收 |
|---|---|---|
| P0 骨架 | 建 `src/plugin/{index,config}.ts`、依赖声明（§4）；tsc 通过；**收尾补最小链路验证**：hello 工具插件 → `dsh plugin --profile web add <本地路径>` → patch insert → 重启 Web UI 确认工具出现（消除本地包解析最大不确定性；失败走 §9.2 兜底） | 编译零错误 + hello 工具出现在 Web UI |
| P1 最小闭环 | 只注册 `prompt_expand`（含 dry_run），挂进本地 patch | 真实会话可调用 `prompt_expand`，无 MCP 名，dry_run 生效 |
| P2 全量工具 | reverse（文本+图片附件、sanitize 链）、minimax（budget）、profile_list（settings + 自定义 profile）；`ctx.llm` 真实调用 | 4 工具全可用；profile_list 五动作齐全 |
| P3 清理 | 删 provider/db/config/MCP 入口与依赖；§3.2 注入源改造 | 依赖树只剩引擎 + DSH 全家桶；`npm test` 全绿（含 §2 保全验收） |
| P4 图片反推联调 | 视觉模型 route 校验、image block 复用、错误引导文案；Web UI 实际贴图反推 | 贴图 → prompt_reverse 返回反推结果 |

## 12. 风险与缓解

1. **DSH 是 RC（README 明示会有 breaking changes）**：peer 同版本，升级 DSH 时回归。
2. **`exec.agent` 可能为空**：§5.1 完整回落链。
3. **本地插件包 patch 解析未实证**（最大外部不确定性）：P0 hello 验证 + §9.2 `dsh.bundle.patch` 兜底。
4. **错误路径吞错**：`complete()` 显式转抛 error/aborted，避免"成功返回空字符串"。
5. **custom_profiles 与 provider_config 被裁剪**：功能有损但符合"不自己写逻辑"目标；provider 配置归 DSH Settings 本就是设计意图。
6. **一次 P0→P4 全做的验证集中风险**：P0 已含挂载链路验证，P1/P2 有 tsc + stub 测试闸门，resolver 测试全程兜底。

## 13. 决策记录（D1–D6 追溯）

| # | 决策 | 定案 |
|---|---|---|
| D1 | provider/model 来源 | 跟随当前 agent 路由（`exec.agent.options` → config 回落链，§5.1） |
| D2 | 自定义 Profile | `ctx.settings` 命名空间（§7.3），保留源码 profile_list 全部动作 |
| D3 | 图片输入反推 | 本期做，走会话附件（§7.2） |
| D4 | history | 不做，DSH session log 承担 |
| D5 | 项目形态 | 仓库内重组为单插件包，保留仓库与 tests |
| D6 | minimax_scenario | 保留（含场景列表 / budget / 六段拆分） |

**本 spec 相对 plan-b v1.1 的校正**：① `profile_list` action 全集恢复为 list|search|get|save|delete（源码既有能力，v1.1 表格误收窄）；② `prompt_expand` 默认 profile 修正为 `pe_expand_natural`；③ `prompt_reverse` 补回 `quality_prompt_enabled` / `quality_prompt_prefix`；④ 能力保全清单升级为硬约束（§2）。