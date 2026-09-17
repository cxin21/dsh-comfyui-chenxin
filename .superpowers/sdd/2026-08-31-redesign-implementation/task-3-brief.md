# Task 3 Brief: 方言注册表 registerDialect / getDialect / isDialectReady

## 背景
prompt-master DSH 插件重构（方案 A）第 3 个任务。为"一条管线、多个方言"打地基：定义 DialectContract 接口 + 注册表。Task 4（runStage 内核）与 Task 5（anima/h3 注册）依赖本任务的接口。本任务是纯新增——两个新文件 + 一个测试文件，不改任何现有文件。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 全局约束
- 测试 `npx vitest run <file>`；构建 `npm run build`（tsc, NodeNext ESM, import 带 `.js` 后缀）
- git 根 = `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`
- 重复注册 fail loud（throw `dialect already registered: <id>`）
- 纯数据结构，零日志、零 IO
- 现有类型来源（import 用）：`AuditGate`/`Target` 在 `../types.js`（src/pe-framework/types.ts）；`Reference` 在 `../schema/h3-shots.js`——**先 read 这两个文件确认导出名**，若 `Target` 未从 types.ts 导出则以实际为准（它可能是 `'anima' | 'h3' | 'sd' | 'generic'` 的本地类型；必要时在 contract.ts 里 `export type Target = ...` 并从 types.js re-import 或本地定义——以编译通过为准，不要改 types.ts 除非 Target 缺失）

## Files
- Create: `src/pe-framework/dialect/contract.ts`
- Create: `src/pe-framework/dialect/registry.ts`
- Test: `tests/pe-framework/dialect/registry.test.ts`

## Interfaces（Produces——Task 4/5 精确依赖这些签名）

### contract.ts
```ts
import type { AuditGate } from '../types.js'
import type { Reference } from '../schema/h3-shots.js'

export interface PipelineInputLike {
  target: Target            // 见上方"现有类型来源"说明
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
注意 `audit` ctx 的 `variant?: string` 是必须的（Task 5 anima.audit 用它）。

### registry.ts
```ts
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
/** 仅测试用：清空注册表（模块级单例在 vitest 间的隔离） */
export function __resetDialectsForTests(): void { dialects.clear() }
```

## TDD 步骤

### Step 1: 写失败测试
```ts
// tests/pe-framework/dialect/registry.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { registerDialect, getDialect, isDialectReady, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'

const base: DialectContract = {
  id: 'anima', label: 'Anima', auditOnlyOk: true,
  normalize: () => ({ value: {} }), compile: () => ({}), audit: () => ({ gates: [] }),
  targetSlotHint: 't2i.prompt',
}

describe('dialect registry', () => {
  beforeEach(() => { __resetDialectsForTests() })

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

### Step 2: 运行确认失败
`npx vitest run tests/pe-framework/dialect/registry.test.ts` → FAIL（模块不存在）

### Step 3: 实现两个文件（代码如上 Interfaces）

### Step 4: 运行确认通过
3 tests PASS

### Step 5: 构建 + 提交
`npm run build` → exit 0
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect/contract.ts plugins/prompt-master/src/pe-framework/dialect/registry.ts plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): add dialect registry (registerDialect/getDialect/isDialectReady)"
```

## 验收
- 3 测试绿；build exit 0；全量测试不回归（纯新增文件）