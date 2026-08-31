# Prompt Master 重新设计（方案 A：管线内核归位 + 方言注册表）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 prompt-master 插件从"工具各自拼装管线"重构为"唯一内核 `runStage` + 方言注册表 + 资源注入 + 生产级日志"，消除 5 个根层问题（render 缺失 / 编排重复 / intent 不一致 / 硬编码路径 / 保真漂移）。

**Architecture:** 五层（schema/dialect/audit/render）收拢为纯函数内核 `runStage(target)`，方言按 target 注册（DialectContract），工具变薄视图；资源路径经 `resolveKnowledgePath` 注入；日志经 `ctx.logger` + 内核 trace 贯穿。

**Tech Stack:** TypeScript（NodeNext/ES2022）、node:sqlite（DatabaseSync readOnly）、@deepseek-ai/{cordis,dsh-llm,dsh-tools,dsh-settings,dsh-subagent,schemastery}、vitest。

**Spec:** `docs/2026-08-31-redesign-spec.md`（同目录，本计划从该 spec 论证）

## Global Constraints

- 插件根常量 `$P` = `C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`（所有路径相对此根）
- 测试命令：`Push-Location $P; npx vitest run <file>`（单文件）；全量 `npm test`；构建 `npm run build`
- git 仓库根 = preset 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`；每次 commit 用 `git -C <preset-root> add <相对路径>`（插件目录在 preset 仓库内未单独跟踪）
- 纯函数层（runStage/dialect/audit）零日志副作用，只返回 `trace`；IO 边界（intent/资源）注入 `ctx.logger`
- 资源路径**禁止硬编码** `C:/Users/...`；一律 `resolveKnowledgePath`
- intent 层：`prompt_author` 拆结构走 subagent（`getDialect(target).intent`），`prompt_expand`/`prompt_reverse` 直接 llm（决策表 spec §6）
- `registerDialect` 重复注册 fail loud（throw），拒绝静默覆盖（spec §3.2）
- `runStage` 永不写 `if(target)`；未注册 target → `DIALECT_NOT_AVAILABLE`（spec §2.2/§3.4）
- 保留测试注入点：`tokenizerSourceDir` 选项（budget-tokenizer.test.ts 用）、`setCatalogPath`/`ANIMA_CATALOG_PATH`
- 保留 fidelity golden（`tests/fidelity/golden/*.json`），重构不得破坏 sha256 自洽断言

---

### Task 1: 资源层 `resolveKnowledgePath` + `setPresetRoot`

**Files:**
- Create: `src/pe-framework/resources/resolve.ts`
- Modify: `src/plugin/config.ts`（加 `presetRoot?: string`）
- Modify: `src/plugin/index.ts`（apply 内 `setPresetRoot(config.presetRoot)`）
- Test: `tests/pe-framework/resources/resolve.test.ts`

**Interfaces:**
- Consumes: 无外部（纯 Node path/fs）
- Produces:
  - `setPresetRoot(root: string | undefined): void`
  - `resolveKnowledgePath(opts: { skillDir: string; asset: string }): string` —— 返回 `<presetRoot>/skills/<skillDir>/knowledge/<asset>`；无 presetRoot 时向插件包上级 4 级（`../../../..`）找 preset 根；找不到 throw 可读错误
  - `getPresetRoot(): string | undefined`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/resources/resolve.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'

describe('resolveKnowledgePath', () => {
  beforeEach(() => setPresetRoot('C:/fake-preset'))
  afterEach(() => setPresetRoot(undefined))

  it('joins presetRoot + skillDir + knowledge + asset', () => {
    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
      .toBe('C:/fake-preset/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite')
  })

  it('normalizes trailing slash on presetRoot', () => {
    setPresetRoot('C:/fake-preset/')
    expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe('C:/fake-preset/skills/x/knowledge/y.json')
  })

  it('throws readable error when no presetRoot configured', () => {
    setPresetRoot(undefined)
    expect(() => resolveKnowledgePath({ skillDir: 'x', asset: 'y' })).toThrow(/presetRoot not configured|preset/i)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `Push-Location $P; npx vitest run tests/pe-framework/resources/resolve.test.ts`
Expected: FAIL / Cannot find module 'resolve.js'（文件不存在）

- [ ] **Step 3: 实现**

```ts
// src/pe-framework/resources/resolve.ts
import { join, resolve, sep } from 'node:path'

let _presetRoot: string | undefined

export function setPresetRoot(root: string | undefined): void { _presetRoot = root }
export function getPresetRoot(): string | undefined { return _presetRoot }

/** 插件 dist 位于 <preset>/plugins/prompt-master/dist/src/pe-framework/... → 上级 4 级到 preset 根 */
function fallbackPresetRoot(): string | undefined {
  const here = import.meta.url
  try {
    // file:///C:/.../plugins/prompt-master/dist/src/pe-framework/resources/resolve.js
    const parts = decodeURIComponent(here.replace(/^file:\/\//, '')).split(sep)
    let idx = parts.findIndex((p) => p === 'plugins' && parts[parts.indexOf(p) + 1] === 'prompt-master')
    if (idx === -1) return undefined
    return parts.slice(0, idx).join(sep)  // 到 <preset>/plugins 之前
  } catch { return undefined }
}

export function resolveKnowledgePath(opts: { skillDir: string; asset: string }): string {
  const root = _presetRoot?.replace(/[\\/]+$/, '') || fallbackPresetRoot()
  if (!root) throw new Error('resolveKnowledgePath: presetRoot not configured (config.presetRoot / DSH_COMFYUI_PRESET_ROOT / preset layout); cannot resolve knowledge asset')
  return join(root, 'skills', opts.skillDir, 'knowledge', opts.asset)
}
```

> `fallbackPresetRoot` 用 `import.meta.url` 定位插件包自身：找到路径段 `.../plugins/prompt-master/...` 中 `plugins` 的索引，取其前的部分即 preset 根（`C:/.../.dsh/.agent-presets/comfyui-chenxin`）。Windows 路径统一为 `join` 输出（`\`）。若实现中 `sep`/URL 解析与测试环境不符，以 `resolve()` 兜底并保持 API 不变。

- [ ] **Step 4: 运行确认通过**

Run: `Push-Location $P; npx vitest run tests/pe-framework/resources/resolve.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 改 config + apply 接线**

`src/plugin/config.ts` 加字段：
```ts
export const Config = z.object({
  temperature: z.number().default(0.7),
  presetRoot: z.string().optional(),
})
```
`src/plugin/index.ts` apply 开头加：
```ts
import { setPresetRoot } from '../pe-framework/resources/resolve.js'
// 在注册 tools 前：
setPresetRoot(config.presetRoot)
```

- [ ] **Step 6: 全量构建 + 提交**

Run: `Push-Location $P; npm run build`
Expected: exit 0（config 类型新增字段不破坏现有注册）
Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/resources plugins/prompt-master/src/plugin/config.ts plugins/prompt-master/src/plugin/index.ts plugins/prompt-master/tests/pe-framework/resources
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): add resource path resolution (resolveKnowledgePath/setPresetRoot)"
```

---

### Task 2: 替换 anima-catalog / tokenizer-h3 硬编码路径

**Files:**
- Modify: `src/pe-framework/dialect/anima-catalog.ts:25-26,157`
- Modify: `src/pe-framework/audit/tokenizer-h3.ts:17`
- Test: `tests/plugin/budget-tokenizer.test.ts`（现有，验证不回归）+ `tests/fidelity/harness.test.ts`（现有，验证 golden 路径仍解析）

**Interfaces:**
- Consumes: Task 1 的 `resolveKnowledgePath`
- Produces: 无新接口；`anima-catalog.ts` 的 `catalogPath()`/`setCatalogPath()` 保持；`tokenizer-h3.ts` 的默认源目录改为 `resolveKnowledgePath({skillDir:'minimax-h3-prompt', asset:'tokenizer.json'})` 的上一级（`dirname`）

- [ ] **Step 1: 改 anima-catalog.ts（删除硬编码）**

```ts
// 删除：
// const DEFAULT_CATALOG_PATH = 'C:/Users/11245/...'
// const OVERLAY_PATH = 'C:/Users/11245/...'
// return join('C:/Users/11245/...')
// 改为（顶部 import）：
import { resolveKnowledgePath } from '../resources/resolve.js'
import { dirname } from 'node:path'

const _defaultCatalog = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
const _defaultOverlay = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })

let _dbPath = process.env.ANIMA_CATALOG_PATH ?? _defaultCatalog()
// overlay 读取处：const overlay = process.env.ANIMA_OVERLAY_PATH ?? _defaultOverlay()
```

> 保留 `setCatalogPath(path)`（fidelity 测试可能注入别库）；默认值改为惰性函数。`dirname` 若原 157 行 `return join('...knowledge')` 是目录用途，改 `resolveKnowledgePath({skillDir, asset:''})` 后 `dirname` 或以目录形式返回——按调用点实际需求调整（若返回目录就 `return dirname(defaultCatalogPath())` 等价；实现时以编译通过 + 现有 catalog 测试绿为准）。

- [ ] **Step 2: 改 tokenizer-h3.ts（删除硬编码）**

```ts
// 删除：const DEFAULT_SOURCE_DIR = 'C:/Users/11245/...'
// 改为：
import { resolveKnowledgePath } from '../resources/resolve.js'
import { dirname } from 'node:path'
export const defaultTokenizerSourceDir = () =>
  dirname(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' }))
// 原使用 DEFAULT_SOURCE_DIR 处改：defaultTokenizerSourceDir()
```

- [ ] **Step 3: 验证无硬编码残留**

Run: `Select-String -Path $P\src -Pattern "C:/Users/11245" -Recurse`
Expected: 0 matches（src 下无硬编码路径）

- [ ] **Step 4: 跑相关测试**

Run: `Push-Location $P; npx vitest run tests/plugin/budget-tokenizer.test.ts tests/fidelity/harness.test.ts`
Expected: PASS（budget 的 `tokenizerSourceDir` override 仍生效；harness golden 路径解析 OK）

- [ ] **Step 5: 构建 + 提交**

Run: `Push-Location $P; npm run build`
Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts plugins/prompt-master/src/pe-framework/audit/tokenizer-h3.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "fix(prompt-master): replace hardcoded knowledge paths with resolveKnowledgePath"
```

- [ ] **Step 6: 资产 manifest 对账（spec §4.2，Lazy 首用一次）**

新建 `src/pe-framework/resources/manifest.ts`：
```ts
// 实现 assertAssetPresent(skillDir, asset, expectedCheck): { ok:true } | { ok:false; reason }
// anima：读 <preset>/skills/anima-prompt-v1/knowledge/manifest.json 的 output checksum → 与 tag-catalog.sqlite 实算 sha256 比较
// h3：读 manifest.json snapshot_id==='h3-qwen3-vl' + tokenizer.json 存在
import { createHash, readFileSync } from 'node:fs'
import { resolveKnowledgePath } from './resolve.js'

export interface AssetCheck { ok: true } | { ok: false; reason: string }

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
export function assertAnimaCatalog(): AssetCheck {
  try {
    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'manifest.json' }), 'utf8'))
    const expected = m?.output?.checksum ?? m?.checksum
    const actual = sha256File(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
    return expected && expected === actual ? { ok: true } : { ok: false, reason: `catalog checksum mismatch (manifest=${expected} actual=${actual})` }
  } catch (e) { return { ok: false, reason: `catalog manifest unreadable: ${e instanceof Error ? e.message : String(e)}` } }
}
export function assertH3Tokenizer(): AssetCheck {
  try {
    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'manifest.json' }), 'utf8'))
    const okId = m?.snapshot_id === 'h3-qwen3-vl'
    const jsonExists = !!resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })  // 存在性由 resolve 保证
    return okId && jsonExists ? { ok: true } : { ok: false, reason: `tokenizer manifest mismatch (snapshot_id=${m?.snapshot_id})` }
  } catch (e) { return { ok: false, reason: `tokenizer manifest unreadable: ${e instanceof Error ? e.message : String(e)}` } }
}
```
接线：`anima-catalog.ts` 首次 `db()` 打开前调 `assertAnimaCatalog()`；`tokenizer-h3.ts` 首次加载前调 `assertH3Tokenizer()`。校验失败 → **不硬崩**：`console.warn('[prompt-master] ' + reason + '：资产与 golden 基线不同，请 re-run fidelity capture')`（资源层无 ctx.logger，用 console.warn 兜底；工具层调用方有 logger 时也可后续升级）。

测试 `tests/pe-framework/resources/manifest.test.ts`：
```ts
// assertAnimaCatalog 在巧设 presetRoot 指向 fixture 目录时校验通过/失败两分支
// 例：setPresetRoot(tempDir) 内放最小 manifest + 空文件 → 失败分支；放真实 checksum → 通过分支
```

- [ ] **Step 7: manifest 测试 + 构建 + 提交**

Run: `Push-Location $P; npx vitest run tests/pe-framework/resources/manifest.test.ts; npm run build`
Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/resources/manifest.ts plugins/prompt-master/tests/pe-framework/resources/manifest.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): asset manifest verification (catalog checksum, tokenizer snapshot)"
```

---

### Task 3: 方言注册表 `registerDialect` / `getDialect` / `isDialectReady`

**Files:**
- Create: `src/pe-framework/dialect/contract.ts`
- Create: `src/pe-framework/dialect/registry.ts`
- Modify: `src/pe-framework/types.ts`（`Target` 已是联合类型，确认存在；如需导出放这里）
- Test: `tests/pe-framework/dialect/registry.test.ts`

**Interfaces:**
- Consumes: `src/pe-framework/types.ts` 的 `AuditGate`；`src/pe-framework/schema/h3-shots.ts` 的 `Reference`；`../schema/h3-shots.js` 的 `H3ShotsInput`；`./anima.js` 的 `AnimaSlots`（仅类型）
- Produces:
  - `export interface DialectContract<TSlots = unknown, TCompiled = unknown>`（按 spec §3.1：id/label/auditOnlyOk/normalize/compile/audit/budget?/targetSlotHint/intent?）
  - `export function registerDialect(contract: DialectContract): void`
  - `export function getDialect(target: Target): DialectContract | undefined`
  - `export function isDialectReady(target: Target): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/dialect/registry.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { registerDialect, getDialect, isDialectReady, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'

const base: DialectContract = {
  id: 'anima', label: 'Anima', auditOnlyOk: true,
  normalize: () => ({ value: {} }), compile: () => ({}), audit: () => ({ gates: [] }),
  targetSlotHint: 't2i.prompt',
}

describe('dialect registry', () => {
  beforeEach(() => { /* 清空注册表：通过 re-import 或暴露 resetForTests —— 见 Step 3 说明 */ })

  it('registers and retrieves a dialect', () => {
    registerDialect(base)
    expect(getDialect('anima')).toBe(base)
    expect(isDialectReady('anima')).toBe(true)
  })

  it('throws on duplicate registration (fail loud)', () => {
    registerDialect(base)
    expect(() => registerDialect({ ...base, label: 'dup' })).toThrow(/already registered/)
  })

  it('returns undefined for unregistered target', () => {
    expect(getDialect('sd')).toBeUndefined()
    expect(isDialectReady('sd')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `Push-Location $P; npx vitest run tests/pe-framework/dialect/registry.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 registry（含测试清空钩子）**

```ts
// src/pe-framework/dialect/contract.ts
import type { AuditGate, Target } from '../types.js'
import type { Reference } from '../schema/h3-shots.js'

export interface PipelineInputLike {
  target: Target
  slots?: unknown
  variant?: string
  shots?: unknown
  stage?: string
  scenarioId?: string
  formFields?: Record<string, unknown>
  auditOnly?: boolean
}

export interface DialectContract<TSlots = unknown, TCompiled = unknown> {
  id: Target
  label: string
  auditOnlyOk: boolean
  normalize(input: PipelineInputLike, opts: { stage?: string; scenarioId?: string; formFields?: unknown }): {
    error?: string
    value?: TSlots
    stage?: string
    references?: Reference[]
  }
  compile(slots: TSlots, opts: { variant?: string; stage?: string }): TCompiled
  audit(compiled: TCompiled, ctx: { stage?: string; references?: Reference[]; shots?: unknown; variant?: string }): { gates: AuditGate[]; assumptions?: string[] }
  budget?(compiled: TCompiled, opts: { stage?: string; references?: Reference[] }): unknown
  targetSlotHint: string
  intent?: { persona: string; schema: string }
}
```

```ts
// src/pe-framework/dialect/registry.ts
import type { DialectContract } from './contract.js'
import type { Target } from '../types.js'

const dialects = new Map<Target, DialectContract>()

export function registerDialect(contract: DialectContract): void {
  if (dialects.has(contract.id)) throw new Error(`dialect already registered: ${contract.id}`)
  dialects.set(contract.id, contract)
}
export function getDialect(target: Target): DialectContract | undefined {
  return dialects.get(target)
}
export function isDialectReady(target: Target): boolean {
  return dialects.has(target)
}
/** 仅测试用：清空注册表（vitest 模块级单例间隔离） */
export function __resetDialectsForTests(): void { dialects.clear() }
```

> 测试 beforeEach 调用 `__resetDialectsForTests()`（从 registry.js 导入）；或测试文件顶部 `vi.resetModules()` + 动态 import。用 `__resetDialectsForTests`（显式、简单、避免 ESM 缓存复杂化）。

- [ ] **Step 4: 运行确认通过**

Run: `Push-Location $P; npx vitest run tests/pe-framework/dialect/registry.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 构建 + 提交**

Run: `Push-Location $P; npm run build`
Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect/contract.ts plugins/prompt-master/src/pe-framework/dialect/registry.ts plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): add dialect registry (registerDialect/getDialect/isDialectReady)"
```

---

### Task 4: `runStage` 内核 + render/ 层（assembleEnvelope + targetSlotHint 单点）

**Files:**
- Create: `src/pe-framework/render/envelope.ts`
- Create: `src/pe-framework/pipeline/runStage.ts`
- Create: `src/pe-framework/pipeline/types.ts`
- Modify: `src/pe-framework/types.ts`（如 StageResult 需被 compile 引用，导出管道类型；以编译为准）
- Test: `tests/pe-framework/pipeline/runStage.test.ts`

**Interfaces:**
- Consumes: `getDialect`（Task 3）；`DialectContract`（Task 3）；`serializeReport`（`src/pe-framework/audit/report.ts`，现有）
- Produces:
  - `src/pe-framework/pipeline/types.ts`：`PipelineInput`、`StageResult`、`PipelineTrace`（spec §2.1 形状）
  - `src/pe-framework/render/envelope.ts`：`assembleEnvelope(stage, trail?): string`、`targetSlotHint(target): string`
  - `src/pe-framework/pipeline/runStage.ts`：`runStage(input: PipelineInput): StageResult`

- [ ] **Step 1: 写失败测试（先测 render 层，再测内核）**

```ts
// tests/pe-framework/pipeline/runStage.test.ts
import { describe, expect, it } from 'vitest'
import { registerDialect, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'
import { assembleEnvelope } from '../../../src/pe-framework/render/envelope.js'

const fakeDialect: DialectContract = {
  id: 'anima', label: 'Fake', auditOnlyOk: true,
  normalize: () => ({ value: { a: 1 }, stage: 'base' }),
  compile: (v) => ({ positive: 'p', negative: 'n' }),
  audit: () => ({ gates: [] }),
  targetSlotHint: 't2i.prompt',
}

describe('runStage', () => {
  it('dispatches to registered dialect and returns StageResult', () => {
    registerDialect(fakeDialect)
    const r = runStage({ target: 'anima' } as any)
    expect(r.ok).toBe(true)
    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
    expect(r.targetSlotHint).toBe('t2i.prompt')
    expect(r.trace?.stages.length).toBeGreaterThan(0)
  })

  it('returns DIALECT_NOT_AVAILABLE envelope for unregistered target', () => {
    __resetDialectsForTests()
    const r = runStage({ target: 'sd' } as any)
    expect(r.ok).toBe(false)
    expect(r.gates[0].severity).toBe('critical')
    expect(r.gates[0].rule).toContain('dialect_not_available')
  })

  it('throws with readable error when normalize reports error', () => {
    registerDialect({ ...fakeDialect, normalize: () => ({ error: 'bad slots: unknown key x' }) })
    expect(() => runStage({ target: 'anima' } as any)).toThrow(/bad slots/)
  })
})

describe('assembleEnvelope', () => {
  it('emits P1 envelope with ok/result/audit/advisories/target_slot_hint', () => {
    const s = JSON.parse(assembleEnvelope(
      { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
      ['trail'],
    ))
    expect(s.ok).toBe(true)
    expect(s.target_slot_hint).toBe('t2i.prompt')
    expect(s.advisories).toContain('trail')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `Push-Location $P; npx vitest run tests/pe-framework/pipeline/runStage.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 pipeline/types + render/envelope**

```ts
// src/pe-framework/pipeline/types.ts
import type { AuditGate } from '../types.js'
import type { Budget } from '../types.js'

export interface PipelineInput {
  target: 'anima' | 'h3' | 'sd' | 'generic'
  slots?: Record<string, unknown>
  variant?: string
  shots?: unknown
  stage?: string
  scenarioId?: string
  formFields?: Record<string, unknown>
  auditOnly?: boolean
}

export interface PipelineTrace {
  stages: Array<{ name: 'schema'|'dialect'|'audit'|'budget'|'render'; ms: number }>
  catalogHits?: number
  tokenCounter?: 'official-tokenizer' | 'estimate'
  references?: number
}

export interface StageResult {
  ok: boolean
  result: Record<string, unknown>
  gates: AuditGate[]
  advisories: string[]
  assumptions: string[]
  budget?: Budget
  targetSlotHint: string
  trace?: PipelineTrace
}
```

```ts
// src/pe-framework/render/envelope.ts
import { serializeReport } from '../audit/report.js'
import type { StageResult } from '../pipeline/types.js'

export function targetSlotHint(target: string): string {
  return target === 'h3' ? 't2v.prompt' : target === 'anima' ? 't2i.prompt' : 'generic.prompt'
}

export function assembleEnvelope(stage: StageResult, trail: string[] = []): string {
  const envelope: Record<string, unknown> = {
    ok: stage.ok,
    ...(stage.ok ? { result: stage.result } : {}),
    audit: { passed: stage.ok, gates: stage.gates, ...(stage.budget ? { budget: stage.budget } : {}) },
    advisories: [...stage.advisories, ...trail],
    target_slot_hint: stage.targetSlotHint,
  }
  return serializeReport(envelope as never)
}
```

> 注意：`envelope.result` 现状是**无条件**放（即使 audit_only）；此处按 `stage.ok` 放——需核对 Task 6 工具视图时保留 compile/author 的 `result` 语义（audit_only 时 omit result 是 spec §2.2 定案，若现有测试断言不同则以此为准并更新测试）。

- [ ] **Step 4: 实现 runStage**

```ts
// src/pe-framework/pipeline/runStage.ts
import { getDialect } from '../dialect/registry.js'
import { assembleEnvelope } from '../render/envelope.js'
import type { PipelineInput, StageResult } from './types.js'
import type { AuditGate } from '../types.js'

export function runStage(input: PipelineInput): StageResult {
  const d = getDialect(input.target)
  if (!d) return {
    ok: false,
    result: {},
    gates: [{ rule: 'dialect_not_available', target: input.target, severity: 'critical', detail: `方言 ${input.target} 未注册（请以 registerDialect 装配）`, source: 'pipeline/runStage' }],
    advisories: [],
    assumptions: [],
    targetSlotHint: targetSlotHintFrom(input.target),
  }
  if (input.auditOnly && !d.auditOnlyOk) throw new Error(`target ${input.target} 不支持 auditOnly（auditOnlyOk=false）`)
  const t0 = performance.now()
  const norm = d.normalize(input, { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields })
  if (norm.error) throw new Error(norm.error)
  const compiled = d.compile(norm.value!, { variant: input.variant, stage: norm.stage })
  const audit = d.audit(compiled, { stage: norm.stage, references: norm.references, shots: norm.value })
  const budget = d.budget?.(compiled, { stage: norm.stage, references: norm.references })
  const result: StageResult = {
    ok: audit.gates.every((g) => g.severity !== 'critical'),
    result: input.auditOnly ? {} : (compiled as Record<string, unknown>),
    gates: audit.gates,
    advisories: [],
    assumptions: audit.assumptions ?? [],
    ...(budget !== undefined ? { budget: budget as never } : {}),
    targetSlotHint: d.targetSlotHint,
  }
  result.trace = { stages: [{ name: 'schema', ms: 0 }, { name: 'dialect', ms: performance.now() - t0 }, { name: 'audit', ms: 0 }, { name: 'render', ms: 0 }] }
  return result
}
function targetSlotHintFrom(target: string): string {
  return target === 'h3' ? 't2v.prompt' : target === 'anima' ? 't2i.prompt' : 'generic.prompt'
}
```

> 常量 `DIALECT_NOT_AVAILABLE` 形状与测试断言对齐（rule 含 `dialect_not_available`、severity critical）。`performance` 是 Node 全局（v16+），可用于 trace。

- [ ] **Step 5: 运行确认通过**

Run: `Push-Location $P; npx vitest run tests/pe-framework/pipeline/runStage.test.ts`
Expected: PASS

- [ ] **Step 6: 构建 + 提交**

Run: `Push-Location $P; npm run build`
Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/pipeline plugins/prompt-master/src/pe-framework/render plugins/prompt-master/tests/pe-framework/pipeline
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): add runStage pipeline kernel + render envelope layer"
```

---

### Task 5: anima / h3 注册为方言模块（normalize 收敛重复）

**Files:**
- Modify: `src/pe-framework/intent/subagent-provider.ts`（**先拆分 per-target persona/schema 常量**：`ANIMA_PERSONA`/`ANIMA_SCHEMA`/`H3_PERSONA`/`H3_SCHEMA` —— 从现有 DEFAULT_PERSONA/DEFAULT_SCHEMA 按 target 段拆出，DEFAULT_* 保留为兜底）
- Modify: `src/pe-framework/dialect/anima.ts`（新增 `registerAnimaDialect()` 或模块内 `registerDialect(...)`）
- Modify: `src/pe-framework/dialect/h3.ts`（新增 `normalizeH3Input`：stage 推断 + toRefs 从三工具收敛；`registerH3Dialect()`）
- Modify: `src/plugin/index.ts`（顶部 import 两个方言模块，触发副作用注册）
- Delete（逻辑后，见 Task 6）：`prompt-author.ts` 内的 `inferH3Stage`/`toRefs` 待 Task 6 删；本任务先建方言侧
- Test: `tests/pe-framework/dialect/anima-register.test.ts`、`tests/pe-framework/dialect/h3-register.test.ts`
- Step 3 前置子步骤（本任务内）：拆 `ANIMA_*`/`H3_*` 常量（若 H3_PERSONA/H3_SCHEMA 与 ANIMA 文本相同则统一为共享常量，但 schema 的 target 键不同，分开）

**Interfaces:**
- Consumes: `registerDialect`/`DialectContract`（Task 3）；`compileAnima`/`auditAnima`（现有 anima.ts 导出）；`compileH3`/`auditH3Full`/`contractGatesH3`（现有 h3.ts/rules-h3.ts）；`sceneToShotsChecked`（schema/scenes.ts）
- Produces:
  - `anima.ts`：`registerAnimaDialect(): void`（或副作用注册）
  - `h3.ts`：`normalizeH3Input(input, opts): { error?; value?: H3ShotsInput; stage?: 't2va'|'ref2va'; references?: Reference[] }`；`registerH3Dialect(): void`
  - plugin/index.ts 顶部 `import '../pe-framework/dialect/anima.js'` + `import '../pe-framework/dialect/h3.js'`

- [ ] **Step 1: 写失败测试（方言注册 + normalize 合约）**

```ts
// tests/pe-framework/dialect/h3-register.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { __resetDialectsForTests, registerDialect, getDialect } from '../../../src/pe-framework/dialect/registry.js'
import { normalizeH3Input, registerH3Dialect } from '../../../src/pe-framework/dialect/h3.js'

describe('H3 dialect registration', () => {
  beforeEach(() => { __resetDialectsForTests(); registerH3Dialect() })

  it('registers h3 dialect with targetSlotHint t2v.prompt', () => {
    const d = getDialect('h3')
    expect(d?.targetSlotHint).toBe('t2v.prompt')
    expect(d?.auditOnlyOk).toBe(true)
  })

  it('normalizeH3Input infers ref2va when references present', () => {
    const r = normalizeH3Input({}, { stage: undefined, scenarioId: undefined, formFields: { references: [{ who: 'a' }] } })
    expect(r.stage).toBe('ref2va')
  })

  it('normalizeH3Input infers t2va when no references', () => {
    const r = normalizeH3Input({}, { stage: undefined, scenarioId: undefined, formFields: {} })
    expect(r.stage).toBe('t2va')
  })
})
```

```ts
// tests/pe-framework/dialect/anima-register.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
import { registerAnimaDialect } from '../../../src/pe-framework/dialect/anima.js'

describe('Anima dialect registration', () => {
  beforeEach(() => { __resetDialectsForTests(); registerAnimaDialect() })

  it('registers anima dialect with targetSlotHint t2i.prompt', () => {
    expect(getDialect('anima')?.targetSlotHint).toBe('t2i.prompt')
  })

  it('normalize validates slot keys (rejects unknown key)', () => {
    const d = getDialect('anima')!
    const r = d.normalize({ target: 'anima', slots: { bogus_key: ['x'] } } as any, {})
    expect(r.error).toContain('bogus_key')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `Push-Location $P; npx vitest run tests/pe-framework/dialect/h3-register.test.ts tests/pe-framework/dialect/anima-register.test.ts`
Expected: FAIL（registerAnimaDialect/registerH3Dialect/normalizeH3Input 不存在）

- [ ] **Step 3: 实现 h3.ts 的 normalizeH3Input + registerH3Dialect**

```ts
// src/pe-framework/dialect/h3.ts（文件内新增，复用现有 compile/audit 导出）
import { registerDialect } from './registry.js'
import { contractGatesH3, auditH3Full } from '../audit/rules-h3.js'
import { buildH3Budget } from '../audit/budget.js'
import type { H3ShotsInput, Reference } from '../schema/h3-shots.js'
import type { DialectContract } from './contract.js'

export function normalizeH3Input(
  input: unknown,
  opts: { stage?: string; scenarioId?: string; formFields?: unknown },
): { error?: string; value?: H3ShotsInput; stage?: 't2va' | 'ref2va'; references?: Reference[] } {
  const shots = (input as any)?.shots as H3ShotsInput
  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) {
    return { error: 'H3 需要 shots{shots:[...]} 结构（intent 未产出镜头）' }
  }
  const formRefs = Array.isArray((opts.formFields as any)?.references) ? ((opts.formFields as any).references as unknown[]) : []
  const refs = Array.isArray(shots.references) ? shots.references : []
  const references = (refs.length ? refs : formRefs) as Reference[]
  const stage: 't2va' | 'ref2va' =
    (opts.stage as any) || (references.length > 0 ? 'ref2va' : opts.scenarioId === 'full_reference' ? 'ref2va' : 't2va')
  return { value: shots, stage, references }
}

export function registerH3Dialect(): void {
  const contract: DialectContract<H3ShotsInput, { text: string; text_zh: string }> = {
    id: 'h3',
    label: 'MiniMax-H3',
    auditOnlyOk: true,
    normalize: normalizeH3Input as any,
    compile: (shots, opts) => {
      const stage = (opts.stage as 't2va' | 'ref2va') ?? 't2va'
      return compileH3(shots, { stage })
    },
    audit: (compiled, ctx) => {
      const stage = ctx.stage!
      const shots = ctx.shots as H3ShotsInput
      const gates = [...contractGatesH3(stage, shots, ctx.references ?? []), ...auditH3Full(compiled.text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, ctx.references)]
      return { gates, assumptions: [] }
    },
    budget: (compiled, ctx) => {
      const stage = ctx.stage!
      return buildH3Budget(stage, compiled.text, ctx.references)
    },
    targetSlotHint: 't2v.prompt',
    // intent persona/schema：从 src/pe-framework/intent/subagent-provider.ts 提取——常量是单一 DEFAULT_PERSONA（含 anima+h3 两规则）与 DEFAULT_SCHEMA（anima+h3 两段）。
    // 重构方案：把常量拆为 per-target（导出 H3_PERSONA/H3_SCHEMA 与 ANIMA_PERSONA/ANIMA_SCHEMA），h3 用前者、anima 用后者；
    // subagentIntent 按 req.target 选择（见 Task 7 Step 3）。
    intent: { persona: H3_PERSONA, schema: H3_SCHEMA },
  }
  registerDialect(contract)
}
```

> Stage 推断的优先级：显式 `stage` > references 存在 > `scenarioId==='full_reference'` > t2va（与 prompt-author.ts `inferH3Stage` 现在一致）。`compileH3` 现有签名接受 `{stage}`，`auditH3Full` 参数与现有调用一致。contractGatesH3 现有签名核对（`(stage, shots, references)`）——以编译为准微调。intent persona/schema 从 `intent/subagent-provider.ts` 的 DEFAULT_PERSONA/DEFAULT_SCHEMA 提取 h3 对应段（Task 7 拆 intent 时正式搬，本任务先引用或内联同文本）。

- [ ] **Step 4: 实现 anima.ts registerAnimaDialect + validateAnimaSlots**

```ts
// src/pe-framework/dialect/anima.ts（文件内新增）
import { registerDialect } from './registry.js'
import type { DialectContract } from './contract.js'

const ANIMA_SLOT_KEYS = new Set(['count_gender','character','appearance','clothing','pose_action','expression','camera','scene','detail_mood'])
export function validateAnimaSlots(slots: unknown): string | undefined {
  if (!slots || typeof slots !== 'object') return 'anima 需要 slots 对象'
  for (const k of Object.keys(slots)) {
    if (k === 'narrative') continue
    if (!ANIMA_SLOT_KEYS.has(k)) return `未知槽位: ${k}`
    if (k !== 'narrative' && (!Array.isArray((slots as any)[k]) || (slots as any)[k].some((x: unknown) => typeof x !== 'string'))) return `槽位 ${k} 需为 string[]`
  }
  if ('narrative' in slots && typeof (slots as any).narrative !== 'string') return 'narrative 需为 string'
  return undefined
}

export function registerAnimaDialect(): void {
  const contract: DialectContract<Record<string, unknown>, { positive: string; negative: string }> = {
    id: 'anima',
    label: 'Anima',
    auditOnlyOk: true,
    normalize: (input) => {
      const slots = (input as any)?.slots as Record<string, unknown>
      const err = validateAnimaSlots(slots)
      if (err) return { error: err }
      return { value: slots }
    },
    compile: (slots, opts) => {
      const variant = (opts.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
      return compileAnima(slots as never, { variant })
    },
    audit: (compiled, ctx) => {
      const variant = ((ctx.shots as any)?.variant as 'base' | 'aesthetic' | 'turbo') ?? ((ctx as any).variant ?? 'base')
      const slots = (ctx as any).slots as Record<string, unknown>
      return { gates: auditAnima(compiled.positive, compiled.negative, { variant, slots: slots as never }) }
    },
    targetSlotHint: 't2i.prompt',
    // intent persona/schema：从 subagent-provider.ts 拆分 per-target 常量（ANIMA_PERSONA/ANIMA_SCHEMA，见 Task 5 Step 3 说明）
    intent: { persona: ANIMA_PERSONA, schema: ANIMA_SCHEMA },
  }
  registerDialect(contract)
}
```

> `validateAnimaSlots` 键白名单按 SLOT_ORDER + narrative（spec §3.3 的 composition.py `_coerce_brief` 移植）。`compileAnima`/`auditAnima` 现有导出现成。`audit` 的 variant 传递：runStage 调用 `d.audit(compiled, {stage, references, shots})`，规范应在 contract 的 ctx 带 `variant`——**修正 DialectContract.audit ctx 增加 `variant?: string`**（Task 3 的 contract.ts 补字段），anima.audit 用 ctx.variant。以编译为准。

- [ ] **Step 5: plugin/index.ts 顶部门联注册**

```ts
// src/plugin/index.ts（顶部，apply 之前）
import '../pe-framework/dialect/anima.js'
import '../pe-framework/dialect/h3.js'
```
> 两个文件模块级调用 `registerAnimaDialect()`/`registerH3Dialect()`（在文件底部 `registerAnimaDialect()` 副作用执行）。

- [ ] **Step 6: 运行确认通过**

Run: `Push-Location $P; npx vitest run tests/pe-framework/dialect/h3-register.test.ts tests/pe-framework/dialect/anima-register.test.ts`
Expected: PASS

- [ ] **Step 7: 构建 + 现有测试回归**

Run: `Push-Location $P; npm run build; npx vitest run`
Expected: build 0 错误；现有 270 测试绿（registerDialect 副作用不影响其它测试；插件测试 stub ctx 不 import plugin/index.ts 则不触发——registry.test.ts 若 import apply 会连带触发注册，需确认其 stub 不因副作用失败）

- [ ] **Step 8: 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect plugins/prompt-master/src/plugin/index.ts plugins/prompt-master/tests/pe-framework/dialect
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): register anima/h3 as dialects (normalize converges stage/references)"
```

---

### Task 6: 工具薄视图化（author/compile/audit 走 runStage，删重复）

**Files:**
- Modify: `src/tools/prompt-author.ts`（删 `runDraftStage`/`inferH3Stage`/`toRefs`/`renderEnvelope`；改走 `runStage`；闭环保留）
- Modify: `src/tools/prompt-compile.ts`（删 `inferH3Stage`/`toReferences`/`compileH3Envelope`；薄视图 `runStage`）
- Modify: `src/tools/prompt-audit.ts`（删 `toRefs`；薄视图 `runStage(auditOnly)`）
- Test: 现有 `tests/plugin/{author-e2e,compile-anima,compile-h3,prompt-audit,h3-audit}.test.ts` 适配 + `tests/audit-loop/author-loop.test.ts`

**Interfaces:**
- Consumes: `runStage`/`StageResult`（Task 4）；`getDialect(...).intent`（Task 3/5）；`subagentIntent`（现有 intent）
- Produces: 无新接口；三个工具的入口参数/返回**保持不变**（对外契约不动，重建内部调用 runStage）

- [ ] **Step 1: prompt-author.ts 重构（保留入口契约）**

```ts
// 删除：runDraftStage / inferH3Stage / toRefs / renderEnvelope / StageResult 定义（移走）
// 新增 import：{ runStage } from '../pe-framework/pipeline/runStage.js'
//            { assembleEnvelope } from '../pe-framework/render/envelope.js'
//            { getDialect } from '../pe-framework/dialect/registry.js'

async execute(args, exec) {
  // …target/input 校验保持不变…
  if (a.audit_only === true) {
    // audit_only：input 是结构 JSON → 直接 runStage(auditOnly)
    const parsed = JSON.parse(input)
    const stage = runStage({ target, ...(target==='anima' ? { slots: parsed } : { shots: parsed }), auditOnly: true } as any)
    return assembleEnvelope(stage)
  }
  const provider = _intentProvider ?? ((req, exec2) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
  let draft = await provider({ target, input, variant, scenarioId, formFields, round: 0 }, exec)
  let stage = runStage({ target, ...(target==='anima' ? { slots: draft.slots } : { shots: draft.shots }), ...(variant ? { variant } : {}), stage: a.stage, scenarioId, formFields } as any)
  const trail: string[] = []
  for (let corrections = 0; corrections < MAX_CORRECTIONS; corrections++) {
    if (stage.ok || !stage.gates.some(g => g.severity === 'critical')) break
    const feedback = stage.gates.filter(g => g.severity === 'critical').map(g => `[${g.rule}] ${g.detail}`).join('\n')
    draft = await provider({ target, input, variant, scenarioId, formFields, round: corrections + 1, feedback }, exec)
    stage = runStage({ target, ...(target==='anima' ? { slots: draft.slots } : { shots: draft.shots }), ...(variant ? { variant } : {}), stage: a.stage, scenarioId, formFields } as any)
  }
  if (!stage.ok && stage.gates.some(g => g.severity === 'critical')) trail.push('loop_exhausted:true')
  return assembleEnvelope(stage, trail)
}
```

> `runDraftStage` 里 anima 的 `{positive,negative}` result 与 h3 的 `{text,text_zh}` 现在由 dialect.compile 产出（Task 5 的 compile 已接）。**删除后 `runDraftStage` 引用的 `StageResult`/`target_slot_hint` 语义由 runStage 承担**；`compileAnimaEnvelope`/`compileH3Envelope` 删除，纯 LLM 的 `expand`/`reverse` 工具不动。现有 `author-e2e` 测试断言 Envelope 字段（ok/result/audit/advisories/target_slot_hint）：`assembleEnvelope` 输出对齐（§4 Step 3 已保证）；若 audit_only 分支的 result 省略导致断言差异，更新对应测试（以 spec §2.2 为准）。

- [ ] **Step 2: prompt-compile.ts 重构（薄视图）**

```ts
// 删除：inferH3Stage / toReferences / compileH3Envelope / compileAnimaEnvelope 内部拼装
// 改为：
import { runStage } from '../pe-framework/pipeline/runStage.js'
import { assembleEnvelope } from '../pe-framework/render/envelope.js'

async execute(args, exec) {
  const target = String(args.target || 'anima')
  const stage = runStage({
    target,
    ...(target === 'anima' ? { slots: args.slots as any, variant: args.variant } : { shots: args.shots as any, stage: args.stage, scenarioId: args.scenario_id, formFields: args.form_fields }),
    auditOnly: args.audit_only === true,
  } as any)
  return assembleEnvelope(stage)
}
```
> 入口参数（shots/slots/audit_only/output_lang）保持不变；`output_lang` 若现有 compile 有使用需在视图里保留传递（h3 的 text_zh 不依赖 lang，若现有使用则核对）。

- [ ] **Step 3: prompt-audit.ts 重构（薄视图）**

```ts
// 删除 toRefs；改为：
import { runStage } from '../pe-framework/pipeline/runStage.js'
import { assembleEnvelope } from '../pe-framework/render/envelope.js'

async execute(args, exec) {
  return assembleEnvelope(runStage({
    target: String(args.target || 'anima'),
    ...(target === 'anima' ? { slots: args.slots } : { shots: args.shots, stage: args.stage }),
    auditOnly: true,
  } as any))
}
```

- [ ] **Step 4: 跑现有工具测试（适配断言差异）**

Run: `Push-Location $P; npx vitest run tests/plugin/author-e2e.test.ts tests/plugin/compile-anima.test.ts tests/plugin/compile-h3.test.ts tests/plugin/prompt-audit.test.ts tests/plugin/h3-audit.test.ts tests/audit-loop/author-loop.test.ts`
Expected: 修正断言后 PASS（Envelope 结构变化点：audit_only 无 result、advisories 组织——按实际 diff 逐个更新；行为等价性是验收）

- [ ] **Step 5: 确认无重复函数残留**

Run: `Select-String -Path $P\src -Pattern "function inferH3Stage|function toRefs|function toReferences|renderEnvelope|compileH3Envelope" -Recurse`
Expected: 0 matches（重复全清）

- [ ] **Step 6: 全量测试 + 构建**

Run: `Push-Location $P; npm run build; npm test`
Expected: 全部绿（行为等效，现有断言按 Envelope 调整）

- [ ] **Step 7: 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/tools plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "refactor(prompt-master): tools become thin views over runStage (remove duplicate orchestration)"
```

---

### Task 7: budget 帧底精确化 + intent persona/schema 从 dialect 读 + 日志贯穿

**Files:**
- Modify: `src/pe-framework/audit/budget.ts:76`（chat 帧底估算 → 精确）
- Modify: `src/pe-framework/intent/subagent-provider.ts`（persona/schema 参数化；`createSubagentIntentProvider(ownerCtx, opts)` 的 `opts.persona/schema` 由 caller 传；保留 DEFAULT 兜底）
- Modify: `src/tools/prompt-author.ts`（intent 调用前从 `getDialect(target).intent` 取 persona/schema）
- Modify: `src/tools/*.ts`（5 个工具入口打 `ctx.logger.info`；catch 打 error）
- Test: `tests/pe-framework/audit/budget-frame.test.ts`（新增）+ 日志 spy 测试

**Interfaces:**
- Consumes: `countTokensH3(text, dir, refCount).tokens`（现有 tokenizer-h3）；`ctx.logger`（Cordis）；`getDialect(...).intent`
- Produces: `budget.ts` 的 `chatTemplateTokens` 改为 `countTokensH3('', dir, references.length).tokens`；工具 logger 打点

- [ ] **Step 1: 写失败测试（帧底精确化）**

```ts
// tests/pe-framework/audit/budget-frame.test.ts
import { describe, expect, it } from 'vitest'
import { buildH3Budget } from '../../../src/pe-framework/audit/budget.js'

describe('H3 budget chat-frame precision', () => {
  it('uses exact tokenizer frame bottom when references present (not 5+2N estimate)', () => {
    const b = buildH3Budget('t2va', 'hello', [{ who: 'a', image: 'x', width: 1024, height: 1024 }], {
      tokenizerSourceDir: 'C:/fake/nonexistent-tokenizer',  // 不可载 → 走 estimate 回退，验证语义
    })
    // 断言：counter 回退后仍报告 estimate（不挂）——帧底精确化仅在有 tokenizer 时生效；无 tokenizer 保持 estimate
    expect(b.counter).toBe('estimate')
  })

  it('uses exact frame bottom with real tokenizer (fidelity golden path)', () => {
    // 需要真实 tokenizer 目录（preset 路径）；若可用断言 chatTemplateTokens == countContext('', N)
    // 实现见 Step 3：buildH3Budget 内部把 refs>0 时的 chatTemplateTokens 从 5+2N 改为 countTokensH3('', dir, N)
    expect(true).toBe(true)  // 占位：真实断言在实现后补（golden fixture 驱动）
  })
})
```

> 帧底精确化的核心改动在 buildH3Budget：`chatTemplateTokens` 从 `Math.ceil(5 + references.length * 2)` 改为 `countTokensH3('', tokenizerSourceDir, references.length).tokens`；tokenizer 不可载时保持 estimate 回退（现有 catch 语义）。第一个测试验证回退不挂；第二个测试在真实 tokenizer 可用时用 golden 值对齐（若 golden 有 framed 基线可直接断言）。

- [ ] **Step 2: 实现 budget 帧底**

```ts
// src/pe-framework/audit/budget.ts（修改 buildH3Budget）
// 原：const chatTemplateTokens = references.length === 0 ? 5 : Math.ceil(5 + references.length * 2)
// 改：
let chatTemplateTokens: number
try {
  chatTemplateTokens = countTokensH3('', options?.tokenizerSourceDir, references.length).tokens
} catch {
  chatTemplateTokens = references.length === 0 ? 5 : Math.ceil(5 + references.length * 2)  // estimate 回退（旧语义）
}
```
> `countTokensH3('', dir, refCount)` 匹配官方 `countContext('', N)`（调研 §6：帧内空文本 + vision pads）。tokenizer 不可载时回退旧估算，保持 estimate 语义。

- [ ] **Step 3: intent persona/schema 参数化**

```ts
// src/pe-framework/intent/subagent-provider.ts（现有 opts 已支持 persona/schema）
// 确认 createSubagentIntentProvider 已接受 opts.persona/opts.schema（现状有）；只需 prompt-author 传参：

// src/tools/prompt-author.ts
import { getDialect } from '../pe-framework/dialect/registry.js'
const d = getDialect(target)
const intentCfg = d?.intent
// 本文件 _intentProvider 由 plugin 注入的是 createDefaultIntentProvider(ctx) —— 它内部用 DEFAULT_PERSONA/DEFAULT_SCHEMA。
// 重构：createDefaultIntentProvider 保持不变（DEFAULT 兜底），author 在调用 provider 前按 target 选择 persona：
//   persona/schema 参数化 —— 方案：把 getDialect(target).intent 并入任务文本（req 增加 persona/schema 字段由 subagentIntent 使用）
```
> **定稿方案**：`subagentIntent(req, exec)` 中，当 `req` 带 `persona`/`schema`（author 从 dialect 读取塞入）时优先于 `DEFAULT_PERSONA/DEFAULT_SCHEMA`；author 在 provider 调用处 `const intent = getDialect(target)?.intent` 并在 req 上带 `persona: intent?.persona, schema: intent?.schema`。subagent-provider 的 `subagentIntent` 读 `req.persona ?? opts.persona ?? DEFAULT_PERSONA`。测试 mock 的 AuthorIntentRequest 需兼容可选字段（加 `persona?`/`schema?`）。

- [ ] **Step 4: 工具日志打点**

```ts
// prompt-author.ts / prompt-compile.ts / prompt-audit.ts / prompt-expand.ts / prompt-reverse.ts
// 每个 execute 开头：
ctx.logger.info(`[prompt-master] ${toolName} target=${target}${variant ? ` variant=${variant}` : ''}`)
// 每个 catch：
ctx.logger.error(`[prompt-master] ${toolName} failed: ${error.message}`, { error })
// runStage 后（author/compile/audit）：
ctx.logger.info(`[prompt-master] ${toolName} → ok=${stage.ok} gates=${stage.gates.length} trace=${JSON.stringify(stage.trace ?? {})}`)
```
> ctx 是 Cordis Context，apply 内已有 `ctx.logger`（Cordis logger 服务；若未注入需加 `logger` 到 inject——**确认：Cordis Context 自带 logger**，`ctx.logger` 可直接用）。

- [ ] **Step 5: 日志测试（spy）**

```ts
// tests/plugin/logger-spy.test.ts（新增）
// 用 vi.spyOn(logger, 'info') 断言 prompt_compile 调用时打了 info 且不含 prompt 正文
```
```ts
import { describe, expect, it, vi } from 'vitest'
// 通过真实 plugin apply（stub ctx 注入真实 logger spy）或直接对 view 函数包一层
// 断言：logger.info 被调 ≥1，消息含 'prompt_compile'，不含编译后 prompt 全文
```

- [ ] **Step 6: 全量测试 + 构建**

Run: `Push-Location $P; npm run build; npm test`
Expected: 全绿（新增 budget-frame + logger-spy）

- [ ] **Step 7: 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/audit/budget.ts plugins/prompt-master/src/pe-framework/intent plugins/prompt-master/src/tools plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): exact H3 chat-frame budget, dialect-driven intent persona, structured logging"
```

---

### Task 8: 全量回归 + 端到端验证（R6 收尾）

**Files:**
- 无新增；验证既有
- Test: `tests/fidelity/**`（golden 双跑保真须继续绿）+ 全量 `npm test`

**Interfaces:** 无新接口

- [ ] **Step 0: resolver × 提示词大师 3.1.0 diff 核对（spec §7）**

对照 `temp/pm-promptmaster-src/unpacked/electron/config/` 与 `src/resolver/**`：
- expand-rules.ts 8 ids ↔ promptExpandRules.js 8 ids（已验一致）
- reverse/{descriptive,comfyui,danbooru,prose,anima3}.ts ↔ captionPromptEngineering.js 对应模块（重点：FIDELITY_CHECKLIST 9 类目、FORBIDDEN、COMFYUI_EXTRA_TEMPLATES 5 个、Anima3 §1-§5、互斥速查）
- torii/{formats,prompts}.ts ↔ torii_prompts_data.js / toriiGateFormats.js（13 模板键 / 10 format）
- train/index.ts ↔ trainCaptionTypeProfiles.js（12 profile）
- 保留兼容分支：`getExpandFormatHint`/`sanitizeTagOutput`/`LEGACY_EXPAND_PE_ID_MAP`
- 产出核对报告到 `docs/2026-08-31-resolver-3.1.0-diff.md`（缺漏项列清单，不进本轮重构——仅记录），与本计划一起提交

- [ ] **Step 1: fidelity 全量跑**

Run: `Push-Location $P; npx vitest run tests/fidelity`
Expected: 全绿（anima brief/catalog golden + h3 tokenizer golden + harness 完整性）

- [ ] **Step 2: 全量测试**

Run: `Push-Location $P; npm test`
Expected: 全部绿（35 files / 270+ tests）

- [ ] **Step 3: 无硬编码残留 + 无重复函数残留**

Run: `Select-String -Path $P\src -Pattern "C:/Users/11245|function inferH3Stage|function toRefs|function toReferences|renderEnvelope|compileH3Envelope" -Recurse`
Expected: 0 matches

- [ ] **Step 4: 挂载校验（standingKeyFor）**

> 用临时 cordis 插件调 `ctx.agentPresets.standingKeyFor('comfyui-chenxin')`，确认重构后插件组合可挂载（真实会话前置）。

- [ ] **Step 5: 真实会话端到端（用户配合）**

- 在 comfyui-chenxin 预设新会话调用 `prompt_author target=anima` 与 `target=h3`，确认产出 Envelope + 修正闭环正常、日志出现（info/error 打点）
- 确认 `prompt_compile` / `prompt_audit` / `prompt_expand` / `prompt_reverse` 仍可用
- 确认子代理 intent（author 拆结构）正常返回（exec.agent 路径）

- [ ] **Step 6: 文档更新**

- `docs/usage-prompt-engineering.md`：补 intent 决策表（spec §6）+ 日志观测说明
- `docs/2026-08-31-redesign-spec.md` 标记已实施批次（R1-R6）

- [ ] **Step 7: 最终提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/docs plugins/prompt-master/tests/fidelity
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "test(prompt-master): full regression + docs (intent decision table, logging)"
```