# Review package — Task 4 (base f63f9b2..c9f095d)

## Commits
```c9f095d feat(prompt-master): add runStage pipeline kernel + render envelope layer
```n
## Stat
``` .../src/pe-framework/pipeline/runStage.ts          | 76 +++++++++++++++++++++
 .../src/pe-framework/pipeline/types.ts             | 30 ++++++++
 .../src/pe-framework/render/envelope.ts            | 32 +++++++++
 .../tests/pe-framework/pipeline/runStage.test.ts   | 79 ++++++++++++++++++++++
 4 files changed, 217 insertions(+)
```n
## Full diff (-U10)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
new file mode 100644
index 0000000..1d2a29f
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
@@ -0,0 +1,76 @@
+import { getDialect } from '../dialect/registry.js'
+import type { AuditGate, Budget } from '../types.js'
+import { targetSlotHint } from '../render/envelope.js'
+import type { PipelineInput, PipelineTrace, StageResult } from './types.js'
+
+/**
+ * 唯一管线内核：按注册表调度，零目标业务分支、零日志。
+ * normalize error / auditOnly 不兼容 → throw（可读错误）；方言未注册 → 失败 StageResult。
+ */
+export function runStage(input: PipelineInput): StageResult {
+  const d = getDialect(input.target)
+  if (!d) {
+    const gate: AuditGate = {
+      rule: 'dialect_not_available',
+      target: input.target,
+      severity: 'critical',
+      detail: `方言 ${input.target} 未注册（请以 registerDialect 装配）`,
+      source: 'pipeline/runStage',
+    }
+    return {
+      ok: false,
+      result: {},
+      gates: [gate],
+      advisories: [],
+      assumptions: [],
+      targetSlotHint: targetSlotHint(input.target),
+    }
+  }
+
+  const t0 = performance.now()
+  const auditOnly = input.auditOnly === true
+  if (auditOnly && !d.auditOnlyOk) {
+    throw new Error(`target ${input.target} 不支持 auditOnly`)
+  }
+
+  const normalized = d.normalize(
+    { target: input.target, slots: input.slots, variant: input.variant, shots: input.shots, stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields, auditOnly },
+    { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields },
+  )
+  const tSchema = performance.now()
+  if (normalized.error !== undefined) throw new Error(normalized.error)
+  const slots = normalized.value
+
+  const compiled = d.compile(slots as never, { variant: input.variant, stage: input.stage })
+  const tDialect = performance.now()
+
+  const audit = d.audit(compiled as never, { stage: input.stage, references: normalized.references, shots: input.shots, variant: input.variant })
+  const tAudit = performance.now()
+
+  const budgetRaw = d.budget?.(compiled as never, { stage: input.stage, references: normalized.references })
+  const tBudget = performance.now()
+
+  const ok = audit.gates.every((g) => g.severity !== 'critical')
+  const result: Record<string, unknown> = auditOnly ? {} : (compiled as Record<string, unknown>)
+
+  const renderMs = 0
+  const stages: PipelineTrace['stages'] = [
+    { name: 'schema', ms: tSchema - t0 },
+    { name: 'dialect', ms: tDialect - tSchema },
+    { name: 'audit', ms: tAudit - tDialect },
+    ...(budgetRaw !== undefined ? [{ name: 'budget' as const, ms: tBudget - tAudit }] : []),
+    { name: 'render', ms: renderMs },
+  ]
+  const trace: PipelineTrace = { stages }
+
+  return {
+    ok,
+    result,
+    gates: audit.gates,
+    advisories: [],
+    assumptions: audit.assumptions ?? [],
+    ...(budgetRaw !== undefined ? { budget: budgetRaw as Budget } : {}),
+    targetSlotHint: d.targetSlotHint,
+    trace,
+  }
+}
diff --git a/plugins/prompt-master/src/pe-framework/pipeline/types.ts b/plugins/prompt-master/src/pe-framework/pipeline/types.ts
new file mode 100644
index 0000000..607f2a4
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/pipeline/types.ts
@@ -0,0 +1,30 @@
+import type { AuditGate, Budget } from '../types.js'
+
+export interface PipelineInput {
+  target: 'anima' | 'h3' | 'sd' | 'generic'
+  slots?: Record<string, unknown>
+  variant?: string
+  shots?: unknown
+  stage?: string
+  scenarioId?: string
+  formFields?: Record<string, unknown>
+  auditOnly?: boolean
+}
+
+export interface PipelineTrace {
+  stages: Array<{ name: 'schema' | 'dialect' | 'audit' | 'budget' | 'render'; ms: number }>
+  catalogHits?: number
+  tokenCounter?: 'official-tokenizer' | 'estimate'
+  references?: number
+}
+
+export interface StageResult {
+  ok: boolean
+  result: Record<string, unknown>
+  gates: AuditGate[]
+  advisories: string[]
+  assumptions: string[]
+  budget?: Budget
+  targetSlotHint: string
+  trace?: PipelineTrace
+}
diff --git a/plugins/prompt-master/src/pe-framework/render/envelope.ts b/plugins/prompt-master/src/pe-framework/render/envelope.ts
new file mode 100644
index 0000000..7fa439a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/render/envelope.ts
@@ -0,0 +1,32 @@
+import type { AuditReport } from '../types.js'
+import { serializeReport } from '../audit/report.js'
+import type { StageResult } from '../pipeline/types.js'
+
+/** target → 默认 slot 提示；方言自带 targetSlotHint 时优先使用方言值 */
+export function targetSlotHint(target: string): string {
+  if (target === 'h3') return 't2v.prompt'
+  if (target === 'anima') return 't2i.prompt'
+  return 'generic.prompt'
+}
+
+/**
+ * P1 Envelope 唯一组装点：
+ * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, advisories:[...stage.advisories, ...trail], target_slot_hint }
+ */
+export function assembleEnvelope(stage: StageResult, trail?: string[]): string {
+  const audit: AuditReport = {
+    passed: stage.ok,
+    gates: stage.gates,
+    ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
+    assumptions: stage.assumptions,
+    advisories: [...stage.advisories, ...(trail ?? [])],
+  }
+  const envelope: Record<string, unknown> = {
+    ok: stage.ok,
+    ...(stage.ok ? { result: stage.result } : {}),
+    audit,
+    advisories: audit.advisories,
+    target_slot_hint: stage.targetSlotHint,
+  }
+  return serializeReport(envelope as unknown as AuditReport)
+}
diff --git a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
new file mode 100644
index 0000000..e056d70
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
@@ -0,0 +1,79 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { registerDialect, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
+import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'
+import { assembleEnvelope } from '../../../src/pe-framework/render/envelope.js'
+
+const fakeDialect: DialectContract = {
+  id: 'anima', label: 'Fake', auditOnlyOk: true,
+  normalize: () => ({ value: { a: 1 } }),
+  compile: (v) => ({ positive: 'p', negative: 'n' }),
+  audit: () => ({ gates: [] }),
+  targetSlotHint: 't2i.prompt',
+}
+
+describe('runStage', () => {
+  beforeEach(() => { __resetDialectsForTests() })
+
+  it('dispatches to registered dialect and returns StageResult', () => {
+    registerDialect(fakeDialect)
+    const r = runStage({ target: 'anima' } as any)
+    expect(r.ok).toBe(true)
+    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
+    expect(r.targetSlotHint).toBe('t2i.prompt')
+    expect(r.trace?.stages.length).toBeGreaterThanOrEqual(4)
+  })
+
+  it('unregistered target → failed StageResult with dialect_not_available gate (no throw)', () => {
+    const r = runStage({ target: 'sd' } as any)
+    expect(r.ok).toBe(false)
+    expect(r.gates[0].rule).toBe('dialect_not_available')
+    expect(r.gates[0].severity).toBe('critical')
+    expect(r.gates[0].target).toBe('sd')
+    expect(r.targetSlotHint).toBe('generic.prompt')
+  })
+
+  it('normalize error → throws readable error', () => {
+    registerDialect({ ...fakeDialect, normalize: () => ({ error: 'bad slots: unknown key x' }) })
+    expect(() => runStage({ target: 'anima' } as any)).toThrow(/bad slots/)
+  })
+
+  it('auditOnly=true omits result body', () => {
+    registerDialect(fakeDialect)
+    const r = runStage({ target: 'anima', auditOnly: true } as any)
+    expect(r.result).toEqual({})
+  })
+
+  it('budget present when dialect provides it', () => {
+    registerDialect({ ...fakeDialect, budget: () => ({ counter: 'estimate', tokens: 1, max: 10, over: false }) })
+    const r = runStage({ target: 'anima' } as any)
+    expect(r.budget?.counter).toBe('estimate')
+  })
+
+  it('auditOnly throws when dialect.auditOnlyOk is false', () => {
+    registerDialect({ ...fakeDialect, auditOnlyOk: false })
+    expect(() => runStage({ target: 'anima', auditOnly: true } as any)).toThrow(/auditOnly/)
+  })
+})
+
+describe('assembleEnvelope', () => {
+  it('emits P1 envelope with ok/result/audit/advisories/target_slot_hint', () => {
+    const s = JSON.parse(assembleEnvelope(
+      { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
+      ['trail'],
+    ))
+    expect(s.ok).toBe(true)
+    expect(s.result).toEqual({ x: 1 })
+    expect(s.audit.passed).toBe(true)
+    expect(s.target_slot_hint).toBe('t2i.prompt')
+    expect(s.advisories).toEqual(['a', 'trail'])
+  })
+
+  it('omits result when ok=false (audit_only semantics)', () => {
+    const s = JSON.parse(assembleEnvelope(
+      { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
+    ))
+    expect(s.ok).toBe(false)
+    expect(s.result).toBeUndefined()
+    expect(s.audit.passed).toBe(false)
+  })
+})
```
