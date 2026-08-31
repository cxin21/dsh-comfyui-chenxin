# 「提示词大师」DSH 原生插件重构 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 prompt-master-mcp 的 PE 引擎（扩写/反推/MiniMax H3）从自建 MCP Server 重构为 DSH 原生 Cordis 插件 `@prompt-master/dsh-plugin`，4 个工具以原生名接入 DSH，能力零裁剪。

**Architecture:** 插件由 cordis entry（`src/plugin/index.ts`）+ 4 个 defineTool 工具（`src/tools/*`）+ 一次性 completion 封装（`src/llm/complete.ts`）+ 1:1 迁移的纯函数 PE 引擎（`src/resolver/**`）组成。模型调用全走 `ctx.llm.stream`，provider/model 跟随会话路由，自定义 profile 存 `ctx.settings`。DB/provider/MCP 层全部删除。

**Tech Stack:** TypeScript（ESM / NodeNext）、`@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery` 3.18.1、vitest。

**Spec:** `docs/2026-08-27-native-plugin-design.md`（本计划从该 spec 论证；执行者需同时阅读两者）

## Global Constraints

- **非 git 仓库**：无 commit 步骤；每个任务的验证闸门 = `npm run build` 零错误 + 相关测试通过（视任务而定）。
- **peer 版本（spec §4）**：cordis `^4.0.1`；dsh-tools / dsh-llm / dsh-attachment / dsh-settings `^0.1.1-rc.2`；schemastery `^3.18.1`。本地开发解析用 devDependencies 声明同版本。
- **schemastery 必须默认导入**：`import z from '@deepseek-ai/schemastery'`（无命名导出 `z`）。
- **输出契约（spec §6）**：纯文本类（expand/reverse）返回 string；结构化类（minimax/profile_list）返回 JSON 字符串；usage 一律不进返回文本（minimax budget 审计除外）。
- **resolver 零修改**：除 `src/resolver/profiles/index.ts` 的 DB 耦合改为可注入源（Task 9），其余 resolver 文件禁止改动；所有 import 保持 `.js` 后缀（NodeNext）。
- **能力保全（spec §2）**：Task 11 后 `npm test` 全绿且 resolver 测试原样通过 = 保全验收。
- **契约校正（spec §13）**：expand 默认 `profile='pe_expand_natural'`（不是源码的 `expand_natural`）；profile_list 保留五动作 `list|search|get|save|delete`；reverse 保留 `quality_prompt_enabled` / `quality_prompt_prefix`。

## File Structure

| 文件 | 责任 | 处置 |
|---|---|---|
| `package.json` | 包元数据：name=`@prompt-master/dsh-plugin`、peerDeps 全家桶、devDeps 分析依赖 + DSH 类型 | 修改（Task 1 / 11） |
| `tsconfig.json` | ESM NodeNext 编译 | 修改（Task 1） |
| `src/plugin/config.ts` | schemastery Config | 新建（Task 1） |
| `src/plugin/index.ts` | cordis 入口：注册 4 工具 + settings 命名空间 + profile 注入源 | 新建（Task 2 hello → Task 10 真体） |
| `src/llm/complete.ts` | 一次性 completion 封装 | 新建（Task 3） |
| `src/llm/route.ts` | provider/model 回落链 | 新建（Task 3） |
| `src/tools/prompt-expand.ts` | defineTool 扩写工具 | 重写（Task 4） |
| `src/tools/prompt-reverse.ts` | defineTool 反推工具（文本+图片） | 重写（Task 5 / 6） |
| `src/tools/minimax-scenario.ts` | defineTool MiniMax 工具 | 重写（Task 7） |
| `src/tools/profile-list.ts` | defineTool profile 管理（五动作） | 重写（Task 8） |
| `src/resolver/profiles/source.ts` | 自定义 profile 注入源契约 | 新建（Task 9） |
| `src/resolver/profiles/index.ts` | profile 注册表（DB 耦合解除） | 修改（Task 9） |
| `src/utils/length.ts` | countChars / estimateTokens | 保留 |
| `src/resolver/**`（其余） | PE 引擎纯函数 | 保留（零改动） |
| `src/index.ts`、`src/provider/*`、`src/db/*`、`src/config/*`、`src/tools/provider-config.ts`、`src/utils/errors.ts`、`src/tools/index.ts` | 旧 MCP 层 | 删除（Task 11） |
| `tests/plugin/helpers.ts` | cordis ctx stub 基础设施 | 新建（Task 3） |
| `tests/plugin/{registry,complete,expand,reverse,reverse-image,minimax,profile-list}.test.ts` | 插件级测试 | 新建（Task 2-8, 10） |
| `tests/resolver/*`、`tests/fixtures/test-data.ts` | 引擎测试 | 保留 |
| `tests/{handlers,smoke,save-key}.test.ts`、`tests/provider/client.test.ts` | 旧层测试 | 删除（Task 11） |

---

### Task 1: 插件包元数据与编译基线

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `src/plugin/config.ts`

**Interfaces:**
- Consumes: 无（基线）
- Produces: `src/plugin/config.ts` 导出 `Config`（`{ defaultProvider: string; defaultModel: string; temperature: number }`），后续所有工具注册函数签名 `register<X>Tool(ctx, config)` 使用它。

- [ ] **Step 1: 修改 package.json**

```jsonc
{
  "name": "@prompt-master/dsh-plugin",
  "version": "0.2.0",
  "description": "Prompt Master as a DSH native plugin - expand/reverse/MiniMax H3",
  "type": "module",
  "main": "dist/plugin/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "vitest"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-llm": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-attachment": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-settings": "^0.1.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-llm": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-attachment": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-settings": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-agent": "^0.1.1-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@types/node": "^22.13.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

保留 `dependencies` 中的旧包（`@modelcontextprotocol/sdk`、`sql.js`、`dotenv`、`yaml`）到 Task 11 再删——它们仍被旧源码引用。

- [ ] **Step 2: 修改 tsconfig.json（module → NodeNext）**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 `src/plugin/config.ts`**

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  defaultProvider: z.string().default('deepseek'),
  defaultModel: z.string().default('deepseek-chat'),
  temperature: z.number().default(0.7),
})

export interface Config {
  defaultProvider: string
  defaultModel: string
  temperature: number
}
```

- [ ] **Step 4: 安装依赖并验证编译（旧代码仍可编，因为旧依赖还在）**

Run: `npm install && npm run build && npm test`
Expected: tsc 零错误；现有 vitest 全部通过（旧测试仍 import 旧层，依赖未删，应保持绿）。

- [ ] **Step 5: 验证闸门**

记录：`npm run build` 输出 0 errors；`npm test` 全绿（保存输出到任务记录）。

---

### Task 2: 最小链路验证（hello 插件挂载到 DSH Web UI）

**Files:**
- Create: `src/plugin/index.ts`（hello 版，Task 10 替换）
- Create: `tests/plugin/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Config`
- Produces: `src/plugin/index.ts` 导出 `name`/`inject`/`Config`/`apply(ctx, config)`；验证「本地路径插件包 → dsh plugin add → cordis.patch.yml insert → Web UI 可见」全链路（spec §9.2 最大外部不确定性的实证）

- [ ] **Step 1: 创建 `src/plugin/index.ts`（hello 版）**

```ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, type Config as ConfigShape } from './config.js'

export const name = 'prompt-master'
export const inject = ['tools', 'llm']
export { Config }

export function apply(ctx: Context, config: ConfigShape) {
  ctx.effect(() => {
    const disposer = ctx.tools.register(defineTool({
      name: 'prompt_master_hello',
      description: 'PM plugin load probe. Returns a constant string.',
      parameters: { ping: { type: 'string', default: 'pong' } },
      output: { schema: { type: 'string', description: 'the constant string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args: { ping?: string }) {
        return `hello from prompt-master: ${args.ping ?? 'pong'}`
      },
    }))
    return () => disposer()
  }, 'prompt-master.hello')
}
```

> 工具名暂用 `prompt_master_hello`（不冲突），Task 10 替换为 4 个正式工具名。

- [ ] **Step 2: 创建 `tests/plugin/registry.test.ts`（hello 注册断言）**

```ts
import { describe, expect, it } from 'vitest'
import { apply } from '../../src/plugin/index.js'

function stubCtx() {
  const registered: Array<{ name: string; description: string; parameters: unknown; output: unknown }> = []
  const ctx: any = {
    tools: { register(def: any) { registered.push({ name: def.name, description: def.description, parameters: def.parameters, output: def.output }); return () => {} } },
    llm: { stream: async function* () {} },
    effect() {},
  }
  return { ctx, registered }
}

describe('plugin registration', () => {
  it('registers the hello probe tool', () => {
    const { ctx, registered } = stubCtx()
    apply(ctx, { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 })
    expect(registered.map((d) => d.name)).toContain('prompt_master_hello')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/plugin/registry.test.ts`
Expected: FAIL（`Cannot find module '../../src/plugin/index.js'` 或 `apply is not a function`，取决于编译/解析顺序——即新文件尚未生效）。

- [ ] **Step 4: 构建并跑测试确认通过**

Run: `npm run build && npx vitest run tests/plugin/registry.test.ts`
Expected: PASS（1 个断言）。

- [ ] **Step 5: hello 链路实证（手动，记录到任务记录）**

```powershell
dsh plugin --profile web add D:\Projects\temp\prompt-master-mcp
# 追加到 ~/.dsh/cordis.patch.yml（改已有 insert 列表，勿动现有 mcp-* 条目）：
# - insert:
#     - id: prompt-master
#       name: '@prompt-master/dsh-plugin'
#       config:
#         defaultProvider: deepseek
#         defaultModel: deepseek-chat
# 重启 DSH Web（dsh web / 由你当前托管方式决定），打开 http://127.0.0.1:3080 新会话
```

Expected: 新会话中模型可见 `prompt_master_hello` 工具（工具名出现在系统提示词装配或可直接被调用）。**若解析失败**：在 `package.json` 补 `"dsh": { "bundle": { "patch": "patch/prompt-master.yml" } }` 并创建 `patch/prompt-master.yml`（内容 = 上述 insert 段），重跑 `dsh plugin --profile web add`（reconcilePlugins 会把它登记为 profile layer，spec §9.2 兜底）。

- [ ] **Step 6: 验证闸门**

registry.test.ts 绿 + 手动清单（patch insert 生效、工具可见）已记录。此任务通过后，后续任务将复用同一条挂载链路。

---

### Task 3: llm 封装（complete.ts + route.ts）与 stub 基础设施

**Files:**
- Create: `src/llm/complete.ts`
- Create: `src/llm/route.ts`
- Create: `tests/plugin/helpers.ts`
- Create: `tests/plugin/complete.test.ts`

**Interfaces:**
- Consumes: 无（纯新增；helpers.ts 为后续所有插件测试的基础设施）
- Produces:
  - `complete(ctx, opts: CompleteOptions): Promise<{ text: string; usage?: TokenUsage; finish: FinishReason }>`，`CompleteOptions = { provider; model; system; user; maxTokens; temperature?; signal }`
  - `resolveRoute(exec, config): { provider: string; model: string }`（回落链，spec §5.1）
  - `tests/plugin/helpers.ts` 导出 `textStream` / `errorStream` / `abortedStream` / `stubCtx` / `runTool`（后续任务全部引用）

- [ ] **Step 1: 创建 `src/llm/complete.ts`**

```ts
import { BlockAssembler, createUserMessage, type FinishReason, type TokenUsage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
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

export async function complete(ctx: Context, opts: CompleteOptions): Promise<{ text: string; usage?: TokenUsage; finish: FinishReason }> {
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
  } satisfies GenerateOptions)
  for await (const chunk of stream) assembler.push(chunk)
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    const failure = assembler.finish.failure
    const err = new Error(failure.message) as Error & { code?: string }
    err.code = failure.code
    throw err
  }
  const text = assembler.blocks()
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text.trim()).join('\n')
  return { text, usage: assembler.usage, finish: assembler.finish }
}
```

- [ ] **Step 2: 创建 `src/llm/route.ts`**

```ts
import type { Config } from '../plugin/config.js'

export interface ExecLike {
  agent?: { session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }; options?: { provider?: string; model?: string } }
  signal: AbortSignal
}

export function resolveRoute(exec: ExecLike, config: Config): { provider: string; model: string } {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  return {
    provider: routed?.provider ?? exec.agent?.options?.provider ?? config.defaultProvider ?? 'deepseek',
    model: routed?.model ?? exec.agent?.options?.model ?? config.defaultModel ?? 'deepseek-chat',
  }
}
```

- [ ] **Step 3: 创建 `tests/plugin/helpers.ts`（stub 基础设施）**

```ts
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

export function textStream(text: string, usage?: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage ? [{ type: 'usage' as const, usage }] : []),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function errorStream(message: string, code = 'E_TEST'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }]
}

export function abortedStream(message: string, code = 'E_TEST'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'aborted', failure: { message, code } } }]
}

export interface ToolDefLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown[] }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

export interface StubContext {
  tools: { registered: ToolDefLike[]; register(def: ToolDefLike): () => void }
  llm: { calls: GenerateOptions[]; stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
  settings?: { get(): Record<string, string>; update(p: object): Promise<void>; replace(s: object): Promise<void> }
  effect(): void
}

export function stubCtx(opts: { stream?: StreamChunk[]; settings?: StubContext['settings'] } = {}): StubContext {
  const calls: GenerateOptions[] = []
  const llm = {
    calls,
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      for (const chunk of opts.stream ?? textStream('ok')) yield chunk
    },
  }
  const ctx: StubContext = {
    tools: { registered: [], register(def) { this.registered.push(def); return () => {} } },
    llm,
    settings: opts.settings,
    effect() {},
  }
  return ctx
}

export interface ExecOverrides {
  events?: unknown[]
  options?: { provider?: string; model?: string }
}

export function stubExec(overrides: ExecOverrides = {}) {
  return {
    signal: new AbortController().signal,
    agent: {
      session: { events: overrides.events ?? [], requestHeader: () => undefined },
      options: overrides.options ?? {},
    },
  }
}

export async function runTool(ctx: StubContext, def: ToolDefLike, args: unknown, exec: unknown = stubExec()): Promise<unknown> {
  return def.execute(args, exec)
}
```

> `stubCtx.settings` 为 duck-typed settings scope（Task 8 用）；`stubExec.events` 为 session 事件数组（Task 6 用）。

- [ ] **Step 4: 创建 `tests/plugin/complete.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { complete } from '../../src/llm/complete.js'
import { resolveRoute } from '../../src/llm/route.js'
import { stubCtx, textStream, errorStream, abortedStream } from './helpers.js'

const opts = {
  provider: 'deepseek', model: 'deepseek-chat',
  system: 'SYS', user: 'USR', maxTokens: 512,
  signal: new AbortController().signal,
}

describe('complete', () => {
  it('assembles text and usage; passes system/user/maxTokens', async () => {
    const ctx = stubCtx({ stream: textStream('answer', { inputTokens: 10, outputTokens: 5 }) })
    const r = await complete(ctx as any, opts)
    expect(r.text).toBe('answer')
    expect(r.usage?.outputTokens).toBe(5)
    expect(ctx.llm.calls.length).toBe(1)
    const call = ctx.llm.calls[0]
    expect(call.provider).toBe('deepseek')
    expect(call.system).toBe('SYS')
    expect(call.maxTokens).toBe(512)
    expect(call.messages[0].source).toMatchObject({ kind: 'plugin', plugin: 'prompt-master' })
  })

  it('throws with code on error finish', async () => {
    const ctx = stubCtx({ stream: errorStream('boom', 'RATE_LIMIT') })
    await expect(complete(ctx as any, opts)).rejects.toMatchObject({ message: 'boom', code: 'RATE_LIMIT' })
  })

  it('throws on aborted finish', async () => {
    const ctx = stubCtx({ stream: abortedStream('cancelled') })
    await expect(complete(ctx as any, opts)).rejects.toMatchObject({ message: 'cancelled' })
  })
})

describe('resolveRoute', () => {
  const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }
  it('falls back from routed → agent options → config', () => {
    expect(resolveRoute({ signal: new AbortController().signal }, cfg)).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(resolveRoute({ signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => undefined } } }, cfg)).toMatchObject({ provider: 'p', model: 'm' })
    expect(resolveRoute({ signal: new AbortController().signal, agent: { options: {}, session: { requestHeader: () => ({ config: { provider: 'rp', model: 'rm' } }) } } }, cfg)).toMatchObject({ provider: 'rp', model: 'rm' })
  })
})
```

- [ ] **Step 5: 跑测试确认先失败后通过**

Run: `npx vitest run tests/plugin/complete.test.ts`（先建测试、未实现时 FAIL；Task 1-4 步代码就绪后）→ Expected 最终 PASS（5 个用例）。

- [ ] **Step 6: 验证闸门**

`npm run build` 零错误 + complete.test.ts 全绿。helpers.ts 就绪，后续任务全部基于它。

---

### Task 4: prompt_expand 工具化

**Files:**
- Rewrite: `src/tools/prompt-expand.ts`（MCP handler → defineTool，删除 provider/db import）
- Create: `tests/plugin/expand.test.ts`

**Interfaces:**
- Consumes: `resolveExpand(profile, params: ExpandParams)`（`resolver/index.ts`，已有）；`findProfileById(id)`（`resolver/profiles/index.js` 已有）；`complete` / `resolveRoute`（Task 3）；`Config`（Task 1）
- Produces: `registerExpandTool(ctx, config): ToolDefinition` —— name=`prompt_expand`，参数见下；dry_run 返回 `{debug, profile_meta}` JSON；正常返回扩写正文 string

- [ ] **Step 1: 创建 `tests/plugin/expand.test.ts`（先失败）**

```ts
import { describe, expect, it } from 'vitest'
import { registerExpandTool } from '../../src/tools/prompt-expand.js'
import { stubCtx, textStream, runTool, stubExec } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }
const def = registerExpandTool(stubCtx() as any, cfg)

describe('prompt_expand', () => {
  it('throws when text is missing', async () => {
    await expect(runTool(stubCtx(), def, {})).rejects.toThrow('text is required')
  })

  it('dry_run returns assembled system/user without calling llm', async () => {
    const ctx = stubCtx()
    const v = await runTool(ctx, def, { text: '一只猫', dry_run: true })
    const parsed = JSON.parse(String(v))
    expect(parsed.debug.user).toContain('一只猫')
    expect(parsed.profile_meta.id).toBe('pe_expand_natural')
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('calls llm with resolved system/user and returns text', async () => {
    const ctx = stubCtx({ stream: textStream('expanded prompt') })
    const v = await runTool(ctx, def, { text: '一只猫' })
    expect(v).toBe('expanded prompt')
    expect(ctx.llm.calls.length).toBe(1)
    const call = ctx.llm.calls[0]
    expect(call.provider).toBe('deepseek')
    expect(call.messages[0].content).toEqual([{ type: 'text', text: expect.stringContaining('一只猫') }])
  })

  it('default profile is pe_expand_natural', async () => {
    const ctx = stubCtx({ stream: textStream('x') })
    await runTool(ctx, def, { text: 't' })
    expect(ctx.llm.calls[0].system).toBeTruthy()
  })

  it('unknown profile errors clearly', async () => {
    await expect(runTool(stubCtx(), def, { text: 't', profile: 'nope' })).rejects.toThrow(/Profile not found/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/expand.test.ts` → Expected: FAIL（handlers 尚为旧签名）

- [ ] **Step 3: 重写 `src/tools/prompt-expand.ts`**

```ts
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveExpand } from '../resolver/index.js'
import { findProfileById } from '../resolver/profiles/index.js'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface ExpandArgs {
  text: string
  profile?: string
  output_lang?: string
  length?: string
  extra_prompt?: string
  dry_run?: boolean
}

export function registerExpandTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'prompt_expand',
    description: '将一段简短描述按所选 profile 扩写为可直接用于 AI 绘图/MiniMax 的完整提示词。可选 dry_run 查看组装结果而不调用模型。',
    parameters: {
      text: { type: 'string', description: '待扩写的简短描述（必填）' },
      profile: { type: 'string', default: 'pe_expand_natural', description: '扩写 profile id（可先用 profile_list 查询）' },
      output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en' },
      length: { type: 'string', default: 'medium', description: '篇幅 short/medium/long' },
      extra_prompt: { type: 'string', default: '', description: '附加要求' },
      dry_run: { type: 'boolean', default: false, description: '只返回组装好的 system/user/maxTokens，不调用模型' },
    },
    output: {
      schema: { type: 'string', description: '扩写正文；dry_run 时返回含 debug 的 JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: ExpandArgs, exec: ToolRunContext) {
      const text = String(args.text || '').trim()
      if (!text) throw new Error('text is required')
      const profile = findProfileById(String(args.profile || 'pe_expand_natural').trim())
      if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_expand_natural')}`)
      const expanded = resolveExpand(profile, {
        outputLang: String(args.output_lang || 'zh'),
        expandLen: String(args.length || 'medium'),
        userExtraPrompt: String(args.extra_prompt || ''),
        shortText: text,
      })
      if (args.dry_run) {
        return JSON.stringify({
          debug: { system: expanded.system, user: expanded.user, maxTokens: expanded.maxTokens },
          profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
        })
      }
      const { provider, model } = resolveRoute(exec as ExecLike, config)
      const { text: result } = await complete(ctx, {
        provider, model,
        system: expanded.system,
        user: expanded.user,
        maxTokens: expanded.maxTokens,
        temperature: config.temperature,
        signal: exec.signal,
      })
      return result || ''
    },
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/plugin/expand.test.ts` → Expected: PASS（5 用例）

- [ ] **Step 5: 验证闸门**

`npm run build` 零错误 + expand.test.ts 全绿。

---

### Task 5: prompt_reverse 工具化（文本路径 + sanitize 链）

**Files:**
- Rewrite: `src/tools/prompt-reverse.ts`（先实现文本路径；图片路径 Task 6 增量扩展）
- Create: `tests/plugin/reverse.test.ts`

**Interfaces:**
- Consumes: `resolveReverse(profile, params: ReverseParams)`、`sanitizeFinalCaption(text, caption)`（`resolver/profiles/reverse/router.js` 已有）；`findProfileById`；`complete` / `resolveRoute`
- Produces: `registerReverseTool(ctx, config): ToolDefinition` —— name=`prompt_reverse`；参数含 `quality_prompt_enabled` / `quality_prompt_prefix`；maxTokens 固定 512；返回 sanitize 后的 string

- [ ] **Step 1: 创建 `tests/plugin/reverse.test.ts`（先失败）**

```ts
import { describe, expect, it, vi } from 'vitest'
import { registerReverseTool } from '../../src/tools/prompt-reverse.js'
import { stubCtx, textStream, runTool, stubExec } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }
const def = registerReverseTool(stubCtx() as any, cfg)

describe('prompt_reverse (text path)', () => {
  it('requires image_description or executes with text input', async () => {
    await expect(runTool(stubCtx(), def, {})).rejects.toThrow(/image/)
  })

  it('passes params and runs sanitizeFinalCaption on the result', async () => {
    const ctx = stubCtx({ stream: textStream('  **caption**  [dup]  ') })
    const v = await runTool(ctx, def, { image_description: '一张猫的照片', output_lang: 'en', length: 'long', anima3_enhance: true, quality_prompt_enabled: true })
    expect(ctx.llm.calls.length).toBe(1)
    expect(ctx.llm.calls[0].maxTokens).toBe(512)
    expect(String(v)).not.toContain('**')
  })

  it('default profile is pe_reverse_descriptive', async () => {
    const ctx = stubCtx({ stream: textStream('ok') })
    await runTool(ctx, def, { image_description: 'cat' })
    expect(ctx.llm.calls[0].system).toBeTruthy()
  })

  it('propagates llm failures as thrown errors', async () => {
    const ctx = stubCtx({ stream: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'upstream down', code: 'E_UP' } } }] })
    await expect(runTool(ctx, def, { image_description: 'cat' })).rejects.toThrow('upstream down')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/reverse.test.ts` → Expected: FAIL

- [ ] **Step 3: 重写 `src/tools/prompt-reverse.ts`（文本路径）**

```ts
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveReverse } from '../resolver/index.js'
import { findProfileById } from '../resolver/profiles/index.js'
import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface ReverseArgs {
  image_description?: string
  profile?: string
  output_lang?: string
  length?: string
  extra_prompt?: string
  anima3_enhance?: boolean
  quality_prompt_enabled?: boolean
  quality_prompt_prefix?: string
}

export function registerReverseTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'prompt_reverse',
    description: '根据图片描述（或会话中的图片附件）反推生成可直接用于 AI 绘图的提示词。output_lang/length/profile 决定输出风格。',
    parameters: {
      image_description: { type: 'string', description: '对画面的描述（必填；若会话最近有图片附件可省略，以图片为准）' },
      profile: { type: 'string', default: 'pe_reverse_descriptive', description: '反推 profile id：pe_reverse_descriptive / pe_reverse_sd / pe_reverse_danbooru 或自定义' },
      output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en' },
      length: { type: 'string', default: 'medium', description: '篇幅 short/medium/long' },
      extra_prompt: { type: 'string', default: '', description: '附加要求' },
      anima3_enhance: { type: 'boolean', default: false, description: 'Anima3 增强' },
      quality_prompt_enabled: { type: 'boolean', default: false, description: '启用质量词前缀' },
      quality_prompt_prefix: { type: 'string', default: '', description: '自定义质量词前缀' },
    },
    output: {
      schema: { type: 'string', description: '反推提示词正文' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: ReverseArgs, exec: ToolRunContext) {
      const desc = String(args.image_description || '').trim()
      const profile = findProfileById(String(args.profile || 'pe_reverse_descriptive').trim())
      if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_reverse_descriptive')}`)
      const reverseResult = resolveReverse(profile, {
        caption_lang: String(args.output_lang || 'zh'),
        len: String(args.length || 'medium'),
        media_target: 'image',
        extra_prompt: String(args.extra_prompt || ''),
        anima3_enhance: args.anima3_enhance === true,
      })
      const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail]
        .filter(Boolean).join('\n')
      const { provider, model } = resolveRoute(exec as ExecLike, config)
      const { text: raw } = await complete(ctx, {
        provider, model,
        system: reverseResult.system,
        user: user || desc,
        maxTokens: 512,
        temperature: config.temperature,
        signal: exec.signal,
      })
      const sanitized = sanitizeFinalCaption(raw, {
        type: reverseResult.captionType,
        caption_lang: String(args.output_lang || 'zh'),
        len: String(args.length || 'medium'),
        anima3_enhance: args.anima3_enhance === true,
        quality_prompt_enabled: args.quality_prompt_enabled === true,
        quality_prompt_prefix: String(args.quality_prompt_prefix || ''),
      })
      return sanitized
    },
  })
}
```

> `image_description` 必填校验：先不在此抛错（图片路径 Task 6 会合并"两者其一"语义）；当前文本路径若两者皆空，`user` 为空 → complete 收到空 user。修正：Task 6 统一校验。

- [ ] **Step 4: 修正必填校验并跑测试通过**

在 `execute` 顶部加：

```ts
const images = await collectRecentImages(exec)   // Task 6 实现；当前返回 []
if (!desc && images.length === 0) throw new Error('image_description is required, or attach an image to the session')
```

Task 5 暂以 `collectRecentImages` 占位返回 `[]`（Task 6 实现），测试断言"空输入抛错"通过。

Run: `npx vitest run tests/plugin/reverse.test.ts` → Expected: PASS（4 用例）

- [ ] **Step 5: 验证闸门**

`npm run build` 零错误 + reverse.test.ts 全绿；`sanitizeFinalCaption` 已被调用（测试 2 断言通过）。

---

### Task 6: prompt_reverse 图片路径（D3）

**Files:**
- Modify: `src/tools/prompt-reverse.ts`（增量：collectRecentImages + 视觉能力校验 + image block 并入 messages）
- Modify: `src/llm/complete.ts`（增量：支持 messages 传入图片 block 的变体 `completeWithBlocks`）
- Create: `tests/plugin/reverse-image.test.ts`

**Interfaces:**
- Consumes: `exec.agent.session.events`（'user/message' 事件含 `ImageBlock`）；`ctx.llm.resolveModelInfo(provider, model, signal)` → `{ inputModalities?: ModelModality[] }`（dsh-llm）
- Produces: `completeWithBlocks(ctx, opts & { blocks?: ContentBlock[] })`；collectRecentImages 逻辑（反向找最近 'user/message' 事件中最后一个 `type:'image'` block）

- [ ] **Step 1: 创建 `tests/plugin/reverse-image.test.ts`（先失败）**

```ts
import { describe, expect, it } from 'vitest'
import { registerReverseTool } from '../../src/tools/prompt-reverse.js'
import { stubCtx, textStream, runTool, stubExec } from './helpers.js'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

const imageBlock: ImageBlock = { type: 'image', attachment: { kind: 'file', id: 'att-1' } as any }

function sessionEvents(image?: ImageBlock): unknown[] {
  return [{ type: 'user/message' as const, data: { role: 'user', content: image ? [image] : [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, id: 'm1' } }]
}

describe('prompt_reverse (image path)', () => {
  it('uses the latest session image block when text is absent', async () => {
    const ctx = stubCtx({ stream: textStream('caption from image') })
    ctx.llm = { ...ctx.llm, resolveModelInfo: async () => ({ provider: 'deepseek', model: 'm', inputModalities: ['text', 'image'] }) }
    const def = registerReverseTool(ctx as any, { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 })
    const v = await runTool(ctx, def, {}, stubExec({ events: sessionEvents(imageBlock) }))
    expect(ctx.llm.calls.length).toBe(1)
    expect(ctx.llm.calls[0].messages[0].content).toContainEqual(imageBlock)
    expect(String(v)).toBe('caption from image')
  })

  it('rejects with guidance when the current model has no image modality', async () => {
    const ctx = stubCtx({ stream: textStream('x') })
    ctx.llm = { ...ctx.llm, resolveModelInfo: async () => ({ provider: 'deepseek', model: 'chat', inputModalities: ['text'] }) }
    const def = registerReverseTool(ctx as any, { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 })
    await expect(runTool(ctx, def, {}, stubExec({ events: sessionEvents(imageBlock) }))).rejects.toThrow(/Settings→Models|支持图片输入/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/reverse-image.test.ts` → Expected: FAIL

- [ ] **Step 3: 实现图片收集与校验（修改 prompt-reverse.ts）**

```ts
import type { ContentBlock, ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'

async function collectRecentImages(exec: ToolRunContext): Promise<ImageBlock[]> {
  const events = (exec.agent as any)?.session?.events
  if (!Array.isArray(events)) return []
  const images: ImageBlock[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type !== 'user/message') continue
    const msg = ev.data as UserMessage
    if (!Array.isArray(msg?.content)) continue
    for (const block of msg.content) if (block.type === 'image') images.push(block as ImageBlock)
    if (images.length > 0) return images   // 最近一个 user/message 中的全部图片
  }
  return images
}
```

在 `execute` 中替换 `const images = await collectRecentImages(exec)` 为真实实现，并加视觉校验与消息组装：

```ts
const images = await collectRecentImages(exec)
if (!desc && images.length === 0) throw new Error('image_description is required, or attach an image to the session')
const { provider, model } = resolveRoute(exec as ExecLike, config)
const blocks: ContentBlock[] = [...images.map((b) => ({ ...b })), ...(desc ? [{ type: 'text' as const, text: desc }] : [])]
if (images.length > 0) {
  const info = await (ctx.llm as any).resolveModelInfo?.(provider, model, exec.signal)
  if (!info || !info.inputModalities?.includes('image')) {
    throw new Error(`当前模型 ${model} 不支持图片输入，请在 Web UI Settings→Models 切换到支持图片输入的模型（如 deepseek-v4-flash-vision-exp），或在参数中提供 image_description 文本描述`)
  }
}
const { text: raw } = await completeWithBlocks(ctx, { provider, model, system: reverseResult.system, user: user || desc, blocks, maxTokens: 512, temperature: config.temperature, signal: exec.signal })
```

- [ ] **Step 4: 扩展 `src/llm/complete.ts`（completeWithBlocks）**

```ts
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export interface CompleteWithBlocksOptions extends Omit<CompleteOptions, 'user'> {
  blocks: ContentBlock[]
}

export async function completeWithBlocks(ctx: Context, opts: CompleteWithBlocksOptions) {
  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({
    provider: opts.provider,
    model: opts.model,
    system: opts.system,
    messages: [createUserMessage({ content: opts.blocks, source: { kind: 'plugin', plugin: 'prompt-master' } })],
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
  } satisfies GenerateOptions)
  for await (const chunk of stream) assembler.push(chunk)
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    const failure = assembler.finish.failure
    const err = new Error(failure.message) as Error & { code?: string }
    err.code = failure.code
    throw err
  }
  const blocks = assembler.blocks()
  const text = blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text.trim()).join('\n')
  return { text, usage: assembler.usage, finish: assembler.finish }
}
```

> 重构建议：抽出共享的 `runStream(ctx, opts)` 内部函数供 `complete` 与 `completeWithBlocks` 复用（两者仅 messages 组装不同）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/plugin/reverse-image.test.ts tests/plugin/complete.test.ts`
Expected: 全部 PASS（含图片复用断言、无视觉能力报错文案断言）。

- [ ] **Step 6: 验证闸门**

`npm run build` 零错误 + reverse-image / complete 测试全绿。

---

### Task 7: minimax_scenario 工具化

**Files:**
- Rewrite: `src/tools/minimax-scenario.ts`
- Create: `tests/plugin/minimax.test.ts`

**Interfaces:**
- Consumes: `listScenarios()` / `getScenarioById(id)` / `resolveMinimaxScenarioExpand(profile, {outputLang, minimaxForm})`（`resolver/minimax/index.js` 已有）
- Produces: `registerMinimaxTool(ctx, config): ToolDefinition` —— name=`minimax_scenario`；空 `scenario_id` 返回场景列表 JSON；dry_run 不调 LLM；返回 `{prompt, sections, scenario, budget}` JSON 字符串（stage 表 t2va=1200/i2va=1500/fl2va=1700/l2va=1700/ref2va=2400，char_limit=7000）

- [ ] **Step 1: 创建 `tests/plugin/minimax.test.ts`（先失败）**

```ts
import { describe, expect, it } from 'vitest'
import { registerMinimaxTool } from '../../src/tools/minimax-scenario.js'
import { stubCtx, textStream, runTool } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }

describe('minimax_scenario', () => {
  it('lists scenarios when scenario_id is empty', async () => {
    const ctx = stubCtx()
    const v = JSON.parse(String(await runTool(ctx, registerMinimaxTool(ctx as any, cfg), {})))
    expect(v.scenarios.length).toBeGreaterThan(0)
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('errors clearly on unknown scenario', async () => {
    await expect(runTool(stubCtx(), registerMinimaxTool(stubCtx() as any, cfg), { scenario_id: 'nope' })).rejects.toThrow(/Scenario not found/)
  })

  it('dry_run returns budget without calling llm', async () => {
    const ctx = stubCtx()
    const v = JSON.parse(String(await runTool(ctx, registerMinimaxTool(ctx as any, cfg), { scenario_id: 'full_reference', dry_run: true })))
    expect(v.budget.char_limit).toBe(7000)
    expect(v.budget.text_tokens).toBe(2400)
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('non-dry-run returns prompt + sections + budget with usage-derived tokens', async () => {
    const ctx = stubCtx({ stream: textStream('主体定义: cat\n摘要: ...\n详细描述: ...', { inputTokens: 3, outputTokens: 120 }) })
    const v = JSON.parse(String(await runTool(ctx, registerMinimaxTool(ctx as any, cfg), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })))
    expect(v.sections['主体定义']).toContain('cat')
    expect(v.budget.text_tokens).toBe(120)
    expect(v.budget.over).toBe(false)
  })
})
```

> 需确认 `full_reference` 是 catalog 中的真实 scenario id（Task 7 执行时先 `Get-Content src/resolver/minimax/catalog.ts | Select-String 'id:'` 取一个真实 id，如与示例不同则替换测试中的 id）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/minimax.test.ts` → Expected: FAIL

- [ ] **Step 3: 重写 `src/tools/minimax-scenario.ts`**

```ts
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { listScenarios, getScenarioById, resolveMinimaxScenarioExpand } from '../resolver/minimax/index.js'
import { countChars } from '../utils/length.js'
import { complete } from '../llm/complete.js'
import { resolveRoute, type ExecLike } from '../llm/route.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

const STAGE_BUDGETS: Record<string, { text_tokens: number; char_limit: number }> = {
  t2va: { text_tokens: 1200, char_limit: 7000 },
  i2va: { text_tokens: 1500, char_limit: 7000 },
  fl2va: { text_tokens: 1700, char_limit: 7000 },
  l2va: { text_tokens: 1700, char_limit: 7000 },
  ref2va: { text_tokens: 2400, char_limit: 7000 },
}

function pickStage(outputMode: string, scenarioId: string): string {
  if (outputMode === 'full_reference' || outputMode === 'director_segments') {
    return scenarioId === 'full_reference' ? 'ref2va' : 't2va'
  }
  return 't2va'
}

function splitSections(prompt: string, outputMode: string): Record<string, string> {
  if (outputMode !== 'full_reference') return { full: prompt }
  const sections: Record<string, string> = {}
  const sectionRegex = /(主体定义:|摘要:|保留分析:|详细描述:|整体声景:|非叙事配乐:)/g
  const parts = prompt.split(sectionRegex)
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i].replace(/:$/, '')] = (parts[i + 1] ?? '').trim()
  }
  return sections
}

export function registerMinimaxTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'minimax_scenario',
    description: '按 MiniMax H3 官方场景模板生成视频提示词。空 scenario_id 返回全部场景；dry_run 返回组装结果与 token/字符预算审计，不调用模型。',
    parameters: {
      scenario_id: { type: 'string', description: '场景 id（如 full_reference；留空返回场景列表）', default: '' },
      form_fields: { type: 'object', description: '场景表单字段（随场景而异）', default: {} },
      output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en/ja' },
      dry_run: { type: 'boolean', default: false, description: '只返回组装+审计结果' },
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串：{prompt, sections, scenario, budget, dry_run?}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { scenario_id?: string; form_fields?: Record<string, unknown>; output_lang?: string; dry_run?: boolean }, exec: ToolRunContext) {
      const scenarioId = String(args.scenario_id || '').trim()
      if (!scenarioId) return JSON.stringify({ scenarios: listScenarios(), hint: '请指定 scenario_id 选择一个场景' })
      const scenario = getScenarioById(scenarioId)
      if (!scenario) throw new Error(`Scenario not found: ${scenarioId}`)
      const language = String(args.output_lang || 'zh')
      const expanded = resolveMinimaxScenarioExpand(
        { id: scenario.peId, minimaxScenarioId: scenario.id, kind: 'expand' },
        { outputLang: language, minimaxForm: { form_fields: args.form_fields || {}, output_lang: language } },
      )
      if (!expanded) throw new Error('Failed to assemble scenario prompt')
      const stageKey = pickStage(scenario.outputMode || 'full_reference', scenario.id)
      const budgetCfg = STAGE_BUDGETS[stageKey] || STAGE_BUDGETS.t2va
      const assembleBudget = () => {
        const char_count = countChars(args.dry_run ? expanded.user : '')
        return { text_tokens: budgetCfg.text_tokens, char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit }
      }
      if (args.dry_run) {
        return JSON.stringify({
          prompt: expanded.user,
          sections: splitSections(expanded.user, scenario.outputMode || 'full_reference'),
          scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
          budget: assembleBudget(),
          dry_run: true,
        })
      }
      const { provider, model } = resolveRoute(exec as ExecLike, config)
      const { text, usage } = await complete(ctx, {
        provider, model, system: expanded.system, user: expanded.user,
        maxTokens: expanded.maxTokens, temperature: config.temperature, signal: exec.signal,
      })
      const char_count = countChars(text)
      return JSON.stringify({
        prompt: text,
        sections: splitSections(text, scenario.outputMode || 'full_reference'),
        scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
        budget: {
          text_tokens: usage?.outputTokens || budgetCfg.text_tokens,
          char_count, char_limit: budgetCfg.char_limit, over: char_count > budgetCfg.char_limit,
        },
      })
    },
  })
}
```

- [ ] **Step 4: 跑测试确认通过（必要时按真实 scenario id 校正测试）**

Run: `npx vitest run tests/plugin/minimax.test.ts` → Expected: PASS（4 用例）

- [ ] **Step 5: 验证闸门**

`npm run build` 零错误 + minimax.test.ts 全绿。

---

### Task 8: profile_list 工具化（五动作 + settings scope）

**Files:**
- Rewrite: `src/tools/profile-list.ts`
- Create: `tests/plugin/profile-list.test.ts`

**Interfaces:**
- Consumes: `getDefaultBuiltinProfiles` / `filterProfilesByKind` / `searchProfiles` / `clearProfileCache`（`resolver/profiles/index.js` 已有）；`getTaxonomyMeta`（`resolver/taxonomy.js` 已有）；settings scope（duck 形状 `{get/update/replace}`，Task 9/10 接真实 `ctx.settings.register`）
- Produces: `registerProfileListTool(ctx, config, deps: { scope: ProfileScope }): ToolDefinition` —— name=`profile_list`，action=list|search|get|save|delete

- [ ] **Step 1: 创建 `tests/plugin/profile-list.test.ts`（先失败）**

```ts
import { describe, expect, it, vi } from 'vitest'
import { registerProfileListTool } from '../../src/tools/profile-list.js'
import { stubCtx, runTool } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }

function makeScope() {
  let store: Record<string, string> = {}
  return {
    store,
    scope: {
      get: () => store,
      update: async (p: object) => { store = { ...store, ...(p as any).customProfiles } },
      replace: async (s: object) => { store = (s as any).customProfiles ?? {} },
    },
  }
}

describe('profile_list', () => {
  it('lists builtin profiles + taxonomy (no llm)', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list' })))
    expect(v.profiles.length).toBeGreaterThan(0)
    expect(v.taxonomy).toBeTruthy()
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('filters by kind and query', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list', kind: 'reverse' })))
    expect(v.profiles.every((p: any) => p.kind === 'reverse')).toBe(true)
  })

  it('saves a custom profile via scope then clears cache', async () => {
    const ctx = stubCtx()
    const { scope, store } = makeScope()
    const spy = vi.spyOn(await import('../../src/resolver/profiles/index.js'), 'clearProfileCache')
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'save', id: 'my_prof', profile: { name: 'My', kind: 'expand' } })))
    expect(JSON.parse(store['my_prof']).builtin).toBe(false)
    expect(spy).toHaveBeenCalled()
  })

  it('rejects deleting builtin profiles', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    await expect(runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'delete', id: 'pe_expand_natural' })).rejects.toThrow(/内置/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/profile-list.test.ts` → Expected: FAIL

- [ ] **Step 3: 重写 `src/tools/profile-list.ts`**

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getDefaultBuiltinProfiles, filterProfilesByKind, searchProfiles, clearProfileCache } from '../resolver/profiles/index.js'
import { getTaxonomyMeta } from '../resolver/taxonomy.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface ProfileScope {
  get(): Record<string, string>
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

export function registerProfileListTool(_ctx: Context, _config: Config, deps: { scope: ProfileScope }) {
  const { scope } = deps
  return defineTool({
    name: 'profile_list',
    description: '查询/保存/删除提示词 profile（内置 + 自定义）。list/search 查询，get 单查，save/delete 管理自定义 profile。',
    parameters: {
      action: { type: 'string', default: 'list', description: 'list|search|get|save|delete' },
      kind: { type: 'string', default: '', description: 'list/search 时按 kind 过滤：expand/reverse/minimax' },
      query: { type: 'string', default: '', description: 'list/search 时按关键字搜索' },
      id: { type: 'string', default: '', description: 'get/save/delete 的目标 profile id' },
      profile: { type: 'object', description: 'save 时要保存的 profile 对象（将强制 id 并在保存为 builtin:false）', default: {} },
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { action?: string; kind?: string; query?: string; id?: string; profile?: Record<string, unknown> }) {
      const action = String(args.action || 'list').trim()
      if (action === 'list' || action === 'search') {
        const kind = String(args.kind || '').trim()
        const query = String(args.query || '').trim()
        let profiles = getDefaultBuiltinProfiles()
        if (kind) profiles = filterProfilesByKind(kind)
        if (query) profiles = searchProfiles(query)
        return JSON.stringify({
          profiles: profiles.map((p) => ({ id: p.id, name: p.name, category: p.category, description: p.description, kind: p.kind, outputFormat: p.outputFormat, tags: p.tags })),
          taxonomy: getTaxonomyMeta(),
        })
      }
      if (action === 'get') {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for get action')
        const current = scope.get()
        if (current[id]) return JSON.stringify({ profile: JSON.parse(current[id]), custom: true })
        const p = getDefaultBuiltinProfiles().find((x) => x.id === id)
        if (!p) throw new Error(`Profile not found: ${id}`)
        return JSON.stringify({ profile: p, custom: false })
      }
      if (action === 'save') {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for save action')
        if (!args.profile || typeof args.profile !== 'object') throw new Error('profile object is required')
        const profileWithId = { ...args.profile, id, builtin: false }
        const current = scope.get()
        await scope.update({ customProfiles: { ...current, [id]: JSON.stringify(profileWithId) } })
        clearProfileCache()
        return JSON.stringify({ id, message: `Profile ${id} 已保存` })
      }
      if (action === 'delete') {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for delete action')
        if (getDefaultBuiltinProfiles().find((p) => p.id === id && p.builtin)) {
          throw new Error(`${id} 是内置 profile，不能删除`)
        }
        const current = scope.get()
        const next = { ...current }
        delete next[id]
        await scope.replace({ customProfiles: next })
        clearProfileCache()
        return JSON.stringify({ id, message: `Profile ${id} 已删除` })
      }
      throw new Error(`Unknown action: ${action}`)
    },
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/plugin/profile-list.test.ts` → Expected: PASS（4 用例）

- [ ] **Step 5: 验证闸门**

`npm run build` 零错误 + profile-list.test.ts 全绿。

---

### Task 9: resolver 注入源改造（解除 DB 耦合）

**Files:**
- Create: `src/resolver/profiles/source.ts`
- Modify: `src/resolver/profiles/index.ts`（16 行 import + `safeListCustomProfiles` 实现）
- Create: `tests/resolver/source.test.ts`

**Interfaces:**
- Consumes: 现状 `safeListCustomProfiles(): {id, profileJson}[]`
- Produces: `setCustomProfileSource(fn: (() => {id, profileJson}[]) | null)` / `getCustomProfileSource(): () => {id, profileJson}[]`；`safeListCustomProfiles()` 语义不变（未注入返回 `[]`，异常返回 `[]`）

- [ ] **Step 1: 创建 `tests/resolver/source.test.ts`（先失败）**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { setCustomProfileSource, getCustomProfileSource } from '../../src/resolver/profiles/source.js'
import { getDefaultBuiltinProfiles, clearProfileCache } from '../../src/resolver/profiles/index.js'

beforeEach(() => setCustomProfileSource(null))

describe('custom profile source injection', () => {
  it('defaults to empty list', () => {
    clearProfileCache()
    expect(getDefaultBuiltinProfiles().length).toBeGreaterThan(0)
    expect(getDefaultBuiltinProfiles().filter((p) => p.id === 'my_custom')).toHaveLength(0)
  })

  it('merges injected custom profiles into the builtin registry', () => {
    setCustomProfileSource(() => [{ id: 'my_custom', profileJson: JSON.stringify({ id: 'my_custom', name: 'My', kind: 'expand', builtin: false, category: '自定义', description: 'x', tags: [], subjectDomains: [], enabled: true, outputFormat: 'prose' }) }])
    clearProfileCache()
    const p = getDefaultBuiltinProfiles().find((x) => x.id === 'my_custom')
    expect(p?.name).toBe('My')
  })

  it('tolerates a throwing source (returns [])', () => {
    const broken = getCustomProfileSource()
    expect(broken()).toEqual([])
    setCustomProfileSource(() => { throw new Error('db gone') })
    clearProfileCache()
    expect(getDefaultBuiltinProfiles().length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/resolver/source.test.ts` → Expected: FAIL（Cannot find module source.js；并因 source 未注入而 register 行为不符）

- [ ] **Step 3: 创建 `src/resolver/profiles/source.ts`**

```ts
export interface CustomProfileRecord { id: string; profileJson: string }

type CustomProfileSource = () => CustomProfileRecord[]

let injected: CustomProfileSource = () => []

export function setCustomProfileSource(fn: CustomProfileSource | null): void {
  injected = fn ?? (() => [])
}

export function getCustomProfileSource(): CustomProfileSource {
  return injected
}
```

- [ ] **Step 4: 修改 `src/resolver/profiles/index.ts`**

删除 `import { listCustomProfiles } from '../../db/index.js'`，改为：

```ts
import { getCustomProfileSource } from './source.js'
```

并将 `safeListCustomProfiles` 改为：

```ts
/** 从注入源读自定义 profile；未注入或异常时返回 []（与 DB 不可用时行为一致） */
function safeListCustomProfiles(): any[] {
  try {
    return getCustomProfileSource()()
  } catch {
    return []
  }
}
```

- [ ] **Step 5: 跑测试确认通过（含既有 resolver 测试全部回归）**

Run: `npm run build && npx vitest run tests/resolver/`
Expected: source.test.ts 3 用例 + 既有 expand/reverse/length/tagLineSanitize 全部 PASS（扩写/反推能力保全在此闸门）

- [ ] **Step 6: 验证闸门**

resolver 全部测试绿：证明注入源改造未破坏引擎、能力保全成立。

---

### Task 10: 插件真体（4 工具 + settings + 注入源）

**Files:**
- Rewrite: `src/plugin/index.ts`（hello → 4 工具 + D2 settings 注册 + 注入源接线）
- Modify: `tests/plugin/registry.test.ts`（hello 断言 → 4 工具断言）

**Interfaces:**
- Consumes: 4 个 `register<X>Tool(ctx, config[, deps])`（Task 4/5/6/7/8）；`settingsNamespace` / `ctx.settings.register`（dsh-settings）；`setCustomProfileSource`（Task 9）
- Produces: 可挂载的正式插件入口；`ctx.settings` 命名空间 `prompt-master-custom-profiles`（schema `{customProfiles: Record<string,string>}`）；注入源 = settings 内容

- [ ] **Step 1: 重写 `tests/plugin/registry.test.ts`（先失败）**

```ts
import { describe, expect, it } from 'vitest'
import { apply } from '../../src/plugin/index.js'

function stubCtx() {
  const registered: Array<{ name: string; parameters: Record<string, unknown>; output: { schema: unknown } }> = []
  const ctx: any = {
    tools: { register(def: any) { registered.push({ name: def.name, parameters: def.parameters, output: def.output }); return () => {} } },
    llm: { stream: async function* () {} },
    settings: {
      register(ns: string, schema: unknown) {
        expect(ns).toBe('prompt-master-custom-profiles')
        return { get: () => ({ customProfiles: {} }), update: async () => {}, replace: async () => {} }
      },
    },
    effect() {},
  }
  return { ctx, registered }
}

describe('plugin registration', () => {
  it('registers exactly the four tools with native names', () => {
    const { ctx, registered } = stubCtx()
    apply(ctx, { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 })
    const names = registered.map((d) => d.name).sort()
    expect(names).toEqual(['minimax_scenario', 'profile_list', 'prompt_expand', 'prompt_reverse'])
  })

  it('all outputs declare a string schema', () => {
    const { ctx, registered } = stubCtx()
    apply(ctx, { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 })
    for (const d of registered) expect(d.output.schema).toMatchObject({ type: 'string' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/registry.test.ts` → Expected: FAIL（name 仍为 hello / 未注册 4 工具）

- [ ] **Step 3: 重写 `src/plugin/index.ts`**

```ts
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { registerExpandTool } from '../tools/prompt-expand.js'
import { registerReverseTool } from '../tools/prompt-reverse.js'
import { registerMinimaxTool } from '../tools/minimax-scenario.js'
import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
import { setCustomProfileSource } from '../resolver/profiles/source.js'
import { Config, type Config as ConfigShape } from './config.js'

export const name = 'prompt-master'
export const inject = ['tools', 'llm', 'settings']
export { Config }

export function apply(ctx: Context, config: ConfigShape) {
  const ns = settingsNamespace('prompt-master-custom-profiles')
  const scope = ctx.settings.register(ns, z.object({
    customProfiles: z.dict(z.string(), z.string()).default({}),
  }))
  setCustomProfileSource(() => Object.entries(scope.get().customProfiles ?? {}).map(([id, profileJson]) => ({ id, profileJson })))
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
    disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
    disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: scope as unknown as ProfileScope })))
    return () => { for (const d of disposers) d() }
  }, 'prompt-master.tools')
}
```

> `ctx.settings.register` 返回的 `SettingsScope` 与 `ProfileScope` 形状兼容（get/update/replace），用 `as unknown as` 桥接。settings 注册发生在 apply 顶层（不在 effect 内），与 spec §7.3 注释一致。

- [ ] **Step 4: 跑测试确认通过（registry + 全部插件测试）**

Run: `npm run build && npx vitest run tests/plugin/`
Expected: registry 2 用例 + complete/expand/reverse/reverse-image/minimax/profile-list 全部 PASS

- [ ] **Step 5: 验证闸门**

`npm run build` 零错误；tests/plugin 全绿；依赖树检查无 MCP 层引用（旧 handler 仍在 src/tools，但插件只 import 新工具文件——注意旧文件仍被 src/index.ts 引用，Task 11 统一清理）。

---

### Task 11: P3 清理（删旧层 + 依赖收敛）

**Files:**
- Delete: `src/index.ts`、`src/provider/*`（3 文件）、`src/db/*`（3 文件）、`src/config/*`（3 文件）、`src/tools/provider-config.ts`、`src/tools/index.ts`、`src/utils/errors.ts`
- Delete: `tests/handlers.test.ts`、`tests/smoke.test.ts`、`tests/save-key.test.ts`、`tests/provider/`（整目录）
- Modify: `package.json`（dependencies 清空；scripts 去 start）
- Modify: `tests/plugin/profile-list.test.ts` 中 `vi.spyOn(await import(...))` 若因 ESM 命名导出受限则改断言方式（见 Step 3 注）

**Interfaces:**
- Consumes: Task 1-10 全部产物
- Produces: 干净的单插件包：依赖树只剩 resolver 纯函数 + DSH 全家桶；`npm test` 全绿（能力保全验收）

- [ ] **Step 1: 删除旧层文件**

```powershell
Remove-Item src/index.ts, src/tools/provider-config.ts, src/tools/index.ts, src/utils/errors.ts -Force
Remove-Item src/provider, src/db, src/config -Recurse -Force
Remove-Item tests/handlers.test.ts, tests/smoke.test.ts, tests/save-key.test.ts -Force
Remove-Item tests/provider -Recurse -Force
```

- [ ] **Step 2: 修改 package.json（清空 dependencies，去 start）**

```jsonc
{
  "dependencies": {},
  "scripts": { "build": "tsc", "test": "vitest run", "test:watch": "vitest", "dev": "vitest" }
}
```

然后 Run: `npm install`（卸载 @modelcontextprotocol/sdk、sql.js、dotenv、yaml）

- [ ] **Step 3: 全量回归**

Run: `npm run build && npm test`
Expected: tsc 零错误；vitest 全绿（resolver 5 + plugin 若干）。若 profile-list.test.ts 的 `vi.spyOn(import(...).clearProfileCache)` 在 ESM 下报 "not configurable"，改为：

```ts
import * as profilesModule from '../../src/resolver/profiles/index.js'
const spy = vi.spyOn(profilesModule, 'clearProfileCache')
```

- [ ] **Step 4: 依赖树核验**

Run: `npm ls --depth=0`
Expected: 仅 devDependencies（DSH 全家桶 + typescript/vitest/tsx/@types/node），无 @modelcontextprotocol / sql.js / dotenv / yaml。

- [ ] **Step 5: 验证闸门（能力保全验收）**

- `npm test` 全绿 ⇒ spec §2 保全验收通过（resolver 测试原样通过 + 全部能力仍被工具触达）
- `npm ls --depth=0` 干净
- 记录到任务记录。

---

### Task 12: 真实 DSH 联调验收（P1–P2 集成 + P4 图片反推）

**Files:**
- Modify: `~/.dsh/cordis.patch.yml`（如 Task 2 已 insert 则无需改）
- 手动验收清单（无新代码）

**Interfaces:**
- Consumes: Task 11 的成品插件包

- [ ] **Step 1: 更新挂载并重启**

```powershell
dsh plugin --profile web add D:\Projects\temp\prompt-master-mcp
# 确认 ~/.dsh/cordis.patch.yml 中 prompt-master insert 存在且 name 为 @prompt-master/dsh-plugin
# 重启 DSH Web，打开 http://127.0.0.1:3080 新会话
```

- [ ] **Step 2: P1 验收（prompt_expand）**

新会话中让模型调用 `prompt_expand`（如「把「夕阳下的赛博朋克城市」扩写成风格化提示词」）。Expected：返回扩写正文；dry_run 请求能返回组装 JSON 且不触发计费。

- [ ] **Step 3: P2 验收（reverse / minimax / profile_list）**

- `prompt_reverse`：文本反推（image_description）返回反推正文，无 Markdown 污染（sanitize 生效）
- `minimax_scenario`：`scenario_id=full_reference` + form_fields 返回 prompt/sections/budget；dry_run 不调模型
- `profile_list`：list 查内置；save 自定义 profile → 下次 `profile_list get` 可见；delete 生效
- 会话路由验证：在 Web UI Settings→Models 切换模型后，`prompt_expand` 应跟随新 route（spec §5.1）

- [ ] **Step 4: P4 验收（图片反推）**

1. Web UI Settings→Models 增加/切换到视觉模型（如 `deepseek-v4-flash-vision-exp`）
2. 会话中贴一张图，仅以「反推这张图的提示词」发起
3. Expected：`prompt_reverse` 自动取会话图片 → 返回反推提示词
4. 切回非视觉模型再贴图反推 → Expected：工具报错文案包含「Settings→Models 切换到支持图片输入的模型」

- [ ] **Step 5: 验证闸门**

联调清单 4/4 通过（P1/P2/P4 + 路由跟随）；附件、错误引导等均已实测。记录最终版本与验收结果。

---

## Self-Review 记录（执笔时已跑）

1. **Spec 覆盖**：spec §2 能力保全 → Task 9/11 闸门；§3 目录 → Task 1-11 文件处置表；§4 依赖 → Task 1/11；§5 封装 → Task 2/5/6；§6 工具契约 → Task 4/5/6/7/8（含三项契约校正）；§7 数据流 → Task 3/6/8/10；§8 错误处理 → 各工具 execute 抛错 + complete 转抛；§9 挂载 → Task 2/10/12；§10 测试 → 对应任务；§11 批次 → Task 1-12 映射；§12 风险 → Task 2（挂载实证）/Task 3（转抛）；§13 决策 → Task 4/8/10。
2. **占位符扫描**：无 TBD/TODO；Task 7 标注了「执行时以真实 scenario id 校正」是可用数据，非占位（代码已给校正路径）。
3. **类型一致性**：`register<X>Tool(ctx, config)` 签名在 Task 4-8 与 Task 10 一致；`CompleteOptions` / `resolveRoute` / `helpers.ts` 符号在 Task 3 定义、Task 4-7 消费，命名统一；`ProfileScope` 在 Task 8 定义、Task 10 `as unknown as` 桥接真实 SettingsScope。> **Ruling note (2026-08-27, after Task 6 review):** prompt_reverse image path messages blocks text block = user || desc (spec §6 authority: four-segment user concatenation); LLM calls go through completeWithBlocks for both paths.
