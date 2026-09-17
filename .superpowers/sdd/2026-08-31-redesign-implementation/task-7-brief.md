# Task 7 Brief: H3 budget 帧底精确化 + intent persona/schema 方言化 + 生产级日志

## 背景
方案 A 第 7 个任务（最后一个代码任务，Task 8 是回归收尾）。三件事：
1. **budget 帧底精确化**：buildH3Budget 的 `chatTemplateTokens` 从估算（`5 + 2N`）改为官方精确计数（把空文本装进上下文帧后全量 BPE）。
2. **intent persona/schema 方言化**：prompt_author 的 intent 调用按 target 从 `getDialect(target).intent` 取 persona/schema（Task 5 已拆分 ANIMA_*/H3_* 常量并注册进 dialect），替换全局 DEFAULT。
3. **生产级日志**：5 个工具入口/出口/错误打点（`ctx.logger`），内核 trace 贯穿。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 全局约束
- 测试 `npx vitest run <file>`；全量 `npx vitest run`；构建 `npm run build`；git 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`
- fidelity golden 必须继续全绿（帧底精确化后 golden 语义不变——golden 断言的是 text tokens，帧底影响 available/effectiveCap）
- 纯函数层（budget.ts）零日志；工具层用 `ctx.logger`（Cordis Context 自带，read 现有工具确认 ctx 上可访问；若 `ctx.logger` 不存在则 `ctx.get('logger')`——**read 核实**；都不行就在工具层 try/catch 包日志调用，保证日志失败不影响工具）
- 日志**不打 prompt 正文/图片/API key**，只打摘要（target/variant/stage/ok/gates 数/耗时）
- 已知 flaky：catalog-search / anima-brief-golden ex1 偶发（并行 sqlite IO）——单独重跑确认即可，不算回归

## Files
- Modify: `src/pe-framework/audit/budget.ts`（chatTemplateTokens 精确化）
- Modify: `src/pe-framework/intent/subagent-provider.ts`（subagentIntent 读 req.persona/req.schema 优先于 DEFAULT）
- Modify: `src/tools/prompt-author.ts`（intent 请求带 dialect persona/schema；日志打点）
- Modify: `src/tools/prompt-compile.ts`、`src/tools/prompt-audit.ts`、`src/tools/prompt-expand.ts`、`src/tools/prompt-reverse.ts`（日志打点）
- Test: `tests/pe-framework/audit/budget-frame.test.ts`（新增）、`tests/plugin/logger-spy.test.ts`（新增）
- 现有 intent 测试：`tests/pe-framework/intent/subagent-provider.test.ts`、`tests/plugin/intent.test.ts` 需兼容（req 增加可选 persona?/schema? 字段）

## Part 1: budget 帧底精确化

现状（budget.ts buildH3Budget）：
```ts
const chatTemplateTokens = references.length === 0 ? 5 : Math.ceil(5 + references.length * 2)
```
官方口径（h3 skill token_counting.py `count_h3_text_context`）：帧 = `<|im_start|>user\n{Picture i: <|vision_start|><|image_pad|><|vision_end|>\n × N}{text}<|im_end|>\n`；`chat_template_tokens` = 同帧 text=""。插件 `countTokensH3(text, dir, refCount)`（tokenizer-h3.ts）已实现帧内计数——`countTokensH3('', dir, N).tokens` 即官方帧底。

改为：
```ts
let chatTemplateTokens: number
try {
  chatTemplateTokens = countTokensH3('', options?.tokenizerSourceDir, references.length).tokens
} catch {
  chatTemplateTokens = references.length === 0 ? 5 : Math.ceil(5 + references.length * 2)  // tokenizer 不可载 → 旧估算回退
}
```
> **先 read tokenizer-h3.ts** 核实 `countTokensH3` 实际签名（参数顺序/命名可能不同，如 `countH3TextContext`）——以现有导出为准调用。注意：现有 `tokenizerSourceDir` override 语义保持（undefined → 默认目录）。
> **注意 estimate 回退时的语义**：整个 buildH3Budget 的 textTokens 在 tokenizer 不可载时也走 estimate（现有 catch 逻辑）——帧底 catch 与它独立（分别 try/catch，都回退旧值）。**read 现文件确认回退结构**，保证 counter='estimate' 时 textTokens/chatTemplateTokens 都用旧口径。

测试 `tests/pe-framework/audit/budget-frame.test.ts`：
```ts
import { describe, expect, it } from 'vitest'
import { buildH3Budget } from '../../../src/pe-framework/audit/budget.js'
import { resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
import { dirname } from 'node:path'

const realTokenizerDir = dirname(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' }))

describe('H3 budget chat-frame precision', () => {
  it('estimate fallback intact when tokenizer dir invalid', () => {
    const b = buildH3Budget('t2va', 'hello', [{ who: 'a', image: 'x', width: 1024, height: 1024 }], { tokenizerSourceDir: 'C:/nonexistent' })
    expect(b.counter).toBe('estimate')
  })

  it('exact frame bottom with real tokenizer: refs>0 chat frame > 5 (official im_start/user/vision pads/im_end)', () => {
    const b = buildH3Budget('t2va', 'hello', [{ who: 'a', image: 'x', width: 1024, height: 1024 }], { tokenizerSourceDir: realTokenizerDir })
    expect(b.counter).toBe('official-tokenizer')
    // 帧底精确性：1 张 1024x1024 图 → visual = 32*32 = 1024；available = 262144 - 1024 - frame - 256
    // effectiveCap = min(1200, available) = 1200（远大于）——直接断言不过 cap 的边界意义不大；
    // 断言：不 throw 且 counter 正确即可；帧底具体值由 tokenizer golden 覆盖（tests/fidelity/h3-tokenizer-golden 已有 framed 基线）
  })

  it('t2va quality cap still 1200 after frame change', () => {
    const b = buildH3Budget('t2va', 'x'.repeat(100), [], { tokenizerSourceDir: realTokenizerDir })
    expect(b.qualityCap).toBe(1200)
    expect(b.over).toBe(false)
  })
})
```
> 若 fidelity 的 h3-tokenizer-golden 有 framed 值（调研提到 t2va_baker raw=76 framed=81，差=5 帧底=无引用帧），可加断言：`countTokensH3('', dir, 0).tokens` 与 golden 帧底一致（read golden 文件核实值再断言，或断言 `>=5 && <=10` 的宽松范围避免脆断）。

## Part 2: intent persona/schema 方言化

### subagent-provider.ts（subagentIntent 内）
现有（read 核对）：
```ts
const persona = opts.persona ?? DEFAULT_PERSONA  // 在 createSubagentIntentProvider 顶部
```
改：persona/schema 解析移入 `subagentIntent(req, exec)` 内：
```ts
const persona = (req as any).persona ?? opts.persona ?? DEFAULT_PERSONA
const schema = (req as any).schema ?? opts.schema ?? DEFAULT_SCHEMA
```
（`AuthorIntentRequest` 加可选字段 `persona?: string; schema?: string`——类型定义在 tools/prompt-author.ts）

### prompt-author.ts（provider 调用处）
```ts
import { getDialect } from '../pe-framework/dialect/registry.js'
// execute 内，provider 调用前：
const intentCfg = getDialect(target)?.intent
// 两处 provider 调用（round 0 与修正轮）的 req 加：
//   persona: intentCfg?.persona, schema: intentCfg?.schema
```

### 测试适配
- `tests/pe-framework/intent/subagent-provider.test.ts`：现有用例 req 不带 persona/schema → DEFAULT 兜底，行为不变，应继续绿。**新增 1 用例**：req 带 persona/schema 时优先（fake start 捕获 prompt，断言含自定义 persona 文本、不含 DEFAULT 的 '资深'）。
- `tests/plugin/author-e2e.test.ts` / `intent.test.ts`：注入的 fake provider 通常 `(req) => ...`——req 多两个字段不影响。

## Part 3: 生产级日志

**read 核实 ctx.logger**：Cordis Context 的 logger 访问方式（先看现有代码有没有用 ctx.logger 的先例——grep `ctx.logger`；若工具 ctx 上无 logger，用 `ctx.get('logger')`；若 service 不存在，包一层安全调用）。

每个工具 execute 的打点模式：
```ts
// 入口（author/compile/audit/expand/reverse 各自）：
ctx.logger?.info?.(`[prompt-master] ${toolName} target=${target}${variant ? ` variant=${variant}` : ''}${stage ? ` stage=${stage}` : ''}`)
// 成功（author/compile/audit 在 assembleEnvelope 前）：
ctx.logger?.info?.(`[prompt-master] ${toolName} → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter(g => g.severity === 'critical').length}`)
// 错误（现有 throw 前或 catch 包裹）：
// 用安全方式：包 try/catch 的工具若改动大，可只在入口+成功两点打；错误路径利用 DSH 已有 tool/result isError 记录
```
- **expand/reverse 的成功点**：返回正文前打 `→ ok=true chars=${result.length}`（不打印正文）。
- 日志调用全部用可选链 `ctx.logger?.info?.(...)`——logger 缺失时静默跳过（stub 测试环境无 logger 不炸）。
- **kernel trace**：author/compile 的成功日志附 `trace=${JSON.stringify(stage.trace?.stages?.map(s => `${s.name}:${s.ms}ms`))}`（短摘要）。

### 日志测试 `tests/plugin/logger-spy.test.ts`
```ts
// 构造带 logger spy 的 ctx stub（mock ctx.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }）
// 调 prompt_compile 的 execute（简单 slots 输入）→ 断言 info 被调 ≥1，消息含 'prompt_compile'，且不含 slots 里的正文内容
// prompt_expand 同理（dry_run=true 路径打点也验证）
```
（read tests/plugin/helpers.ts 或 registry.test.ts 的 stub 模式复用。）

## 步骤

1. Read：budget.ts / tokenizer-h3.ts（countTokensH3 签名）/ subagent-provider.ts（persona 解析点）/ prompt-author.ts（provider 调用处）/ 一个工具的 ctx 用法（logger 可用性）/ fidelity h3 golden（帧底值）。
2. Part 1 TDD：budget-frame 测试（先失败——现有帧底估算会让 case 2 的 counter 断言失败？不——case 2 现有实现 counter 就是 official（textTokens 走官方）……**注意**：现有实现 textTokens 已走官方，只有 chatTemplateTokens 是估算且不外显。所以 Part 1 的可观察差异 = available/effectiveCap 变化。改测试：case 2 断言 `b.effectiveCap` 等于 `min(qualityCap, 262144 - visual - exactFrame - 256)`，用 countTokensH3('', dir, 1).tokens 实算帧底对比——先写期望帧底的精确断言（失败）→ 改实现（通过）。)
3. Part 2 TDD：subagent-provider 新用例（先失败——自定义 persona 未生效）→ 改实现（通过）+ author 接线。
4. Part 3：日志打点 + spy 测试。
5. 全量：`npx vitest run` 全绿（~310 预期；flaky 单独重跑）。
6. `npm run build` exit 0。
7. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): exact H3 chat-frame budget, dialect-driven intent persona, structured logging"
```

## 验收
- budget-frame 测试证明帧底精确（refs>0 时帧底来自 tokenizer 而非 5+2N）
- intent：req.persona/schema 优先；author 从 dialect.intent 取
- 5 工具有日志打点（spy 测试过；正文不落日志）
- fidelity 全绿；全量绿；build 0