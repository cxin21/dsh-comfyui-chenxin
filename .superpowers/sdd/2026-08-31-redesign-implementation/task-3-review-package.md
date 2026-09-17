# Review package — Task 3 (base e46ae2c..f63f9b2)

## Commits
```f63f9b2 feat(prompt-master): add dialect registry (registerDialect/getDialect/isDialectReady)
```n
## Stat
``` .../src/pe-framework/dialect/contract.ts           | 32 ++++++++++++++++++++++
 .../src/pe-framework/dialect/registry.ts           | 19 +++++++++++++
 .../tests/pe-framework/dialect/registry.test.ts    | 28 +++++++++++++++++++
 3 files changed, 79 insertions(+)
```n
## Full diff (-U10)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/dialect/contract.ts b/plugins/prompt-master/src/pe-framework/dialect/contract.ts
new file mode 100644
index 0000000..8588f7a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/dialect/contract.ts
@@ -0,0 +1,32 @@
+import type { AuditGate, Target } from '../types.js'
+import type { Reference } from '../schema/h3-shots.js'
+
+export type { Target }
+
+export interface PipelineInputLike {
+  target: Target
+  slots?: unknown
+  variant?: string
+  shots?: unknown
+  stage?: string
+  scenarioId?: string
+  formFields?: Record<string, unknown>
+  auditOnly?: boolean
+}
+
+export interface DialectContract<TSlots = unknown, TCompiled = unknown> {
+  id: Target
+  label: string
+  auditOnlyOk: boolean
+  normalize(input: PipelineInputLike, opts: { stage?: string; scenarioId?: string; formFields?: unknown }): {
+    error?: string
+    value?: TSlots
+    stage?: string
+    references?: Reference[]
+  }
+  compile(slots: TSlots, opts: { variant?: string; stage?: string }): TCompiled
+  audit(compiled: TCompiled, ctx: { stage?: string; references?: Reference[]; shots?: unknown; variant?: string }): { gates: AuditGate[]; assumptions?: string[] }
+  budget?(compiled: TCompiled, opts: { stage?: string; references?: Reference[] }): unknown
+  targetSlotHint: string
+  intent?: { persona: string; schema: string }
+}
diff --git a/plugins/prompt-master/src/pe-framework/dialect/registry.ts b/plugins/prompt-master/src/pe-framework/dialect/registry.ts
new file mode 100644
index 0000000..1666a3a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/dialect/registry.ts
@@ -0,0 +1,19 @@
+import type { DialectContract } from './contract.js'
+
+export type { DialectContract }
+import type { Target } from '../types.js'
+
+const dialects = new Map<Target, DialectContract>()
+
+export function registerDialect(contract: DialectContract): void {
+  if (dialects.has(contract.id)) throw new Error(`dialect already registered: ${contract.id}`)
+  dialects.set(contract.id, contract)
+}
+export function getDialect(target: Target): DialectContract | undefined {
+  return dialects.get(target)
+}
+export function isDialectReady(target: Target): boolean {
+  return dialects.has(target)
+}
+/** 仅测试用：清空注册表（模块级单例在 vitest 间的隔离） */
+export function __resetDialectsForTests(): void { dialects.clear() }
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts
new file mode 100644
index 0000000..8df71c7
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts
@@ -0,0 +1,28 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { registerDialect, getDialect, isDialectReady, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
+
+const base: DialectContract = {
+  id: 'anima', label: 'Anima', auditOnlyOk: true,
+  normalize: () => ({ value: {} }), compile: () => ({}), audit: () => ({ gates: [] }),
+  targetSlotHint: 't2i.prompt',
+}
+
+describe('dialect registry', () => {
+  beforeEach(() => { __resetDialectsForTests() })
+
+  it('registers and retrieves a dialect', () => {
+    registerDialect(base)
+    expect(getDialect('anima')).toBe(base)
+    expect(isDialectReady('anima')).toBe(true)
+  })
+
+  it('throws on duplicate registration (fail loud)', () => {
+    registerDialect(base)
+    expect(() => registerDialect({ ...base, label: 'dup' })).toThrow(/already registered/)
+  })
+
+  it('returns undefined for unregistered target', () => {
+    expect(getDialect('sd')).toBeUndefined()
+    expect(isDialectReady('sd')).toBe(false)
+  })
+})
```
