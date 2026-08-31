# prompt-master-dsh 原生插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（或 subagent-driven-development）逐任务实施。步骤用 `- [ ]` 勾选追踪。本仓库**非 git 仓库**，所有 commit 步骤替换为「记录变更到 docs/plans/TASK_TRACKING.md」。

**Goal:** 把 prompt-master-mcp 从自建 MCP Server 重构为 DSH 原生 Cordis 插件（`@prompt-master/dsh`），4 个工具直接注册进 `ctx.tools`，模型调用全部走 `ctx.llm.stream`，**仅挂载到 comfyui-chenxin 这个 agent-preset**。

**Architecture:** 插件 = `src/plugin/index.ts`（name/inject/apply/Config）+ `src/llm/complete.ts`（ctx.llm 封装）+ `src/tools/*.ts`（4 个 defineTool）+ 1:1 保留的 `src/resolver/**`（PE 引擎）与 `src/utils/length.ts`。删除 self-written provider/db/config/MCP 层。挂载：`~/.dsh/.agent-presets/comfyui-chenxin/agent.cordis.yml` 加一行本地路径插件（与该 preset 现有 `comfyui-loader: name: './loader.js'` 同模式），其他 preset 会话不加载。

**Tech Stack:** TypeScript strict ESM、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`（defineTool）、`@deepseek-ai/dsh-llm`（ctx.llm.stream / BlockAssembler / createUserMessage）、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-attachment`（类型）、vitest。

**Spec:** `docs/plan-b-native-plugin.md`（v1.0 正式 Spec——实施时先读它，本计划从 Spec 论证）

## Global Constraints

- TypeScript strict；ESM；import 一律带 `.js` 后缀（本项目既有惯例）。
- 编译与测试命令（Windows）：`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/typescript/bin/tsc`、`node node_modules/vitest/vitest.mjs run`（或 `npm test`）。
- 依赖版本钉死（peerDependencies）：`@deepseek-ai/cordis@^0.4.1`、`@deepseek-ai/dsh-tools@^0.1.1-rc.2`、`@deepseek-ai/dsh-llm@^0.1.1-rc.2`、`@deepseek-ai/dsh-settings@^0.1.1-rc.2`、`@deepseek-ai/dsh-attachment@^0.1.1-rc.2`、`@deepseek-ai/dsh-agent@^0.1.1-rc.2`、`@deepseek-ai/dsh-session@^0.1.1-rc.2`、`@deepseek-ai/schemastery@^3.18.1`。devDependencies 装同版本供类型。
- **禁止**：Electron/ee-core、`@modelcontextprotocol/sdk`、sql.js、dotenv、yaml、自写 HTTP provider（全部删除）。
- 引擎不变式：`src/resolver/**` 除「自定义 profile 源注入」外不做任何改动；不得引入对 db/provider/settings 的 import（注入通过 `src/resolver/profiles/index.ts` 的 setter，见 Task 2）。
- 工具公开名：`prompt_expand` / `prompt_reverse` / `minimax_scenario` / `profile_list`（原生名，无 `mcp__` 前缀）。
- resolver 测试（`tests/resolver/*`）全程必须保持通过——引擎回归的守门员。

---

### Task 1: 插件骨架与工程改造

**Files:**
- Modify: `package.json`（name、main、exports、peerDependencies、devDependencies、scripts）
- Modify: `tsconfig.json`（如需要，确认包含 `src/plugin/**`）
- Create: `src/plugin/config.ts`
- Create: `src/plugin/index.ts`
- Test: `tests/plugin/export-shape.test.ts`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `src/plugin/config.ts` → `export interface PluginConfig { defaultProvider: string; defaultModel: string; temperature: number }` 与 `export const PluginConfigSchema = z.object({...})`
  - `src/plugin/index.ts` → `export const name = 'prompt-master'`、`export const inject = ['tools', 'llm', 'settings']`、`export function apply(ctx: Context, config: PluginConfig): void`（暂时空实现，后续任务填充注册）
  - 类型 `import type { Context } from '@deepseek-ai/cordis'`

- [ ] **Step 1: 读现状确认基线**

确认 `git` 在此目录**不可用**（非仓库）；确认 `node node_modules/typescript/bin/tsc --noEmit` 当前退出码 0；确认 `node node_modules/vitest/vitest.mjs run` 能收集到 `tests/resolver/*` 的用例（沙箱 EPERM 属环境限制，代码正确性以 tsc + 等价脚本判断）。

- [ ] **Step 2: 写失败测试**

创建 `tests/plugin/export-shape.test.ts`：

```ts
// tests/plugin/export-shape.test.ts
import { describe, it, expect } from 'vitest'
import { name, inject, apply } from '../../src/plugin/index.js'
import { PluginConfigSchema } from '../../src/plugin/config.js'

describe('插件导出形状', () => {
  it('暴露 name / inject / apply（cordis 插件契约）', () => {
    expect(name).toBe('prompt-master')
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toContain('tools')
    expect(typeof apply).toBe('function')
  })

  it('Config schema 有默认值', () => {
    const cfg = PluginConfigSchema.defaults() as any
    expect(cfg.defaultProvider).toBe('deepseek')
    expect(cfg.defaultModel).toBe('deepseek-chat')
    expect(cfg.temperature).toBe(0.7)
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/export-shape.test.ts`
Expected: FAIL（`src/plugin/index.js` not found）

- [ ] **Step 4: 实现骨架**

创建 `src/plugin/config.ts`：

```ts
// src/plugin/config.ts — 插件配置（schemastery schema）
import { z } from '@deepseek-ai/schemastery'

export interface PluginConfig {
  defaultProvider: string
  defaultModel: string
  temperature: number
}

export const PluginConfigSchema = z.object({
  defaultProvider: z.string().default('deepseek'),
  defaultModel: z.string().default('deepseek-chat'),
  temperature: z.number().default(0.7),
})
```

创建 `src/plugin/index.ts`：

```ts
// src/plugin/index.ts — prompt-master-dsh 插件入口
// 模式参考 @deepseek-ai/dsh-mcp-client（name/inject/apply/Config）
import type { Context } from '@deepseek-ai/cordis'
import { PluginConfig, PluginConfigSchema } from './config.js'

export const name = 'prompt-master'
export const inject = ['tools', 'llm', 'settings']
export const Config = PluginConfigSchema

export function apply(ctx: Context, config: PluginConfig): void {
  // Task 4-8 在此注册 4 个工具；Task 7 在此注册 settings 命名空间并注入自定义 profile 源
}
```

- [ ] **Step 5: 安装 DSH 类型依赖**

Run: `bun add -d @deepseek-ai/cordis@^0.4.1 @deepseek-ai/dsh-tools@^0.1.1-rc.2 @deepseek-ai/dsh-llm@^0.1.1-rc.2 @deepseek-ai/dsh-settings@^0.1.1-rc.2 @deepseek-ai/dsh-attachment@^0.1.1-rc.2 @deepseek-ai/dsh-agent@^0.1.1-rc.2 @deepseek-ai/dsh-session@^0.1.1-rc.2`
（如本机 bun 不可用：`npm i -D` 同参数。这些包随 DSH 全家桶已有，装到项目 node_modules 供类型解析。）
Expected: 无报错；若某包版本解析失败，把该包从 devDependencies 移除并将类型改为 `any`（记入 TASK_TRACKING）。

- [ ] **Step 6: 运行测试验证通过**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/export-shape.test.ts`
Expected: PASS（2 个用例）
同时 `node node_modules/typescript/bin/tsc --noEmit` 退出码 0。
注意：若 tsc 对 DSH 包 `.d.ts` 内 `import ... from './x.ts'` 报错，在 tsconfig `compilerOptions` 增加 `"moduleResolution": "bundler"`（已设）并确认 `skipLibCheck: true`（已设）——两者已满足则不应报错。

- [ ] **Step 7: 记录变更**

向 `docs/plans/TASK_TRACKING.md` 追加 Round 4 说明：骨架完成、依赖锁定版本。

---

### Task 2: resolver 断除 db 耦合（自定义 profile 源注入）

**Files:**
- Modify: `src/resolver/profiles/index.ts`
- Test: `tests/resolver/profile-source.test.ts`

**Interfaces:**
- Consumes: 无（对 resolver 内部函数）
- Produces:
  - `src/resolver/profiles/index.ts` 新增导出：
    - `export type CustomProfileRecord = { id: string; profileJson: string }`
    - `export function setCustomProfileLoader(loader: () => CustomProfileRecord[]): void`
  - 保持既有导出不变：`getDefaultBuiltinProfiles()` / `clearProfileCache()` / `findProfileById` / `filterProfilesByKind` / `searchProfiles`

- [ ] **Step 1: 写失败测试**

创建 `tests/resolver/profile-source.test.ts`：

```ts
// tests/resolver/profile-source.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getDefaultBuiltinProfiles,
  setCustomProfileLoader,
  clearProfileCache,
  type CustomProfileRecord,
} from '../../src/resolver/profiles/index.js'

describe('自定义 profile 源注入', () => {
  beforeEach(() => {
    setCustomProfileLoader(() => [])
    clearProfileCache()
  })

  it('默认无自定义 profile（loaded 数量不受影响）', () => {
    const before = getDefaultBuiltinProfiles()
    expect(before.some(p => p.id === 'pe_custom_injected_test')).toBe(false)
  })

  it('注入 loader 后自定义 profile 出现在清单', () => {
    const rec: CustomProfileRecord = {
      id: 'pe_custom_injected_test',
      profileJson: JSON.stringify({
        id: 'pe_custom_injected_test', kind: 'expand', builtin: false,
        name: '注入测试', description: 't', enabled: true,
        outputFormat: 'prose', tags: [], subjectDomains: [],
        systemPrompt: '你是一个注入的自定义 profile。',
      }),
    }
    setCustomProfileLoader(() => [rec])
    clearProfileCache()
    const all = getDefaultBuiltinProfiles()
    const found = all.find(p => p.id === 'pe_custom_injected_test')
    expect(found).toBeTruthy()
    expect(found!.systemPrompt).toContain('注入的自定义 profile')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/resolver/profile-source.test.ts`
Expected: FAIL（`setCustomProfileLoader is not a function`）

- [ ] **Step 3: 实现注入**

在 `src/resolver/profiles/index.ts` 修改：

1. 删掉第 16 行 `import { listCustomProfiles } from '../../db/index.js';`
2. 新增类型与注入器（放在 `// ========== 主入口` 上方）：

```ts
// ========== 自定义 profile 源注入 ==========
// 原实现直接依赖 SQLite（../../db）。重构后由插件在 apply 时注入读取器
// （实现基于 ctx.settings）；未注入时返回空数组，与旧 try/catch 兜底行为一致。
export interface CustomProfileRecord {
  id: string
  profileJson: string
}

let customProfileLoader: () => CustomProfileRecord[] = () => []

export function setCustomProfileLoader(loader: () => CustomProfileRecord[]): void {
  customProfileLoader = loader
  clearProfileCache()
}
```

3. 把 `safeListCustomProfiles()` 实现替换为：

```ts
/** 读取自定义 profile（插件注入的源；未注入/不可用时返回空数组） */
function safeListCustomProfiles(): CustomProfileRecord[] {
  try {
    return customProfileLoader()
  } catch {
    return []
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node node_modules/vitest/vitest.mjs run tests/resolver/profile-source.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 回归既有 resolver 测试**

Run: `node node_modules/vitest/vitest.mjs run tests/resolver`
Expected: 全部 PASS（expand/reverse/length/tagLineSanitize/profile-source）

- [ ] **Step 6: 编译闸门**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: 退出码 0（此时 `src/tools/*` 与 `src/provider/*` 仍引用 db，tsc 可能因为这些暂时报错——**本任务仅保证 resolver 相关文件无错**；全量清零在 Task 9 统一收口，误报差异记录到 TASK_TRACKING）

---

### Task 3: LLM 调用封装 + 插件级测试基建

**Files:**
- Create: `src/llm/complete.ts`
- Create: `tests/plugin/helpers.ts`
- Test: `tests/plugin/complete.test.ts`

**Interfaces:**
- Consumes: `@deepseek-ai/dsh-llm`（BlockAssembler / createUserMessage / StreamChunk / FinishReason）
- Produces:
  - `src/llm/complete.ts`：
    - `export interface CompleteOptions { provider: string; model: string; system: string; user: string; maxTokens: number; temperature?: number; signal: AbortSignal }`
    - `export interface CompleteResult { text: string; usage?: TokenUsage; finish: FinishReason }`
    - `export async function complete(ctx: Context, opts: CompleteOptions): Promise<CompleteResult>`
  - `tests/plugin/helpers.ts`：
    - `export interface CapturedCall { options: any }`
    - `export function makeCtx(overrides?: { llmChunks?: StreamChunkLike[]; vision?: boolean }): { ctx: any; registered: any[]; llmCalls: any[] }`
    - `export function textStream(text: string, usage?: TokenUsage): AsyncIterable<StreamChunk>`（构造 text-delta→block-end→usage→finish 序列）

- [ ] **Step 1: 写失败测试（complete 正常流）**

创建 `tests/plugin/complete.test.ts`：

```ts
// tests/plugin/complete.test.ts
import { describe, it, expect } from 'vitest'
import { complete } from '../../src/llm/complete.js'
import { makeCtx, textStream } from './helpers.js'

describe('complete(ctx.llm 封装)', () => {
  it('把 system/user/maxTokens 正确传给 ctx.llm.stream，返回文本', async () => {
    const { ctx, llmCalls } = makeCtx({
      llmChunks: (opts: any) => textStream('扩写结果正文', { inputTokens: 10, outputTokens: 5 }),
    })
    const result = await complete(ctx, {
      provider: 'deepseek', model: 'deepseek-chat',
      system: 'SYS', user: 'USR', maxTokens: 512,
      signal: new AbortController().signal,
    })
    expect(llmCalls.length).toBe(1)
    expect(llmCalls[0].provider).toBe('deepseek')
    expect(llmCalls[0].model).toBe('deepseek-chat')
    expect(llmCalls[0].system).toBe('SYS')
    expect(llmCalls[0].maxTokens).toBe(512)
    expect(llmCalls[0].messages[0].content[0]).toEqual({ type: 'text', text: 'USR' })
    expect(result.text).toBe('扩写结果正文')
    expect(result.usage?.outputTokens).toBe(5)
  })

  it('finish=error 时抛错（保留 failure.message）', async () => {
    const { ctx } = makeCtx({
      llmChunks: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider 500', code: 'PROVIDER' } } }
      })(),
    })
    await expect(complete(ctx, {
      provider: 'p', model: 'm', system: '', user: '', maxTokens: 10,
      signal: new AbortController().signal,
    })).rejects.toThrow('provider 500')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/complete.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 helpers**

创建 `tests/plugin/helpers.ts`：

```ts
// tests/plugin/helpers.ts — cordis ctx stub（不启动真 DSH）
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

export interface ScopeStub {
  get(): any
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
  watch(): () => void
}

export function makeScopeStub(initial: any = {}): ScopeStub & { value: any } {
  const box = { value: structuredClone(initial) }
  return {
    ...box,
    get: () => structuredClone(box.value),
    update: async (patch: object) => { box.value = { ...box.value, ...(patch as any) } },
    replace: async (section: object) => { box.value = structuredClone(section) },
    watch: () => () => {},
  }
}

export function textStream(text: string, usage?: TokenUsage): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

export function makeCtx(overrides: {
  llmChunks?: (opts: any) => AsyncIterable<StreamChunk>
  vision?: boolean
} = {}) {
  const registered: any[] = []
  const llmCalls: any[] = []
  const scopes = new Map<string, ReturnType<typeof makeScopeStub>>()
  const ctx = {
    tools: {
      register: (def: any) => { registered.push(def); return () => {} },
    },
    llm: {
      stream: (options: any) => {
        llmCalls.push(options)
        const chunks = overrides.llmChunks ?? ((o: any) => textStream('ok'))
        return chunks(options)
      },
      resolveModelInfo: async () => ({
        provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat',
        inputModalities: overrides.vision === false ? ['text'] : ['text', 'image'],
      }),
    },
    settings: {
      register: (ns: string, _schema: unknown) => {
        if (!scopes.has(ns)) scopes.set(ns, makeScopeStub({ customProfiles: {} }))
        return scopes.get(ns)!
      },
    },
    logger: { warn() {}, error() {}, info() {} },
    effect(): void {},
    get(): undefined { return undefined },
  }
  return { ctx, registered, llmCalls, scopes }
}
```

- [ ] **Step 4: 实现 complete**

创建 `src/llm/complete.ts`：

```ts
// src/llm/complete.ts — 一次性 completion 封装（DSH Agent Runtime 原生模型调用）
import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  type FinishReason,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

export interface CompleteOptions {
  provider: string
  model: string
  system: string
  user: string
  maxTokens: number
  temperature?: number
  signal: AbortSignal
}

export interface CompleteResult {
  text: string
  usage?: TokenUsage
  finish: FinishReason
}

export async function complete(ctx: Context, opts: CompleteOptions): Promise<CompleteResult> {
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

  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    // 转抛：让工具走 isError 路径，模型能看见失败原因
    throw new Error(finish.failure.message || `LLM ${finish.kind}`)
  }

  const text = assembler.blocks()
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text.trim())
    .join('\n')
  return { text, usage: assembler.usage, finish }
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/complete.test.ts`
Expected: PASS（2 个用例）；`tsc --noEmit` 退出码 0（若 DSH 类型包解析报错，按 Task 1 Step 6 的处理记录）

---

### Task 4: prompt_expand 工具（defineTool + route 解析 + dry_run）

**Files:**
- Create: `src/plugin/route.ts`
- Create: `src/tools/prompt-expand.ts`（整体重写）
- Modify: `src/plugin/index.ts`（apply 里调用注册）
- Test: `tests/plugin/tool-expand.test.ts`

**Interfaces:**
- Consumes: `complete()`（Task 3）、`resolveExpand()`（`src/resolver/index.js`，已有）、`findProfileById()`（`src/resolver/profiles/index.js`，已有）、`PluginConfig`（Task 1）
- Produces:
  - `src/plugin/route.ts`：
    - `export interface RouteInfo { provider: string; model: string }`
    - `export function resolveRoute(exec: { agent?: { options?: { provider?: string; model?: string }; session?: any } }, config: PluginConfig): RouteInfo`
  - `src/tools/prompt-expand.ts`：
    - `export function registerExpandTool(ctx: Context, config: PluginConfig): () => void`（返回 register 的 disposer）

- [ ] **Step 1: 写失败测试**

创建 `tests/plugin/tool-expand.test.ts`：

```ts
// tests/plugin/tool-expand.test.ts
import { describe, it, expect } from 'vitest'
import { registerExpandTool } from '../../src/tools/prompt-expand.js'
import { makeCtx, textStream } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }

function execAgent() {
  return { agent: { options: { provider: 'deepseek', model: 'deepseek-chat' }, session: {} } }
}

describe('prompt_expand 工具', () => {
  it('注册名为 prompt_expand，参数 schema 正确', () => {
    const { ctx, registered } = makeCtx()
    registerExpandTool(ctx, cfg)
    const def = registered.find((d) => d.name === 'prompt_expand')
    expect(def).toBeTruthy()
    expect(def.description).toContain('扩写')
    expect(def.parameters.text.required).toBe(true)
    expect(def.parameters.profile).toBeTruthy()
  })

  it('dry_run 不调 LLM，直接返回组装结果', async () => {
    const { ctx, llmCalls } = makeCtx()
    registerExpandTool(ctx, cfg)
    const def = registered.find((d) => d.name === 'prompt_expand')
    const value = await def.execute(
      { text: 'a cat on windowsill', profile: 'pe_expand_natural', output_lang: 'zh', length: 'short', dry_run: true },
      { signal: new AbortController().signal, agent: execAgent().agent },
    )
    expect(llmCalls.length).toBe(0)
    expect(value).toContain('a cat on windowsill')
  })

  it('非 dry_run：组装参数传给 ctx.llm.stream 并返回 LLM 结果', async () => {
    const { ctx, llmCalls } = makeCtx({ llmChunks: (o: any) => textStream('扩写完成') })
    registerExpandTool(ctx, cfg)
    const def = registered.find((d) => d.name === 'prompt_expand')
    const value = await def.execute(
      { text: 'cat', profile: 'pe_expand_natural', output_lang: 'zh', length: 'medium' },
      { signal: new AbortController().signal, agent: execAgent().agent },
    )
    expect(llmCalls.length).toBe(1)
    expect(llmCalls[0].provider).toBe('deepseek')
    expect(llmCalls[0].maxTokens).toBeGreaterThan(0)
    expect(value).toBe('扩写完成')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-expand.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 route.ts**

创建 `src/plugin/route.ts`：

```ts
// src/plugin/route.ts — 工具内 LLM 路由解析（D1：跟随当前 agent）
import type { PluginConfig } from './config.js'

export interface RouteInfo {
  provider: string
  model: string
}

export function resolveRoute(
  exec: { agent?: { options?: { provider?: string; model?: string }; session?: any } },
  config: PluginConfig,
): RouteInfo {
  // 1) 本会话 request header 选择的 route（参考 dsh-mcp-client resolveImageAdmission）
  const routed = exec.agent?.session?.requestHeader?.()?.config as
    | { provider?: string; model?: string }
    | undefined
  // 2) agent 声明 route → 3) 插件配置 → 4) 内置默认
  return {
    provider: routed?.provider ?? exec.agent?.options?.provider ?? config.defaultProvider,
    model: routed?.model ?? exec.agent?.options?.model ?? config.defaultModel,
  }
}
```

- [ ] **Step 4: 实现 prompt-expand 工具**

重写 `src/tools/prompt-expand.ts`（原 handler 删除，替换为 defineTool 注册）：

```ts
// src/tools/prompt-expand.ts — prompt_expand 工具（DSH 原生 defineTool）
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveExpand } from '../resolver/index.js'
import { findProfileById } from '../resolver/profiles/index.js'
import { complete } from '../llm/complete.js'
import { resolveRoute } from '../plugin/route.js'
import type { PluginConfig } from '../plugin/config.js'

export function registerExpandTool(ctx: Context, config: PluginConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'prompt_expand',
    description: '将简短描述扩写为完整 AI 绘图正向提示词（支持 dry_run 只看组装结果）',
    parameters: {
      text: { type: 'string', required: true, description: '待扩写文本' },
      profile: { type: 'string', description: 'PE profile id，默认 pe_expand_natural' },
      output_lang: { type: 'string', description: 'zh | en | auto，默认 zh' },
      length: { type: 'string', description: 'very_short|short|medium|long|very_long 或数字字符数' },
      extra_prompt: { type: 'string', description: '用户附加要求' },
      dry_run: { type: 'boolean', description: '只返回组装好的 system/user 不调 LLM' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const profileId = String(args.profile || 'pe_expand_natural').trim()
      const profile = findProfileById(profileId)
      if (!profile) throw new Error(`Profile not found: ${profileId}`)

      const expanded = resolveExpand(profile, {
        outputLang: (args.output_lang as any) || 'zh',
        expandLen: String(args.length || 'medium'),
        userExtraPrompt: String(args.extra_prompt || ''),
        shortText: String(args.text || ''),
      })

      if (args.dry_run) {
        return `[dry_run] system:\n${expanded.system}\n\nuser:\n${expanded.user}`
      }

      const route = resolveRoute(exec, config)
      const result = await complete(ctx, {
        provider: route.provider,
        model: route.model,
        system: expanded.system,
        user: expanded.user,
        maxTokens: expanded.maxTokens,
        temperature: config.temperature,
        signal: exec.signal,
      })
      return result.text
    },
  }))
}
```

- [ ] **Step 5: 接线 apply**

在 `src/plugin/index.ts` 中替换 apply 为：

```ts
import { registerExpandTool } from '../tools/prompt-expand.js'

export function apply(ctx: Context, config: PluginConfig): void {
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    disposers.push(registerExpandTool(ctx, config))
    // Task 5-8 继续追加 registerReverseTool / registerMinimaxTool / registerProfileListTool
    return () => { for (const d of disposers) d() }
  }, 'prompt-master.tools')
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-expand.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 7: 回归**

Run: `node node_modules/vitest/vitest.mjs run tests/resolver tests/plugin`
Expected: 全部 PASS

---

### Task 5: prompt_reverse 工具（文本反推 + sanitize 链）

**Files:**
- Create: `src/tools/prompt-reverse.ts`（整体重写）
- Modify: `src/plugin/index.ts`（注册）
- Test: `tests/plugin/tool-reverse.test.ts`

**Interfaces:**
- Consumes: `resolveReverse()`（`src/resolver/index.js`）、`sanitizeFinalCaption()`（`src/resolver/profiles/reverse/router.js`，已有）、`complete()`、`resolveRoute()`、`PluginConfig`
- Produces: `src/tools/prompt-reverse.ts` → `export function registerReverseTool(ctx: Context, config: PluginConfig): () => void`（图片输入逻辑 Task 8 扩展本函数）

- [ ] **Step 1: 写失败测试**

创建 `tests/plugin/tool-reverse.test.ts`：

```ts
// tests/plugin/tool-reverse.test.ts
import { describe, it, expect } from 'vitest'
import { registerReverseTool } from '../../src/tools/prompt-reverse.js'
import { makeCtx, textStream } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }

describe('prompt_reverse 工具', () => {
  it('注册名为 prompt_reverse 且 image_description 必填', () => {
    const { ctx, registered } = makeCtx()
    registerReverseTool(ctx, cfg)
    const def = registered.find((d) => d.name === 'prompt_reverse')
    expect(def).toBeTruthy()
    expect(def.parameters.image_description.required).toBe(true)
  })

  it('文本路径：组装 system/user 调 LLM 并对结果做 sanitize 清洗', async () => {
    // LLM 返回带 markdown 的文本；sanitize 应去掉 ** 
    const { ctx, llmCalls } = makeCtx({ llmChunks: (o: any) => textStream('**这是标题**\n- 列表项\n正文内容') })
    registerReverseTool(ctx, cfg)
    const def = registered.find((d) => d.name === 'prompt_reverse')
    const value = await def.execute(
      { image_description: '一只猫坐在窗台上', profile: 'pe_reverse_descriptive', output_lang: 'zh', length: 'medium' },
      { signal: new AbortController().signal, agent: { options: { provider: 'deepseek', model: 'deepseek-chat' }, session: {} } },
    )
    expect(llmCalls.length).toBe(1)
    expect(value).not.toContain('**')
    expect(value).toContain('正文内容')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-reverse.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

重写 `src/tools/prompt-reverse.ts`（文本路径；Task 8 追加图片判定）：

```ts
// src/tools/prompt-reverse.ts — prompt_reverse 工具（文本描述反推）
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveReverse } from '../resolver/index.js'
import { findProfileById } from '../resolver/profiles/index.js'
import { sanitizeFinalCaption } from '../resolver/profiles/reverse/router.js'
import { complete } from '../llm/complete.js'
import { resolveRoute } from '../plugin/route.js'
import type { PluginConfig } from '../plugin/config.js'

export function registerReverseTool(ctx: Context, config: PluginConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'prompt_reverse',
    description: '根据图片描述文本（或会话最近贴图，见图片参数说明）生成指定格式的反推提示词',
    parameters: {
      image_description: { type: 'string', description: '图片描述文本；缺省时自动使用本会话最近贴图' },
      profile: { type: 'string', description: '反推 profile：pe_reverse_descriptive | pe_reverse_sd | pe_reverse_danbooru 等' },
      output_lang: { type: 'string', description: 'zh | en，默认 zh' },
      length: { type: 'string', description: 'very_short|short|medium|long|very_long' },
      extra_prompt: { type: 'string', description: '用户附加要求' },
      anima3_enhance: { type: 'boolean', description: '启用 ANIMA3 增强（SD/Danbooru）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const profileId = String(args.profile || 'pe_reverse_descriptive').trim()
      const profile = findProfileById(profileId)
      if (!profile) throw new Error(`Profile not found: ${profileId}`)

      const reverseResult = resolveReverse(profile, {
        caption_lang: (args.output_lang as any) || 'zh',
        len: String(args.length || 'medium'),
        media_target: 'image',
        extra_prompt: String(args.extra_prompt || ''),
        anima3_enhance: args.anima3_enhance === true,
      })

      const system = reverseResult.system
      const user = [
        reverseResult.userLead,
        reverseResult.userBody,
        reverseResult.outputConstraints,
        reverseResult.userTail,
      ].filter(Boolean).join('\n')
      const textInput = String((args.image_description as string) || '').trim()

      // Task 8：textInput 为空时，从 exec.agent.session.events 取最近图片并附加 image block
      const messages = await buildReverseMessages(exec, textInput, user)
      const route = resolveRoute(exec, config)
      const result = await complete(ctx, {
        provider: route.provider,
        model: route.model,
        system,
        user: (messages[0]!.content[0] as any).text ?? user,
        maxTokens: 512,
        temperature: config.temperature,
        signal: exec.signal,
      })

      // PM 1:1：LLM 原文必须过最终清洗链
      return sanitizeFinalCaption(result.text, {
        type: reverseResult.captionType,
        caption_lang: (args.output_lang as any) || 'zh',
        len: String(args.length || 'medium'),
        anima3_enhance: args.anima3_enhance === true,
      })
    },
  }))
}

// Task 8 扩展：目前纯文本路径（无描述则报错，图片路径在 Task 8 实现）
async function buildReverseMessages(exec: any, textInput: string, user: string): Promise<any[]> {
  if (textInput) return [{ content: [{ type: 'text', text: user }] }]
  throw new Error('未提供 image_description，且本任务版本尚未实现图片路径（见 Task 8）')
}
```

- [ ] **Step 4: 运行测试，修正实现中与测试期望不符处**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-reverse.test.ts`
说明：测试 1 断言 `image_description.required === true`，但上面参数里缺省并未设 required → 改为把 `image_description` 参数声明为 `required: true`（与设计一致：工具至少要有描述或图，本任务先强制描述必填，图片模式 Task 8 再放开）：
在参数里把 `image_description` 设为 `{ type: 'string', required: true, description: '...' }`，并在测试 2 中传入该字段。
Expected: PASS（2 个用例）

- [ ] **Step 5: 接线 apply + 回归**

在 `src/plugin/index.ts` 的 apply 里加 `disposers.push(registerReverseTool(ctx, config))`。
Run: `node node_modules/vitest/vitest.mjs run tests/resolver tests/plugin`
Expected: 全部 PASS

---

### Task 6: minimax_scenario 工具（budget 审计 + dry_run）

**Files:**
- Create: `src/tools/minimax-scenario.ts`（整体重写）
- Modify: `src/plugin/index.ts`
- Test: `tests/plugin/tool-minimax.test.ts`

**Interfaces:**
- Consumes: `resolveMinimaxScenarioExpand` / `getScenarioById` / `listScenarios`（`src/resolver/minimax/index.js`，已有）、`countChars`（`src/utils/length.js`，已有）、`complete()`、`resolveRoute()`
- Produces: `src/tools/minimax-scenario.ts` → `export function registerMinimaxTool(ctx: Context, config: PluginConfig): () => void`

- [ ] **Step 1: 写失败测试**

创建 `tests/plugin/tool-minimax.test.ts`：

```ts
// tests/plugin/tool-minimax.test.ts
import { describe, it, expect } from 'vitest'
import { registerMinimaxTool } from '../../src/tools/minimax-scenario.js'
import { makeCtx } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }

describe('minimax_scenario 工具', () => {
  it('dry_run 返回组装 prompt + budget（char_limit=7000，不调 LLM）', async () => {
    const { ctx, registered, llmCalls } = makeCtx()
    registerMinimaxTool(ctx, cfg)
    const def = registered.find((d) => d.name === 'minimax_scenario')
    const out = await def.execute(
      { scenario_id: 'full_reference', form_fields: { duration_seconds: '10', aspect_ratio: '16:9' }, output_lang: 'zh', dry_run: true },
      { signal: new AbortController().signal, agent: { options: {}, session: {} } },
    )
    expect(llmCalls.length).toBe(0)
    const parsed = JSON.parse(String(out))
    expect(parsed.budget.char_limit).toBe(7000)
    expect(parsed.prompt.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-minimax.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

重写 `src/tools/minimax-scenario.ts`：

```ts
// src/tools/minimax-scenario.ts — minimax_scenario 工具（H3 场景提示词）
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getScenarioById, listScenarios, resolveMinimaxScenarioExpand } from '../resolver/minimax/index.js'
import { complete } from '../llm/complete.js'
import { resolveRoute } from '../plugin/route.js'
import { countChars } from '../utils/length.js'
import type { PluginConfig } from '../plugin/config.js'

// H3 输出硬约束（与 PM 一致）：ref2va=2400 tokens / 其余 stage 见下，字符上限 7000
const STAGE_BUDGETS: Record<string, { text_tokens: number; char_limit: number }> = {
  t2va:   { text_tokens: 1200, char_limit: 7000 },
  i2va:   { text_tokens: 1500, char_limit: 7000 },
  fl2va:  { text_tokens: 1700, char_limit: 7000 },
  l2va:   { text_tokens: 1700, char_limit: 7000 },
  ref2va: { text_tokens: 2400, char_limit: 7000 },
}

function pickStage(outputMode: string, scenarioId: string): string {
  if (outputMode === 'full_reference' || outputMode === 'director_segments') {
    return scenarioId === 'full_reference' ? 'ref2va' : 't2va'
  }
  return 't2va'
}

export function registerMinimaxTool(ctx: Context, config: PluginConfig): () => void {
  return ctx.tools.register(defineTool({
    name: 'minimax_scenario',
    description: '按 MiniMax H3 场景模板生成视频提示词（dry_run 返回组装结果与预算审计）',
    parameters: {
      scenario_id: { type: 'string', required: true, description: 'full_reference | continuous_story | product_ad | ...（不含时列出全部场景）' },
      form_fields: { type: 'json', description: '场景表单字段（每个场景不同）' },
      output_lang: { type: 'string', description: 'zh | en，默认 zh' },
      dry_run: { type: 'boolean', description: '只返回组装 prompt + budget，不调 LLM' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const scenarioId = String(args.scenario_id || '').trim()
      if (!scenarioId) {
        return JSON.stringify({ scenarios: listScenarios().map((s) => s.id), hint: '请指定 scenario_id' })
      }
      const scenario = getScenarioById(scenarioId)
      if (!scenario) throw new Error(`Scenario not found: ${scenarioId}`)

      const expanded = resolveMinimaxScenarioExpand({
        id: scenario.peId,
        minimaxScenarioId: scenario.id,
        kind: 'expand',
      } as any, {
        outputLang: args.output_lang || 'zh',
        minimaxForm: { form_fields: args.form_fields || {}, output_lang: args.output_lang || 'zh' },
      })
      if (!expanded) throw new Error('Failed to assemble scenario prompt')

      const stageKey = pickStage(scenario.outputMode || 'full_reference', scenario.id)
      const budgetCfg = STAGE_BUDGETS[stageKey] || STAGE_BUDGETS.t2va
      const charCount = countChars(expanded.user)

      if (args.dry_run) {
        return JSON.stringify({
          prompt: expanded.user,
          scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
          budget: {
            text_tokens: budgetCfg.text_tokens,
            char_count: charCount,
            char_limit: budgetCfg.char_limit,
            over: charCount > budgetCfg.char_limit,
          },
          dry_run: true,
        })
      }

      const route = resolveRoute(exec, config)
      const result = await complete(ctx, {
        provider: route.provider,
        model: route.model,
        system: expanded.system,
        user: expanded.user,
        maxTokens: expanded.maxTokens,
        temperature: config.temperature,
        signal: exec.signal,
      })
      return JSON.stringify({
        prompt: result.text,
        scenario: { id: scenario.id, name: scenario.name, outputMode: scenario.outputMode },
        budget: {
          text_tokens: result.usage?.outputTokens ?? budgetCfg.text_tokens,
          char_count: countChars(result.text),
          char_limit: budgetCfg.char_limit,
          over: countChars(result.text) > budgetCfg.char_limit,
        },
      })
    },
  }))
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-minimax.test.ts`
Expected: PASS（1 个用例）

- [ ] **Step 5: 接线 apply + 回归**

`src/plugin/index.ts` 加 `disposers.push(registerMinimaxTool(ctx, config))`。
Run: `node node_modules/vitest/vitest.mjs run tests/resolver tests/plugin`
Expected: 全部 PASS

---

### Task 7: profile_list 工具 + ctx.settings 自定义 profile（D2）

**Files:**
- Create: `src/tools/profile-list.ts`（整体重写）
- Modify: `src/plugin/index.ts`（注册 settings 命名空间、注入 resolver 源、注册工具）
- Test: `tests/plugin/tool-profile.test.ts`

**Interfaces:**
- Consumes: `settingsNamespace`（`@deepseek-ai/dsh-settings`）、`getDefaultBuiltinProfiles`/`filterProfilesByKind`/`searchProfiles`/`clearProfileCache`/`setCustomProfileLoader`/`type CustomProfileRecord`（resolver，已有）+ Task 2 新增、`getTaxonomyMeta`（`src/resolver/taxonomy.js`，已有）
- Produces:
  - `src/tools/profile-list.ts` → `export function registerProfileListTool(ctx: Context, config: PluginConfig, scope: SettingsScope<{ customProfiles: Record<string, string> }>): () => void`（第三个参数为 settings scope，由 apply 传入）
  - 约定：settings 命名空间名 `prompt-master-custom-profiles`；`customProfiles: Record<profileId, profileJson>`

- [ ] **Step 1: 写失败测试**

创建 `tests/plugin/tool-profile.test.ts`：

```ts
// tests/plugin/tool-profile.test.ts
import { describe, it, expect } from 'vitest'
import { registerProfileListTool } from '../../src/tools/profile-list.js'
import { makeCtx, makeScopeStub } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }

describe('profile_list 工具（ctx.settings 自定义 profile）', () => {
  it('save 写入 settings scope，get 可读回', async () => {
    const { ctx, registered } = makeCtx()
    const scope: any = makeScopeStub({ customProfiles: {} })
    registerProfileListTool(ctx as any, cfg, scope)
    const def = registered.find((d: any) => d.name === 'profile_list')

    const saved = await def.execute(
      { action: 'save', id: 'pe_custom_x', profile: { kind: 'expand', name: 'X', description: 'x', enabled: true, systemPrompt: 'S', outputFormat: 'prose', tags: [], subjectDomains: [] } },
      { signal: new AbortController().signal },
    )
    expect(saved).toContain('已保存')
    const doc = scope.get()
    expect(Object.keys(doc.customProfiles)).toContain('pe_custom_x')

    const got = JSON.parse(await def.execute(
      { action: 'get', id: 'pe_custom_x' },
      { signal: new AbortController().signal },
    ))
    expect(got.custom).toBe(true)
  })

  it('list 返回内置 + 自定义 profile 合并', async () => {
    const { ctx, registered } = makeCtx()
    const scope: any = makeScopeStub({
      customProfiles: {
        pe_custom_x: JSON.stringify({ id: 'pe_custom_x', kind: 'expand', builtin: false, name: 'X', description: 'x', enabled: true, outputFormat: 'prose', tags: [], subjectDomains: [], systemPrompt: 'S' }),
      },
    })
    registerProfileListTool(ctx as any, cfg, scope)
    const def = registered.find((d: any) => d.name === 'profile_list')
    const out = JSON.parse(await def.execute({ action: 'list' }, { signal: new AbortController().signal }))
    expect(out.profiles.some((p: any) => p.id === 'pe_custom_x')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-profile.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（完整代码，一次写入）**

把 `src/tools/profile-list.ts` 全部内容替换为：

```ts
// src/tools/profile-list.ts — profile_list 工具（只读清单 + 自定义 Profile CRUD via ctx.settings）
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  getDefaultBuiltinProfiles,
  filterProfilesByKind,
  searchProfiles,
  clearProfileCache,
  setCustomProfileLoader,
  type CustomProfileRecord,
} from '../resolver/profiles/index.js'
import { getTaxonomyMeta } from '../resolver/taxonomy.js'
import type { PluginConfig } from '../plugin/config.js'

export const PROFILE_SETTINGS_NS = 'prompt-master-custom-profiles'
export type ProfileSettingsValue = { customProfiles: Record<string, string> }

export function registerProfileListTool(
  ctx: Context,
  _config: PluginConfig,
  scope: SettingsScope<ProfileSettingsValue>,
): () => void {
  // resolver 自定义 profile 源 ← settings scope（Task 2 注入契约）
  setCustomProfileLoader(() => {
    const { customProfiles } = scope.get()
    return Object.entries(customProfiles).map(
      ([id, profileJson]): CustomProfileRecord => ({ id, profileJson }),
    )
  })

  return ctx.tools.register(defineTool({
    name: 'profile_list',
    description: '列出内置 PE Profile（扩写/反推/train/minimax），并支持自定义 Profile 的 save/get/delete（存于 DSH settings）',
    parameters: {
      action: { type: 'string', description: 'list | get | save | delete，默认 list' },
      kind: { type: 'string', description: 'expand | reverse | train | minimax（list 过滤）' },
      query: { type: 'string', description: '名称/描述/tags 搜索' },
      id: { type: 'string', description: 'get/save/delete 目标 profile id' },
      profile: { type: 'json', description: 'save 的 profile 对象（不含 id，id 用参数覆盖）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, _exec) {
      const action = String(args.action || 'list').trim()
      const id = String(args.id || '').trim()
      const scopeDoc = () => scope.get()

      if (action === 'list' || action === 'search') {
        let profiles = getDefaultBuiltinProfiles()
        if (args.kind) profiles = filterProfilesByKind(String(args.kind).trim())
        if (args.query) profiles = searchProfiles(String(args.query).trim())
        return JSON.stringify({
          profiles: profiles.map((p) => ({
            id: p.id, name: p.name, category: p.category,
            description: p.description, kind: p.kind,
            outputFormat: p.outputFormat, tags: p.tags,
          })),
          taxonomy: getTaxonomyMeta(),
        })
      }

      if (action === 'save') {
        if (!id) throw new Error('id is required for save')
        const profileObj = args.profile
        if (!profileObj || typeof profileObj !== 'object') throw new Error('profile object is required')
        const withId = { ...(profileObj as object), id, builtin: false }
        await scope.update({
          customProfiles: { ...scopeDoc().customProfiles, [id]: JSON.stringify(withId) },
        })
        clearProfileCache()
        return JSON.stringify({ id, message: `Profile ${id} 已保存` })
      }

      if (action === 'get') {
        if (!id) throw new Error('id is required for get')
        const doc = scopeDoc()
        if (doc.customProfiles[id]) {
          return JSON.stringify({ profile: JSON.parse(doc.customProfiles[id]), custom: true })
        }
        const builtin = getDefaultBuiltinProfiles().find((p) => p.id === id)
        if (builtin) return JSON.stringify({ profile: builtin, custom: false })
        throw new Error(`Profile not found: ${id}`)
      }

      if (action === 'delete') {
        if (!id) throw new Error('id is required for delete')
        const doc = scopeDoc()
        if (getDefaultBuiltinProfiles().some((p) => p.id === id && p.builtin)) {
          throw new Error(`${id} 是内置 profile，不能删除`)
        }
        if (!doc.customProfiles[id]) throw new Error(`Profile not found: ${id}`)
        const { [id]: _removed, ...rest } = doc.customProfiles
        await scope.replace({ customProfiles: rest })
        clearProfileCache()
        return JSON.stringify({ id, message: `Profile ${id} 已删除` })
      }

      throw new Error(`Unknown action: ${action}`)
    },
  }))
}
```

- [ ] **Step 4: 运行测试验证通过**

替换 `src/plugin/index.ts`：

```ts
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { z } from '@deepseek-ai/schemastery'
import { registerExpandTool } from '../tools/prompt-expand.js'
import { registerReverseTool } from '../tools/prompt-reverse.js'
import { registerMinimaxTool } from '../tools/minimax-scenario.js'
import {
  registerProfileListTool,
  PROFILE_SETTINGS_NS,
  type ProfileSettingsValue,
} from '../tools/profile-list.js'

export function apply(ctx: Context, config: PluginConfig): void {
  // settings：自定义 profile 持久化命名空间（DSH 持久化由 provider 负责）
  const scope = ctx.settings.register<ProfileSettingsValue>(
    settingsNamespace(PROFILE_SETTINGS_NS),
    z.object({ customProfiles: z.record(z.string(), z.string()).default({}) }),
  )

  ctx.effect(() => {
    const disposers: (() => void)[] = []
    disposers.push(registerExpandTool(ctx, config))
    disposers.push(registerReverseTool(ctx, config))
    disposers.push(registerMinimaxTool(ctx, config))
    disposers.push(registerProfileListTool(ctx, config, scope))
    return () => { for (const d of disposers) d() }
  }, 'prompt-master.tools')
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-profile.test.ts`
说明：测试 stub 的 `ctx.settings.register` 返回 `makeScopeStub`，但真实 `registerProfileListTool` 的 `setCustomProfileLoader` 会在每个会话第一次 list 时读取 scope——测试 2 直接构造含 `customProfiles` 的 scope，行为一致。
Expected: PASS（2 个用例）

- [ ] **Step 7: 回归**

Run: `node node_modules/vitest/vitest.mjs run tests/resolver tests/plugin`
Expected: 全部 PASS（含 profile-source 测试仍过——因 loader 已由本工具设置，顺序无关）

---

### Task 8: prompt_reverse 图片附件模式（D3）

**Files:**
- Create: `src/llm/image.ts`
- Modify: `src/tools/prompt-reverse.ts`（放开 image_description 必填 + 接入图片）
- Test: `tests/plugin/tool-reverse-image.test.ts`

**Interfaces:**
- Consumes: `Agent`/`Session` 类型（`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session`）、`ImageBlock`（`@deepseek-ai/dsh-llm`）
- Produces:
  - `src/llm/image.ts`：
    - `export function findLatestUserImage(agent: { session?: { events?: readonly any[] } }): { block: any; caption?: string } | null`
    - `export async function assertVisionModel(ctx: Context, provider: string, model: string, signal: AbortSignal): Promise<void>`（用 `ctx.llm.resolveModelInfo` 校验 `inputModalities` 含 `'image'`，失败抛可读错误）

- [ ] **Step 1: 写失败测试**

创建 `tests/plugin/tool-reverse-image.test.ts`：

```ts
// tests/plugin/tool-reverse-image.test.ts
import { describe, it, expect } from 'vitest'
import { registerReverseTool } from '../../src/tools/prompt-reverse.js'
import { findLatestUserImage } from '../../src/llm/image.js'
import { makeCtx, textStream } from './helpers.js'

const cfg = { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', temperature: 0.7 }
const IMG_BLOCK = { type: 'image', attachment: { id: 'att-1', mediaType: 'image/png' } as any }

function makeAgentWithImage() {
  return {
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { events: [
      { type: 'user/message', session: { event: {} } } as any,
      { type: 'user/message', content: [{ type: 'text', text: '看这张图' }, IMG_BLOCK] } as any,
    ] },
  }
}

describe('findLatestUserImage', () => {
  it('从 session.events 反向找到最近的 image block', () => {
    const found = findLatestUserImage(makeAgentWithImage())
    expect(found).not.toBeNull()
    expect(found!.block.type).toBe('image')
    expect(found!.block.attachment.id).toBe('att-1')
  })

  it('无图时返回 null', () => {
    const agent = { options: {}, session: { events: [{ type: 'user/message', content: [{ type: 'text', text: 'hi' }] }] } }
    expect(findLatestUserImage(agent)).toBeNull()
  })
})

describe('prompt_reverse 图片路径', () => {
  it('无 image_description 时取会话图片并把 image block 传给 ctx.llm.stream', async () => {
    const { ctx, registered, llmCalls } = makeCtx({ llmChunks: (o: any) => textStream('1girl, long hair, looking at viewer') })
    registerReverseTool(ctx, cfg)
    const def = registered.find((d: any) => d.name === 'prompt_reverse')
    const out = await def.execute(
      { profile: 'pe_reverse_sd', output_lang: 'en', length: 'medium' },
      { signal: new AbortController().signal, agent: makeAgentWithImage() },
    )
    expect(llmCalls.length).toBe(1)
    // 断言 LLM 请求的用户消息里含 image block（complete 的 messages[0].content 末尾是图片）
    expect(llmCalls[0].messages[0].content.some((b: any) => b.type === 'image')).toBe(true)
    expect(out).toContain('1girl')
  })

  it('模型不支持视觉时报错引导换模型', async () => {
    const { ctx } = makeCtx({ vision: false })
    await expect(assertVision(ctx)).rejects.toThrow(/图片/)
  })
})

async function assertVision(ctx: any) {
  const { assertVisionModel } = await import('../../src/llm/image.js')
  await assertVisionModel(ctx, 'deepseek', 'deepseek-chat', new AbortController().signal)
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-reverse-image.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 image.ts**

创建 `src/llm/image.ts`：

```ts
// src/llm/image.ts — 图片输入支持：从会话取最近贴图 + 视觉模型校验
import type { Context } from '@deepseek-ai/cordis'

export interface FoundImage {
  /** 会话里 user/message 的 image block（原样复用其 ImageAttachmentRef） */
  block: { type: 'image'; attachment: unknown }
  /** 同消息里最后一段文本，作为反推的补充描述 */
  caption?: string
}

export function findLatestUserImage(agent: {
  session?: { events?: readonly { type?: string; content?: readonly { type?: string; [k: string]: unknown }[] }[] }
}): FoundImage | null {
  const events = agent?.session?.events ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'user/message' || !Array.isArray(ev.content)) continue
    let caption: string | undefined
    for (const block of ev.content) {
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        caption = block.text.trim()
      }
    }
    for (let j = ev.content.length - 1; j >= 0; j--) {
      const b = ev.content[j]
      if (b && b.type === 'image' && b.attachment) {
        return { block: b as unknown as FoundImage['block'], caption }
      }
    }
  }
  return null
}

export async function assertVisionModel(
  ctx: Context,
  provider: string,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  let info: { inputModalities?: readonly string[] } | undefined
  try {
    info = await ctx.llm.resolveModelInfo(provider, model, signal)
  } catch {
    info = undefined
  }
  const capable = info?.inputModalities?.includes('image') ?? false
  if (!capable) {
    throw new Error(
      `模型 ${model} 不支持图片输入，无法执行图片反推。请在 Settings→Models 切换到支持视觉的模型（如 DeepSeek-VL / 硅基流动 Qwen-VL）后重试。`,
    )
  }
}
```

- [ ] **Step 4: 扩展 complete 支持图片消息**

修改 `src/llm/complete.ts`：

```ts
export interface CompleteOptions {
  provider: string
  model: string
  system: string
  /** 文本正文（与 images 组合进单个 user 消息） */
  user: string
  /** 附加的图片 block（复用会话中的 ImageAttachmentRef），可选 */
  images?: { type: 'image'; attachment: unknown }[]
  maxTokens: number
  temperature?: number
  signal: AbortSignal
}
```

在 `complete` 内 messages 构造改为：

```ts
    messages: [createUserMessage({
      content: [
        { type: 'text', text: opts.user },
        ...(opts.images ?? []),
      ],
      source: { kind: 'plugin', plugin: 'prompt-master' },
    })],
```

- [ ] **Step 5: 更新 prompt-reverse 图片路径**

修改 `src/tools/prompt-reverse.ts`：

1. 参数 `image_description` 的 `required` 去掉（描述或图片二者取一），description 注明。
2. import `findLatestUserImage, assertVisionModel`。
3. execute 内替换 `buildReverseMessages` 调用段：

```ts
      const textInput = String((args.image_description as string) || '').trim()
      const found = textInput ? null : findLatestUserImage(exec.agent as any)
      if (!textInput && !found) {
        throw new Error('未提供 image_description，且本会话最近消息中没有图片；请提供图片描述文本或先贴图。')
      }
      const route = resolveRoute(exec, config)
      if (found) await assertVisionModel(ctx, route.provider, route.model, exec.signal)

      const images = found ? [found.block] : undefined
      const result = await complete(ctx, {
        provider: route.provider,
        model: route.model,
        system,
        user: found ? String(found.caption ?? '') + '\n\n' + user : user,
        images,
        maxTokens: 512,
        temperature: config.temperature,
        signal: exec.signal,
      })
```

4. 删除旧的 `buildReverseMessages` 辅助函数（Task 5 的临时实现）。

- [ ] **Step 6: 运行测试验证通过**

Run: `node node_modules/vitest/vitest.mjs run tests/plugin/tool-reverse-image.test.ts tests/plugin/tool-reverse.test.ts`
Expected: 全部 PASS（图片路径 + 既有文本路径）

- [ ] **Step 7: 回归全部**

Run: `node node_modules/vitest/vitest.mjs run tests/resolver tests/plugin`
Expected: 全部 PASS

---

### Task 9: 清理被替换层 + 依赖瘦身（P3）

**Files:**
- Delete: `src/index.ts`、`src/tools/index.ts`、`src/tools/provider-config.ts`、`src/provider/**`、`src/db/**`、`src/config/**`、`src/utils/errors.ts`
- Modify: `package.json`（删 `@modelcontextprotocol/sdk`、`sql.js`、`dotenv`、`yaml`；scripts 补 `"test": "vitest run tests/resolver tests/plugin"`）
- Delete: `tests/tools/`、`tests/provider/`、`tests/smoke.test.ts`、`tests/save-key.test.ts`
- Delete: `.env.example`、`config.yaml.example`

**Interfaces:**
- Consumes: 前 8 个任务的全部产出
- Produces: 干净的单插件仓库（唯一入口 `dist/src/plugin/index.js`）

- [ ] **Step 1: 检查残留引用**

Run: `Select-String -Path "D:\Projects\temp\prompt-master-mcp\src\**\*.ts" -Pattern "db/index|provider/index|config/index|@modelcontextprotocol|sql\.js|dotenv|from 'yaml'"`（或 grep 全 src）
Expected: 命中列表 = 待删文件内的引用（Task 9 删除后归零）

- [ ] **Step 2: 删除文件**

按上方 Delete 清单删除文件/目录。保留：`src/resolver/**`、`src/llm/**`、`src/plugin/**`、`src/tools/{prompt-expand,prompt-reverse,minimax-scenario,profile-list}.ts`、`src/utils/length.ts`。

- [ ] **Step 3: 更新 package.json**

依赖块改为：
```json
"dependencies": {},
"peerDependencies": {
  "@deepseek-ai/cordis": "^0.4.1",
  "@deepseek-ai/dsh-tools": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-llm": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-settings": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-attachment": "^0.1.1-rc.2",
  "@deepseek-ai/schemastery": "^3.18.1"
},
"devDependencies": {
  "@deepseek-ai/cordis": "^0.4.1",
  "@deepseek-ai/dsh-tools": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-llm": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-settings": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-attachment": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-agent": "^0.1.1-rc.2",
  "@deepseek-ai/dsh-session": "^0.1.1-rc.2",
  "@deepseek-ai/schemastery": "^3.18.1",
  "typescript": "^5.7.0",
  "vitest": "^3.0.0"
},
```
`main`/`exports`：
```json
"main": "dist/src/plugin/index.js",
"types": "dist/src/plugin/index.d.ts",
"exports": { ".": { "types": "./dist/src/plugin/index.d.ts", "default": "./dist/src/plugin/index.js" } }
```

- [ ] **Step 4: 清理依赖 + 编译**

Run: `bun remove @modelcontextprotocol/sdk sql.js dotenv yaml`（或 `npm un`）
Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: 退出码 0（全量清零，不再有旧引用）

- [ ] **Step 5: 全量测试**

Run: `node node_modules/vitest/vitest.mjs run tests/resolver tests/plugin`
Expected: 全部 PASS（resolver×5 文件 + plugin×5 文件）
同时删除 `vitest.config.ts`（不存在则跳过；确认默认 include 覆盖 `tests/**/*.test.ts` 且排除 node_modules）。

- [ ] **Step 6: 记录变更**

在 `docs/plans/TASK_TRACKING.md` Round 4 记录：删除层清单、依赖瘦身结果、测试统计。

---

### Task 10: 挂载到 comfyui-chenxin preset + 端到端验证（P4）

**Files:**
- Modify: `~/.dsh/.agent-presets/comfyui-chenxin/agent.cordis.yml`（**用户环境文件，改动前先备份**）
- Create: `docs/plans/VERIFY-NATIVE-PLUGIN.md`（验证清单）

**Interfaces:**
- Consumes: `dist/src/plugin/index.js`（Task 9 后的构建产物）
- Produces: comfyui-chenxin 会话内可见 4 个原生工具；其他 preset 不可见

- [ ] **Step 1: 构建插件**

Run: `node node_modules/typescript/bin/tsc`
确认 `dist/src/plugin/index.js` 存在。

- [ ] **Step 2: 备份 preset 配置**

Run: `Copy-Item "$env:USERPROFILE\.dsh\.agent-presets\comfyui-chenxin\agent.cordis.yml" "$env:USERPROFILE\.dsh\.agent-presets\comfyui-chenxin\agent.cordis.yml.bak-promptmaster"`
Expected: 备份文件生成

- [ ] **Step 3: 在 preset 配置中追加插件行**

向 `agent.cordis.yml` 末尾（`comfyui-loader` 之后）追加：

```yaml
# ── Prompt Master (DSH native) ──────────────────────────────────────────
# 仅本 preset 挂载（MCP Server 重构为 DSH 原生插件；模型调用走 ctx.llm）。
# 本地路径加载与上方 comfyui-loader ('./loader.js') 同模式。
- id: prompt-master
  name: 'D:\Projects\temp\prompt-master-mcp\dist\src\plugin\index.js'
  config:
    defaultProvider: deepseek
    defaultModel: deepseek-chat
    temperature: 0.7
```

- [ ] **Step 4: 重启 DSH 并验证（需用户执行）**

给用户的验证步骤（写入 `docs/plans/VERIFY-NATIVE-PLUGIN.md`）：
1. 重启 DSH Web UI（当前会话会中断，重启后新建会话）。
2. 新建会话（确认走 comfyui-chenxin preset），在会话中：
   - 调用 `prompt_expand`（`text: 'a cat on windowsill', dry_run: true`）→ 返回组装 debug；
   - `prompt_expand` 非 dry_run → 得到扩写正文；
   - `prompt_reverse`（`image_description: '一只猫坐在窗台上'`）→ 得到反推文本且无 `**`/Markdown 残留；
   - `minimax_scenario`（`scenario_id: 'full_reference', dry_run: true`）→ 返回 prompt + budget；
   - `profile_list` → 返回 56+ 内置 profile。
3. 贴一张图（attachment）→ 调用 `prompt_reverse` 不带 image_description → 图片路径返回反推结果（若当前模型非视觉模型，会收到换模型的清晰提示）。
4. 换到另一个 preset（如 liangshen）的会话 → 确认工具列表里**没有** prompt_expand 等（仅挂载 comfyui-chenxin 生效）。

- [ ] **Step 5: 冒烟/回归**

Run: `node node_modules/typescript/bin/tsc --noEmit && node node_modules/vitest/vitest.mjs run tests/resolver tests/plugin`
Expected: 全绿（作为挂载验证前的最后闸门）

- [ ] **Step 6: 文档收尾**

更新 `docs/plan-b-native-plugin.md` 状态为「已实施」；`docs/plans/TASK_TRACKING.md` Round 4 标记完成；`README.md` 简述插件安装/挂载方式（仅 preset 层）。

---

## Self-Review 记录（计划自查）

- **Spec 覆盖**：§3.1 耦合处置 → Task 2；§3.2 测试处置 → Task 9 + 各 Task 测试；§4 四个工具 → Task 4/5/6/7；§5 LLM 封装/错误 → Task 3（+Task 8 图片）；§5.1 版本 → Task 1/9；§6 挂载 → Task 10（preset 层）；§7.1 图片 → Task 8；§7.2 settings → Task 7；§8 各阶段 → Task 1-10；§9 风险 6/7 → Task 9 Step 5、Task 7（命名空间唯一）。
- **占位符扫描**：无 TBD/TODO；Task 7 只有一个完整实现代码块（占位中间态已合并移除）；Task 8 测试中动态 import 为测试手法，非占位。
- **类型一致性**：`registerExpandTool(ctx, config): () => void` 全计划一致；`PluginConfig` 字段一致；`CustomProfileRecord` 在 Task 2 定义、Task 7 消费；`CompleteOptions` 在 Task 3 定义、Task 8 扩展 `images` 字段（Task 8 Step 4 更新接口，后续任务无其他使用者，无冲突）；`sanitizeFinalCaption` 签名沿用既有（caption 对象含 type/caption_lang/len/anima3_enhance）。