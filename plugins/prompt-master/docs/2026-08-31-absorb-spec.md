# Prompt Master 吸收增强 · 完整设计 Spec（五项全做）

> 版本：v1.0 · 日期：2026-08-31 · 状态：brainstorming 分节确认完成，待用户终审
> 依据：`docs/2026-08-31-promptmaster-absorb-analysis.md`（第二轮深度吸收分析）、`docs/2026-08-31-spec-compliance.md`（重构后合规基线）
> 用户裁决：①五项全做；②**不向后兼容**（全新重构，不保留旧调用语义）；③必须考虑未来扩展；④日志管理；⑤**所有 DSH 包/接口必须真实存在**（每个接口标注验证来源）

## 0. 原则

1. **不向后兼容**：工具参数/存储机制按目标形态直接重构；旧数据（customProfiles 中的旧形态字段）不做迁移仪式，直接按新机制解释。
2. **未来扩展**：一切新能力按"注册表/声明制"设计——新模型、新场景契约、新净化规则都是加数据，不改内核。
3. **日志统一**：全部新组件走 Cordis `ctx.logger`（info/warn/error/debug），纯函数层返回结构化结果由调用层打点；日志只含摘要不含正文。
4. **接口真实性**：本 spec 引用的每个 DSH 接口都在 §8 清单中标注验证方式与验证时间；实施中发现接口不存在 → 停下修正 spec，不得绕过。

## 1. 总路线图

```
B0 模型能力矩阵 ──┬──▶ B1 续写引擎（契约声明制）
                  └──▶ B3 输出净化链（家族分流）
B2 JoyExtra 三段式（独立）
B4 媒体身份映射 S 子集（独立）
B5 双层存储 + 导入导出（独立）
```

执行顺序：**B0 → B1 ∥ B2 → B3 → B4 ∥ B5**。每批独立交付、独立验证（TDD + 全量回归 + fidelity）。

## 2. B0：模型能力矩阵

### 2.1 模块：`pe-framework/model-capabilities/`（纯函数，无 DSH 接口）

```ts
// families.ts
export type ModelFamily = 'deepseek' | 'glm' | 'qwen-vl' | 'qwen-text' | 'gemma' | 'openai' | 'generic';
export function inferModelFamily(provider: string, model: string): ModelFamily;
// 规则链：model id 精确/正则匹配（/qwen.*vl/i → qwen-vl；/^glm/ → glm；/deepseek/ → deepseek）
//        → provider 正则（provider 含 'zhipu' → glm 系）→ 'generic'
// 表驱动：FAMILY_RULES: Array<{ family, modelPatterns: RegExp[], providerPatterns?: RegExp[] }>——新家族 = 加一行

// capabilities.ts
export interface ModelCapabilities {
  family: ModelFamily;
  proneToTruncation: boolean; // true → B1 续写引擎建议启用
  sanitizeLevel: 'none' | 'generic'; // B3 路由
  mediaTargets: ReadonlyArray<'image' | 'video' | 'mixed'>;
  lockedOutputLang?: 'zh' | 'en';
  defaultTemperature?: number;
  defaultTopP?: number;
}
export const FAMILY_CAPABILITIES: Record<ModelFamily, ModelCapabilities>; // 表驱动，新家族 = 加一行
export function getCapabilities(family: ModelFamily): ModelCapabilities;
export function applyCapabilities<T>(caps: ModelCapabilities, params: T): T;
// 只填 undefined 字段——用户显式值永远赢（PromptMaster applyModelCapabilitiesToCaption 语义）
```

### 2.2 接入点

`prompt_expand` / `prompt_reverse` / `minimax_scenario` 在 `resolveRoute(exec)` 之后：

```ts
const caps = getCapabilities(inferModelFamily(route.provider, route.model));
const temperature = config.temperature ?? caps.defaultTemperature; // 用户配置优先，家族默认兜底
// topP 不接入（现有工具无此参数，不为其扩 schema——能力矩阵记录它供未来使用）
```

（若 config.temperature 恒有值（default 0.7），家族默认实际只在 config 显式去掉 temperature 时生效——这是"用户值永远赢"语义的自然结果。）

### 2.3 验收

- 家族推断表驱动测试 ≥10 用例（含 provider/model 组合、未知模型 → generic）。
- applyCapabilities 用户值优先测试。
- 全量回归（B0 为纯新增，零改动现有行为——接入点行为变化仅限"默认温度覆盖"，需逐一断言）。

## 3. B1：续写引擎（契约声明制）

### 3.1 模块：`pe-framework/continue/`

```ts
// contract.ts
export interface OutputFieldContract {
  key: string;
  patterns: RegExp[];
} // 中英双标签正则
export interface OutputContract {
  id: string; // 'minimax-full-reference' 等
  fields: OutputFieldContract[]; // 必须存在的字段
  groupSeparator?: RegExp; // director 组分隔符（含组号捕获）
  expectedGroups?: (formFields: Record<string, unknown>) => number;
}
// 契约注册进 minimax 场景 catalog（full_reference 与 director_segments 场景各声明一份）；
// 声明制：无契约 = 不续写（含截断场景——宁缺毋滥）

// inspect.ts
export interface StructureInspection {
  missing: string[];
  complete: boolean;
}
export function inspectOutput(text: string, contract: OutputContract): StructureInspection;
// 逐 field 查 patterns 任一命中且标签体 ≥2 字符；groupSeparator 存在时切组逐组验收
// 缺失清单格式：`field:<key>` / `group:<n>:<key>` / `groups:<present>/<expected>`

// merge.ts
export function mergeContinuedText(previous: string, continued: string): string;
// 剥寒暄前缀（好的/继续输出/如下）→ 复读检测（新文以旧文开头取新文）
// → 后缀-前缀重叠匹配（12..240 字符窗口）→ 无命中换行拼接

// engine.ts
export interface ContinueOutcome {
  text: string;
  rounds: number;
  complete: boolean;
  warnings: string[]; // 'INCOMPLETE_AFTER_MAX_ROUNDS' / 'CONTINUE_ABORTED_PARTIAL'
}
export interface ContinueSeed {
  system?: string; // 原请求的 system（续写轮沿用）
  userText: string; // 原请求的 user 正文
  outputLang: 'zh' | 'en';
}
export async function continueUntilComplete(params: {
  contract: OutputContract;
  initialText: string;
  finishKind: FinishReason['kind']; // DSH dsh-llm（已验证：'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'）
  seed: ContinueSeed;
  generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: FinishReason['kind'] }>;
  maxRounds?: number; // 默认 3
  signal: AbortSignal;
  onContinue?: (round: number, maxRounds: number) => void;
}): Promise<ContinueOutcome>;
```

> **消息构造定稿（接口真实性）**：续写轮不构造 assistant 角色历史消息（`createAssistantMessage` 类辅助函数未在本部署验证存在——`createUserMessage` 已验证）。每轮续写 = **单条 user 消息**：`已写出（不要重写，基于它继续）：-----\n{累计全文}\n-----\n\n缺失内容：{missing 清单}。请从缺失处继续输出，不要重复已有内容。`（中英按 outputLang）。generate 由调用方封装（内部用已验证的 `complete(ctx, {provider, model, system, user, maxTokens, signal})`——complete.ts 现有封装，system 可选参数已支持）。

### 3.2 行为规格

1. 触发：`inspectOutput` 不过 **或** `finishKind === 'max-tokens'`；`contract === undefined` 时**恒不触发**（契约声明制，expand 不挂）。
2. 续写消息构造（**单 user 消息方案**——不构造 assistant 历史消息，规避未验证接口）：`已写出（不要重写，基于它继续）：-----\n{累计全文}\n-----\n\n缺失内容：{missing}。请从缺失处继续输出。`（中英按 outputLang）
3. 合并按 `mergeContinuedText`；每轮循环前 `signal.throwIfAborted()`；generate 抛错但已有部分文本 → 返回部分结果 + warning（不抛）。
4. `generate` 由调用方（minimax_scenario 工具）提供——内部用现有 `complete(ctx, …)` 封装（续写不需要 system，历史里已有）。

### 3.3 契约声明落点

minimax 场景 catalog 条目增加可选字段 `outputContract`（full_reference 场景六段 fields；director_segments 场景 groupSeparator + expectedGroups）。`minimax_scenario` execute：场景带 contract → complete 后走 `continueUntilComplete`；无 contract 场景行为不变。

### 3.4 日志

每次续写轮：`ctx.logger.info('[prompt-master] continue round=${n}/${max} missing=${missing.length}')`；终态：`complete=${complete} rounds=${rounds}`。由工具层打（engine 是纯异步编排，通过 onContinue 回调上抛，工具层落日志）。

### 3.5 验收

- 六段契约 golden：构造截断文本 → mock generate 返回续写片段 → 合并完整 + missing 清空。
- director 切组：N=4 缺第 3 组 → 缺失清单 `groups:3/4` + `group:3:*`。
- 合并三分支：复读/部分重叠/无重叠。
- abort：round 2 时 abort → 返回部分文本 + CONTINUE_ABORTED_PARTIAL。
- max-tokens 触发但结构完整 → 不续写（截断但无缺失的兜底仍续写——**修正**：finishKind=max-tokens 即触发，结构完整也续写一次防暗截断）。

## 4. B2：JoyExtra 三段式

### 4.1 模块：`pe-framework/sanitize/joy-extra.ts`（纯函数）

```ts
export type JoyExtraOptionId =
  'no_glasses_headwear' | 'scene_only_no_character_appearance' | 'no_artistic_style' | 'character_name';
export interface JoyExtraResolution {
  options: JoyExtraOptionId[];
  characterName?: string;
}
export function resolveJoyExtraOptions(input: {
  joyExtraOptions?: unknown;
  extraPrompt?: string;
  characterName?: unknown;
}): JoyExtraResolution;
// 数组优先（字符串数组→id 白名单过滤）；回退正则嗅探 extra_prompt 标准句三种变体；character_name 从 'refer to them as X'/'称呼为X' 抓取

export function buildJoyExtraSystemBlock(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string;
// 「附加要求是硬约束，优先于任何检查表/冲突默认」+ 每选项冲突豁免令 + 选项冲突仲裁 + character_name 统一称呼令
export function buildJoyExtraUserTail(res: JoyExtraResolution, outputLang: 'zh' | 'en'): string;

export function filterJoyExtraClauses(text: string, res: JoyExtraResolution): string;
// splitClauses（中英标点/换行，记住原分隔符）→ 命中禁选主题正则组的子句整句剔除 → 原分隔符拼回 → 空则原样返回
```

### 4.2 挂接

- `prompt_reverse`：参数加 `joy_extra_options?: string[]`、`character_name?: string`；resolveReverse 后 system 拼 `buildJoyExtraSystemBlock`、user 末尾拼 tail；sanitizeFinalCaption **之后**执行 `filterJoyExtraClauses`。
- `prompt_author`（anima）：`form_fields.joy_extra_options` 透传；compileAnima 产出的 positive/negative 各过一遍 `filterJoyExtraClauses`（逗号分隔符天然适配 tag 串）。**语义说明**：`exclusions` 槽（brief 字段）走 negative 通道是"编译期排除"；JoyExtra 过滤是"输出端兜底"（模型把该排除的写进了 positive 时切除）——两者互补，非重复。
- 不向后兼容：不嗅探旧参数形态；`extra_prompt` 文本嗅探仅作为 JoyExtra 自身的识别输入（这是 PromptMaster 的功能语义，非兼容层）。

### 4.3 日志

工具层：`joy_extra options=${res.options.join('|') || 'none'} filtered=${filtered ? 'yes' : 'no'}`。

### 4.4 验收

- 嗅探双模式（数组/文本/两者）；过滤三态（剔除/无命中原样/全灭保护）；冲突豁免令文本快照；character_name 抓取。
- 端到端：注入"不写眼镜"约束 → mock 模型输出含眼镜子句 → 过滤后无。

## 5. B3：输出净化链（通用层）

### 5.1 模块：`pe-framework/sanitize/model-specific.ts`（纯函数）

```ts
export function sanitizeModelSpecific(text: string, ctx: { family: ModelFamily; outputLang: string }): string;
// getCapabilities(family).sanitizeLevel === 'none' → 原样返回
// 'generic' → 固定顺序管线：
//   1. stripThinkingTags: /<think>[\s\S]*?<\/think>/g 全删 + 「思考：…」段落删
//   2. extractPolishedTail: 8 种标记（润色与精简:/最终输出:/Final polished caption:/…）取最后一次命中之后；无标记原样
//   3. stripInstructionEchoLines: 自检/元话语行过滤（这张图片/我需要/关键词构思/整合/组合成/答案：…）
//   4. stripSectionHeaders: Style:/Draft:/Keywords: 等标题行剥离 + 英文逗号行去重合并
```

**定界封套不做**（涉及 system 块变更与具体模型行为绑定，等真实小模型反馈）；中文垃圾分类器完整表不做。

### 5.2 挂接

`prompt_reverse` / `prompt_expand` 输出在 sanitizeFinalCaption 之前执行 `sanitizeModelSpecific`（先按家族清洗，再方言清洗——顺序：模型级脏 → 方言级脏）。family 来自 B0。

### 5.3 日志

工具层：`sanitize family=${family} level=${level} changed=${before !== after}`。

### 5.4 验收

每级独立 fixture（含负面用例"正常输出零改动"）；家族分流路由；`<think>` 嵌套/未闭合边界。

## 6. B4：媒体身份映射（S 子集）

### 6.1 模块：`pe-framework/media/identity.ts`（纯函数）

```ts
import type { ImageBlock } from '@deepseek-ai/dsh-llm'; // 类型已验证存在（ContentBlockMap）
export interface TaggedMedia {
  n: number;
  tag: string;
} // tag = '<Picture N>'
export function enumerateTaggedMedia(count: number): TaggedMedia[];
export function buildIdentityDeclarations(media: TaggedMedia[], outputLang: 'zh' | 'en'): string;
// 多图（count ≥ 2）时返回声明块："Identity mapping — do not swap identities: <Picture 1> = 第 1 张图 …"
// 单图返回 ''（不注入）
```

### 6.2 挂接

`prompt_reverse`：`collectRecentImages` 返回 ≥2 张时，messages = `[identityTextBlock, ...imageBlocks, ...textBlocks]`——identity 声明 text block 置于媒体块之前（DSH content blocks 顺序即消息顺序，**实施首日需用真实多图会话验证 adapter 的块顺序语义**——这是本批唯一 DSH 行为假设，验收里显式列出）。

### 6.3 日志

`multi-image identity declarations injected (n=${count})`。

### 6.4 验收

打标连续性；注入位置；单图不注入；**真实会话多图验证（用户配合项）**。

## 7. B5：双层存储 + 导入导出（不向后兼容）

### 7.1 存储（settings 新 namespace `prompt-master-profile-overrides`）

```ts
// pe-framework/profiles/storage-v2.ts
export interface BuiltinOverride {
  enabled: boolean;
  sort?: number;
}
export interface OverridesSection {
  builtinOverrides: Record<string, BuiltinOverride>;
}
// ctx.settings.register('prompt-master-profile-overrides', z.object({
//   builtinOverrides: z.dict(z.string(), z.object({ enabled: z.boolean(), sort: z.number() })),
// }))
// ⚠️ schemastery（非 zod）：字段无 default 即可选——不写 .optional()（Task 1 已验证的教训）
// 用户自建 profile 继续存现有 'prompt-master-custom-profiles' namespace——机制不变（它不是"旧格式"，是自建层的正确定位）
```

### 7.2 合并读取

```ts
export function listProfilesMerged(): PEProfile[];
// 内置全表（代码 getDefaultBuiltinProfiles）→ overrides 应用（enabled=false 剔除 / sort 重排）→ customProfiles 合并 → sort/name 排序
// 自愈：overrides 指向不存在的内置 id → 读取时忽略（settings 残留无害）
```

### 7.3 profile_list 工具扩展（不向后兼容 = action 面直接定为最终形态）

- 现有 action 保留语义：`list`（改用 listProfilesMerged）/`search`/`get`/`save`/`delete`
- 新增：`enable`（{id, enabled}：内置写 overrides、自建改自身字段）/`sort`（{ids}）/`export`（{id} 单条 JSON + `format: 'prompt-master-prompt-engineering'` 标）/`import`（{profile} 白名单校验 → **id 重铸 `pe_custom_+randomUUID()`**）/`validate_import`（预检不落盘，返回人话结论）

### 7.4 不向后兼容的明示

- 旧 settings 里若有残留的非新形态数据 → 读取时按新 schema 校验失败即忽略（fail-safe），**不做迁移**。
- profile_list 的参数 schema 以本节为准；此前任何中间形态不保留。

### 7.5 日志

`profile_list action=${action} → ${结果摘要（条数/导入 id）}`；导入重铸时 `import recast id ${old} → ${new}`。

### 7.6 验收

合并语义（禁用消失/排序生效/自建混排）；导入重铸；预检分支；overrides 残留自愈；`enable`/`sort` 持久化往返。

## 8. DSH 接口真实性清单（全部已验证）

| 接口                                                            | 使用批次                            | 验证方式                                                       |
| --------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `ctx.llm.stream(GenerateOptions): AsyncIterable<StreamChunk>`   | B1(generate 封装)                   | cordis_inspect_query Service.llm ✅（2026-08-31）              |
| `BlockAssembler` / `createUserMessage`（dsh-llm）               | B1                                  | 源码 grep `@deepseek-ai/dsh-llm/lib/index.js` ✅               |
| `FinishReason['kind']` 含 `'max-tokens'`                        | B1 触发                             | FinishReasonMap 源码 ✅                                        |
| `Message` / `ContentBlock` / `ImageBlock`（dsh-llm 类型）       | B1/B4                               | GenerateOptions/ContentBlockMap 声明 ✅                        |
| `ctx.tools.register(defineTool({output, execute(args, exec)}))` | B2/B5 参数扩展                      | ToolDefinition 源码 ✅                                         |
| `exec.agent` / `exec.signal`                                    | B4（session events 经 agent）       | ToolExecutionInput 源码 + prompt_reverse 现用 ✅               |
| `ctx.settings.register` / `scope.get/update`                    | B5                                  | cordis_inspect_query Service.settings ✅                       |
| `ctx.logger.info/warn/error/debug`                              | 全部批次                            | cordis lib L1687（LoggerService 挂载）+ L457-460（级别方法）✅ |
| `agent.session.events`（AssistantOutputFold 事件数组）          | B4（现有 collectRecentImages 已用） | 现有代码运行中 ✅                                              |

**红线**：实施中需要任何未列接口 → 停下先验证（inspect/源码），再改 spec。

## 9. 日志管理架构（全局规范）

- **通道**：Cordis `ctx.logger`（Context 内建 LoggerService，进程日志通道；非会话日志）。
- **分工**：DSH 会话日志记"发生了什么"（tool/call+result 已内建）；插件日志记"内部为什么"（阶段/轮次/回退/过滤计数）。
- **级别约定**：`info`=工具入口/成功摘要/续写轮次；`warn`=回退（estimate/净化无效果/overrides 残留自愈）；`error`=工具失败（含堆栈对象作为第二参数）；`debug`=净化逐级变更明细。
- **红线**：任何日志行不得包含 prompt 正文/图片数据/API key/完整 profile JSON；长度超 1KB 的对象只打键名列表。
- **纯函数层**：返回结构化结果（trace/warnings/counts），调用层统一打点——引擎内零 logger 依赖。

## 10. 未来扩展点（设计已预留）

1. **新模型家族**：`FAMILY_RULES` + `FAMILY_CAPABILITIES` 各加一行——续写/净化/采样自动获得路由。
2. **新输出契约**：场景 catalog 条目声明 `outputContract`——续写引擎自动覆盖新长模板。
3. **新净化级**：`sanitizeModelSpecific` 管线数组插入一级——顺序即语义。
4. **新方言**：`registerDialect`（上一轮已建）——与本 spec 五项正交。
5. **JoyExtra 新选项**：选项表 + 两组正则加条目——三段式自动生效。
6. **B4 完整版**（ffmpeg 抽帧/视频标签）：media/tags.ts 的 `kind` 已预留 `'video' | 'audio'` 扩展位。

## 11. 测试策略

| 层   | 内容                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| B0   | 家族推断表驱动 ≥10 例；applyCapabilities 优先级                                           |
| B1   | 契约 golden（六段/切组/三分支合并/abort/max-tokens 触发）——mock generate                  |
| B2   | 嗅探双模式/过滤三态/豁免令快照/character_name                                             |
| B3   | 每级独立 fixture + 负面用例（正常输出零改动）+ 家族分流                                   |
| B4   | 打标/注入位置/单图不注入                                                                  |
| B5   | 合并语义/导入重铸/预检分支/自愈/enable-sort 往返                                          |
| 回归 | 全量 vitest（315 基线 + 新增 ~40）+ fidelity 52 绿 + 端到端（新会话，含 B4 多图真实验证） |

## 12. 实施顺序与批次

| 批   | 内容                                              | 预估规模                                            |
| ---- | ------------------------------------------------- | --------------------------------------------------- |
| B0   | 能力矩阵                                          | S（~150 行 + 测试）                                 |
| B1   | 续写引擎                                          | M（~400 行 + 测试，含契约声明接入 minimax catalog） |
| B2   | JoyExtra                                          | S-M（~300 行 + 测试）                               |
| B3   | 净化通用层                                        | S-M（~200 行 + 测试）                               |
| B4   | 媒体映射 S 子集                                   | S（~100 行 + 测试）                                 |
| B5   | 双层存储                                          | M（~350 行 + 测试）                                 |
| 收尾 | usage 文档更新 + 端到端验证（含 B4 多图真实会话） | —                                                   |

## 13. 决策记录

- D1（用户）：五项全做，不向后兼容（旧形态数据不迁移，schema 失败即忽略）。
- D2（用户）：契约声明制——无契约不续写；expand 不挂续写。
- D3（用户）：JoyExtra 数组 + 文本嗅探双模式。
- D4（用户）：日志管理为全局规范（§9）；接口真实性红线（§8）。
- D5：B4 做 S 子集，完整版预留扩展位（§10.6）。
- D6：B5 用户自建层机制保留（customProfiles namespace 不是"旧格式"，是自建层正确定位）；新增 builtinOverrides。
- D7：B1 修正——finishKind='max-tokens' 时即使结构完整也续写一轮（防暗截断）。
- D8：B3 定界封套不做；垃圾分类器完整表不做（等真实小模型反馈）。
