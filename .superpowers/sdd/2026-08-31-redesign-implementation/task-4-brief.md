# Task 4 Brief: runStage 内核 + render/ 层（assembleEnvelope + targetSlotHint）

## 背景
方案 A 第 4 个任务：把五层管线收拢为**唯一内核 `runStage`**（纯函数、零 LLM、按注册表调度）+ 新建 render/ 层（P1 Envelope 唯一组装点）。Task 3 的 registry 已存在（`getDialect`/`DialectContract`）。Task 6 将把 author/compile/audit 三个工具改为本内核的薄视图——**本任务的输出形状就是它们的公共依赖**。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 全局约束
- 测试 `npx vitest run <file>`；构建 `npm run build`；git 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`
- `runStage` 永不写 `if(target==='anima')` 式业务分支——只查注册表
- 纯函数零日志；返回 `trace`（性能数据）
- `AuditGate` 形状（src/pe-framework/types.ts）：`{ rule: string; target: Target; severity: Severity; detail: string; source?: string }` —— DIALECT_NOT_AVAILABLE gate 必须带 `target` 字段
- 现有 `serializeReport` 在 `src/pe-framework/audit/report.ts`（read 确认签名后使用）

## Files
- Create: `src/pe-framework/pipeline/types.ts`
- Create: `src/pe-framework/pipeline/runStage.ts`
- Create: `src/pe-framework/render/envelope.ts`
- Test: `tests/pe-framework/pipeline/runStage.test.ts`

## Consumes（Task 3）
```ts
// src/pe-framework/dialect/registry.ts
export { DialectContract } from './contract.js'   // re-export（已实现）
export function registerDialect(contract: DialectContract): void
export function getDialect(target: Target): DialectContract | undefined
export function __resetDialectsForTests(): void
// contract.ts: DialectContract<TSlots, TCompiled> = { id, label, auditOnlyOk, normalize(input, opts) → {error?, value?, stage?, references?}, compile(slots, opts:{variant?, stage?}) → TCompiled, audit(compiled, ctx:{stage?, references?, shots?, variant?}) → {gates, assumptions?}, budget?(compiled, opts) → unknown, targetSlotHint, intent? }
```

## Produces（Task 6 依赖）
```ts
// src/pe-framework/pipeline/types.ts
import type { AuditGate, Budget } from '../types.js'

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
  stages: Array<{ name: 'schema' | 'dialect' | 'audit' | 'budget' | 'render'; ms: number }>
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
export function targetSlotHint(target: string): string   // h3→'t2v.prompt'; anima→'t2i.prompt'; 其他→'generic.prompt'
export function assembleEnvelope(stage: StageResult, trail?: string[]): string
// P1 Envelope: { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, advisories:[...stage.advisories, ...trail], target_slot_hint }
// 序列化用 serializeReport（audit/report.ts）
```
```ts
// src/pe-framework/pipeline/runStage.ts
export function runStage(input: PipelineInput): StageResult
```

## runStage 行为规格（精确）

1. `const d = getDialect(input.target)`；未注册 → 返回失败 StageResult（不 throw）：
```ts
{
  ok: false, result: {},
  gates: [{ rule: 'dialect_not_available', target: input.target, severity: 'critical', detail: `方言 ${input.target} 未注册（请以 registerDialect 装配）`, source: 'pipeline/runStage' }],
  advisories: [], assumptions: [],
  targetSlotHint: targetSlotHint(input.target),
}
```
2. `input.auditOnly === true && d.auditOnlyOk === false` → throw `target ${target} 不支持 auditOnly`
3. `d.normalize(...)` 返回 `error` → throw 该 error 字符串
4. 编译 → 审计 → 可选 budget（`d.budget?.(...)` 结果非 undefined 时放入 `budget` 字段，cast 为 `Budget`）
5. `ok = gates.every(g => g.severity !== 'critical')`
6. `result`：`auditOnly===true` 时为 `{}`，否则为 compiled（cast Record<string,unknown>）
7. `trace`：至少 `stages: [{name:'schema',ms},{name:'dialect',ms},{name:'audit',ms},{name:'budget',ms}?,{name:'render',ms}]`（用 `performance.now()` 差值；budget 无时省略该条）
8. `assumptions: audit.assumptions ?? []`；`advisories: []`（本层不产 advisory）

## TDD 步骤

### Step 1: 失败测试
```ts
// tests/pe-framework/pipeline/runStage.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { registerDialect, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'
import { assembleEnvelope } from '../../../src/pe-framework/render/envelope.js'

const fakeDialect: DialectContract = {
  id: 'anima', label: 'Fake', auditOnlyOk: true,
  normalize: () => ({ value: { a: 1 } }),
  compile: (v) => ({ positive: 'p', negative: 'n' }),
  audit: () => ({ gates: [] }),
  targetSlotHint: 't2i.prompt',
}

describe('runStage', () => {
  beforeEach(() => { __resetDialectsForTests() })

  it('dispatches to registered dialect and returns StageResult', () => {
    registerDialect(fakeDialect)
    const r = runStage({ target: 'anima' } as any)
    expect(r.ok).toBe(true)
    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
    expect(r.targetSlotHint).toBe('t2i.prompt')
    expect(r.trace?.stages.length).toBeGreaterThanOrEqual(4)
  })

  it('unregistered target → failed StageResult with dialect_not_available gate (no throw)', () => {
    const r = runStage({ target: 'sd' } as any)
    expect(r.ok).toBe(false)
    expect(r.gates[0].rule).toBe('dialect_not_available')
    expect(r.gates[0].severity).toBe('critical')
    expect(r.gates[0].target).toBe('sd')
    expect(r.targetSlotHint).toBe('generic.prompt')
  })

  it('normalize error → throws readable error', () => {
    registerDialect({ ...fakeDialect, normalize: () => ({ error: 'bad slots: unknown key x' }) })
    expect(() => runStage({ target: 'anima' } as any)).toThrow(/bad slots/)
  })

  it('auditOnly=true omits result body', () => {
    registerDialect(fakeDialect)
    const r = runStage({ target: 'anima', auditOnly: true } as any)
    expect(r.result).toEqual({})
  })

  it('budget present when dialect provides it', () => {
    registerDialect({ ...fakeDialect, budget: () => ({ counter: 'estimate', tokens: 1, max: 10, over: false }) })
    const r = runStage({ target: 'anima' } as any)
    expect(r.budget?.counter).toBe('estimate')
  })

  it('auditOnly throws when dialect.auditOnlyOk is false', () => {
    registerDialect({ ...fakeDialect, auditOnlyOk: false })
    expect(() => runStage({ target: 'anima', auditOnly: true } as any)).toThrow(/auditOnly/)
  })
})

describe('assembleEnvelope', () => {
  it('emits P1 envelope with ok/result/audit/advisories/target_slot_hint', () => {
    const s = JSON.parse(assembleEnvelope(
      { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
      ['trail'],
    ))
    expect(s.ok).toBe(true)
    expect(s.result).toEqual({ x: 1 })
    expect(s.audit.passed).toBe(true)
    expect(s.target_slot_hint).toBe('t2i.prompt')
    expect(s.advisories).toEqual(['a', 'trail'])
  })

  it('omits result when ok=false (audit_only semantics)', () => {
    const s = JSON.parse(assembleEnvelope(
      { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
    ))
    expect(s.ok).toBe(false)
    expect(s.result).toBeUndefined()
    expect(s.audit.passed).toBe(false)
  })
})
```

### Step 2: 确认失败 → Step 3: 实现 → Step 4: 确认通过
（按行为规格实现三个文件）

### Step 5: 构建 + 全量 + 提交
`npm run build` exit 0；`npx vitest run` 全绿（285+8=293 预期）
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/pipeline plugins/prompt-master/src/pe-framework/render plugins/prompt-master/tests/pe-framework/pipeline
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): add runStage pipeline kernel + render envelope layer"
```

## 注意
- `serializeReport` 的实际签名先 read `src/pe-framework/audit/report.ts`——它可能要求特定输入形状（如 Record<string,unknown>）；按需 cast，保持 Envelope 键名精确为 `ok/result/audit/advisories/target_slot_hint`
- 现 envelope 的 `audit` 键当前实现（prompt-author.ts renderEnvelope）是 `{ passed, gates, ...(budget?{budget}:{}) }` —— 保持一致
- 若 serializeReport 对 JSON.stringify 有特殊处理（缩进等），不影响测试（测试 parse 后断言）
