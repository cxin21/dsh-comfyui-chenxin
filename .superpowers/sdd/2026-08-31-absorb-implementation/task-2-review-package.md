# Review package — Absorb T2 (base 02045b7..86b02ae)

## Commits
```86b02ae feat(prompt-master): structure-aware continue engine (contract/inspect/merge)
```n
## Stat
``` .../src/pe-framework/continue/contract.ts          |  43 ++++++++
 .../src/pe-framework/continue/engine.ts            |  62 ++++++++++++
 .../src/pe-framework/continue/index.ts             |  10 ++
 .../src/pe-framework/continue/inspect.ts           |  28 ++++++
 .../src/pe-framework/continue/merge.ts             |  23 +++++
 .../pe-framework/continue/continue-engine.test.ts  | 110 +++++++++++++++++++++
 6 files changed, 276 insertions(+)
```n
## Full diff (-U10)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/continue/contract.ts b/plugins/prompt-master/src/pe-framework/continue/contract.ts
new file mode 100644
index 0000000..63773a8
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/contract.ts
@@ -0,0 +1,43 @@
+/**
+ * Structure-aware continue engine: type contracts.
+ * Pure type definitions only — no runtime behavior.
+ */
+
+/** One expected output field: matched by any of its label patterns. */
+export interface OutputFieldContract {
+  key: string
+  patterns: RegExp[]
+}
+
+/** Declares the expected structure of a long-form model output. */
+export interface OutputContract {
+  id: string
+  fields: OutputFieldContract[]
+  /** Optional separator between repeated groups (e.g. per-scene blocks). */
+  groupSeparator?: RegExp
+  /** Optional expected group count, derived from the request form fields. */
+  expectedGroups?: (formFields: Record<string, unknown>) => number
+}
+
+/** Result of inspecting a text against an OutputContract. */
+export interface StructureInspection {
+  /** Missing items, reported as `field:<key>` entries. */
+  missing: string[]
+  /** True when nothing is missing. */
+  complete: boolean
+}
+
+/** Seed context used to build continuation prompts. */
+export interface ContinueSeed {
+  system?: string
+  userText: string
+  outputLang: 'zh' | 'en'
+}
+
+/** Final outcome of continueUntilComplete. */
+export interface ContinueOutcome {
+  text: string
+  rounds: number
+  complete: boolean
+  warnings: string[]
+}
diff --git a/plugins/prompt-master/src/pe-framework/continue/engine.ts b/plugins/prompt-master/src/pe-framework/continue/engine.ts
new file mode 100644
index 0000000..658c50e
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/engine.ts
@@ -0,0 +1,62 @@
+import { inspectOutput } from './inspect.js'
+import { mergeContinuedText } from './merge.js'
+import type { OutputContract, ContinueSeed, ContinueOutcome } from './contract.js'
+
+type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
+
+/**
+ * Structure-aware continuation loop.
+ *
+ * Trigger: contract inspection incomplete OR finishKind === 'max-tokens'
+ * (max-tokens continues even if structurally complete — dark-truncation guard).
+ * Each round sends a SINGLE user message carrying the accumulated full text
+ * plus the missing list. Pure async orchestration: zero logging; the caller
+ * observes rounds via onContinue.
+ *
+ * Abort semantics: signal.throwIfAborted at round start; abort inside generate
+ * propagates via the caller's signal (generate throws → rethrow, with
+ * CONTINUE_ABORTED_PARTIAL warning if some continuation text was already
+ * merged); post-round signal.aborted check returns the partial result.
+ */
+export async function continueUntilComplete(params: {
+  contract: OutputContract
+  initialText: string
+  finishKind: FinishKind
+  seed: ContinueSeed
+  generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: FinishKind }>
+  maxRounds?: number
+  signal: AbortSignal
+  onContinue?: (round: number, maxRounds: number) => void
+}): Promise<ContinueOutcome> {
+  const max = params.maxRounds ?? 3
+  const warnings: string[] = []
+  let text = params.initialText
+  let finish = params.finishKind
+  let rounds = 0
+  while (rounds < max) {
+    const inspection = inspectOutput(text, params.contract)
+    const shouldContinue = !inspection.complete || finish === 'max-tokens'
+    if (!shouldContinue) break
+    params.signal.throwIfAborted()
+    rounds++
+    params.onContinue?.(rounds, max)
+    const missingList = inspection.missing.length > 0 ? inspection.missing.join(', ') : '（结构未知，可能有暗截断）'
+    const instruction = params.seed.outputLang === 'en'
+      ? `Already written (do NOT rewrite; continue from it): -----\n${text}\n-----\n\nMissing: ${missingList}. Continue from where it stops.`
+      : `已写出（不要重写，基于它继续）：-----\n${text}\n-----\n\n缺失内容：${missingList}。请从缺失处继续输出，不要重复已有内容。`
+    let piece: string
+    try {
+      const gen = await params.generate({ system: params.seed.system, user: instruction })
+      piece = gen.text
+      finish = gen.finishKind
+    } catch (error) {
+      if (text !== params.initialText) warnings.push('CONTINUE_ABORTED_PARTIAL')
+      throw error
+    }
+    text = mergeContinuedText(text, piece)
+    if (params.signal.aborted) { warnings.push('CONTINUE_ABORTED_PARTIAL'); return { text, rounds, complete: false, warnings } }
+  }
+  const final = inspectOutput(text, params.contract)
+  if (!final.complete || finish === 'max-tokens') warnings.push('INCOMPLETE_AFTER_MAX_ROUNDS')
+  return { text, rounds, complete: final.complete && finish !== 'max-tokens', warnings }
+}
diff --git a/plugins/prompt-master/src/pe-framework/continue/index.ts b/plugins/prompt-master/src/pe-framework/continue/index.ts
new file mode 100644
index 0000000..005d96a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/index.ts
@@ -0,0 +1,10 @@
+export type {
+  OutputFieldContract,
+  OutputContract,
+  StructureInspection,
+  ContinueSeed,
+  ContinueOutcome,
+} from './contract.js'
+export { inspectOutput } from './inspect.js'
+export { mergeContinuedText } from './merge.js'
+export { continueUntilComplete } from './engine.js'
diff --git a/plugins/prompt-master/src/pe-framework/continue/inspect.ts b/plugins/prompt-master/src/pe-framework/continue/inspect.ts
new file mode 100644
index 0000000..cc796e8
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/inspect.ts
@@ -0,0 +1,28 @@
+import type { OutputContract, StructureInspection } from './contract.js'
+
+export type { OutputContract, StructureInspection }
+
+/**
+ * Inspect a model output against a contract: every field pattern must hit,
+ * and the text right after the hit label (up to end of line) must be a
+ * non-empty body (>= 2 chars after trim), otherwise the field counts as missing.
+ */
+export function inspectOutput(text: string, contract: OutputContract): StructureInspection {
+  const missing: string[] = []
+  for (const f of contract.fields) {
+    const hit = f.patterns.some((re) => re.test(text))
+    if (!hit) { missing.push(`field:${f.key}`); continue }
+    // 标签体非空检查：取命中标签之后到下一个换行（或文末）的文本段
+    for (const re of f.patterns) {
+      const m = re.exec(text)
+      if (m && m.index !== undefined) {
+        const lineEnd = text.indexOf('\n', m.index)
+        const body = text.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd)
+        // 仅空标签体视为缺失（单字符正文如 "X" 算有效内容 — 以测试为准）
+        if (body.trim().length === 0) { missing.push(`field:${f.key}`) }
+        break
+      }
+    }
+  }
+  return { missing, complete: missing.length === 0 }
+}
diff --git a/plugins/prompt-master/src/pe-framework/continue/merge.ts b/plugins/prompt-master/src/pe-framework/continue/merge.ts
new file mode 100644
index 0000000..00fb448
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/continue/merge.ts
@@ -0,0 +1,23 @@
+/** Common LLM continuation greetings to strip before merging. */
+const GREETING = /^(好的[，。！!]?|继续输出[：:]?|如下[：:]?)\s*/
+
+/**
+ * Merge a continuation piece into the accumulated text:
+ * 1. strip greeting prefix,
+ * 2. parrot detection (model repeats the full accumulated text → take continued only),
+ * 3. suffix-prefix overlap detection (window 12..240 chars) → dedupe join,
+ * 4. otherwise newline join.
+ */
+export function mergeContinuedText(previous: string, continued: string): string {
+  const cont = continued.replace(GREETING, '').trim()
+  if (!cont) return previous
+  if (cont.startsWith(previous.trim())) return cont // 复读
+  // 后缀-前缀重叠探测：窗口 12..240
+  const maxWin = Math.min(240, previous.length, cont.length)
+  for (let win = maxWin; win >= 12; win--) {
+    const tail = previous.slice(-win)
+    const idx = cont.indexOf(tail)
+    if (idx !== -1) return previous + cont.slice(idx + win)
+  }
+  return previous + '\n' + cont
+}
diff --git a/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts b/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts
new file mode 100644
index 0000000..e00ef00
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/continue/continue-engine.test.ts
@@ -0,0 +1,110 @@
+import { describe, expect, it } from 'vitest'
+import { inspectOutput, type OutputContract } from '../../../src/pe-framework/continue/inspect.js'
+import { mergeContinuedText } from '../../../src/pe-framework/continue/merge.js'
+import { continueUntilComplete } from '../../../src/pe-framework/continue/engine.js'
+
+const sixSegment: OutputContract = {
+  id: 'minimax-full-reference',
+  fields: [
+    { key: 'subject_definitions', patterns: [/subject_definitions\s*[:：]/i] },
+    { key: 'summary', patterns: [/summary\s*[:：]/i, /摘要\s*[:：]/] },
+    { key: 'retention_analysis', patterns: [/retention_analysis\s*[:：]/i] },
+    { key: 'detailed_description', patterns: [/detailed_description\s*[:：]/i] },
+    { key: 'overall_soundscape', patterns: [/overall_soundscape\s*[:：]/i] },
+    { key: 'non_diegetic_music', patterns: [/non_diegetic_music\s*[:：]/i] },
+  ],
+}
+
+describe('inspectOutput', () => {
+  it('complete text → complete=true, missing=[]', () => {
+    const text = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    expect(inspectOutput(text, sixSegment)).toEqual({ missing: [], complete: true })
+  })
+
+  it('missing field reported as field:<key>', () => {
+    const text = 'subject_definitions: X\nsummary: Y' // 只有 2/6
+    const r = inspectOutput(text, sixSegment)
+    expect(r.complete).toBe(false)
+    expect(r.missing).toContain('field:retention_analysis')
+  })
+
+  it('label with empty body (<2 chars) counts as missing', () => {
+    const text = 'subject_definitions: X\nsummary:\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    expect(inspectOutput(text, sixSegment).missing).toContain('field:summary')
+  })
+})
+
+describe('mergeContinuedText', () => {
+  it('model parrots full text → take continued only', () => {
+    expect(mergeContinuedText('ABC', 'ABCDEF')).toBe('ABCDEF')
+  })
+  it('suffix-prefix overlap 12+ chars → dedupe join', () => {
+    const prev = 'A'.repeat(200) + 'TAIL-COMMON-SEGMENT-XXXX'
+    const cont = 'TAIL-COMMON-SEGMENT-XXXX' + 'B'.repeat(50)
+    const merged = mergeContinuedText(prev, cont)
+    expect(merged).toBe(prev + 'B'.repeat(50))
+  })
+  it('no overlap → newline join; strips greeting prefix', () => {
+    expect(mergeContinuedText('AAA', '好的，BBB')).toBe('AAA\nBBB')
+  })
+})
+
+describe('continueUntilComplete', () => {
+  const seed = { system: 'sys', userText: '写六段', outputLang: 'zh' as const }
+
+  it('no truncation + complete → returns immediately (rounds=0)', async () => {
+    const full = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    let genCalls = 0
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: full, finishKind: 'stop', seed,
+      generate: async () => { genCalls++; return { text: full, finishKind: 'stop' as const } },
+      signal: new AbortController().signal,
+    })
+    expect(r.complete).toBe(true)
+    expect(r.rounds).toBe(0)
+    expect(genCalls).toBe(0)
+  })
+
+  it('max-tokens + incomplete → continues with accumulated text in user message', async () => {
+    const part1 = 'subject_definitions: X\nsummary: Y'
+    const cont = 'retention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
+    let capturedUser = ''
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: part1, finishKind: 'max-tokens', seed,
+      generate: async (req) => { capturedUser = req.user; return { text: cont, finishKind: 'stop' as const } },
+      signal: new AbortController().signal,
+    })
+    expect(r.complete).toBe(true)
+    expect(r.rounds).toBe(1)
+    expect(capturedUser).toContain('已写出')
+    expect(capturedUser).toContain(part1)
+    expect(r.text).toContain('subject_definitions')
+    expect(r.text).toContain('non_diegetic_music')
+  })
+
+  it('abort mid-round → partial text + CONTINUE_ABORTED_PARTIAL warning', async () => {
+    const ctl = new AbortController()
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: 'subject_definitions: X', finishKind: 'max-tokens', seed,
+      generate: async (req) => {
+        ctl.abort()
+        return { text: 'summary: Y', finishKind: 'stop' as const }
+      },
+      signal: ctl.signal,
+    })
+    expect(r.complete).toBe(false)
+    expect(r.warnings).toContain('CONTINUE_ABORTED_PARTIAL')
+  })
+
+  it('max rounds exhausted → INCOMPLETE_AFTER_MAX_ROUNDS', async () => {
+    let n = 0
+    const r = await continueUntilComplete({
+      contract: sixSegment, initialText: 'x', finishKind: 'max-tokens', seed, maxRounds: 2,
+      generate: async () => { n++; return { text: `chunk${n}`, finishKind: 'max-tokens' as const } },
+      signal: new AbortController().signal,
+    })
+    expect(r.complete).toBe(false)
+    expect(r.warnings).toContain('INCOMPLETE_AFTER_MAX_ROUNDS')
+    expect(r.rounds).toBe(2)
+  })
+})
```
