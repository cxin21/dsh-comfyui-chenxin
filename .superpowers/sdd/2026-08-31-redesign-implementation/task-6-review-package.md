# Review package — Task 6 (base 84ea750..761120b)

## Commits
```761120b refactor(prompt-master): tools become thin views over runStage (remove duplicate orchestration)
```n
## Stat
``` .../prompt-master/src/pe-framework/dialect/h3.ts   |  21 +--
 .../src/pe-framework/pipeline/runStage.ts          |   8 +-
 .../src/pe-framework/render/envelope.ts            |   9 +-
 plugins/prompt-master/src/tools/prompt-audit.ts    |  15 +-
 plugins/prompt-master/src/tools/prompt-author.ts   | 155 ++++++++-------------
 plugins/prompt-master/src/tools/prompt-compile.ts  | 104 +++++---------
 .../tests/pe-framework/pipeline/runStage.test.ts   |   2 +
 .../prompt-master/tests/plugin/compile-h3.test.ts  |  51 ++++---
 .../prompt-master/tests/plugin/h3-dialect.test.ts  |   2 +-
 9 files changed, 150 insertions(+), 217 deletions(-)
```n
## Full diff (-U10, src+tests)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/dialect/h3.ts b/plugins/prompt-master/src/pe-framework/dialect/h3.ts
index 7989835..eafedbc 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/h3.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/h3.ts
@@ -1,18 +1,18 @@
 /**
  * H3 authoring dialect（TS 移植，逐字符对照 h3_prompt/dialect.py）。
  */
 import { KEYFRAME_STAGES, type Reference, type H3Shot, type StoryRequest, type H3ShotsInput } from '../schema/h3-shots.js'
 import { registerDialect } from './registry.js'
 import type { DialectContract } from './contract.js'
 import { contractGatesH3, auditH3Full } from '../audit/rules-h3.js'
-import { buildH3Budget } from '../audit/budget.js'
+import { buildH3Budget, h3BudgetToReport } from '../audit/budget.js'
 import { H3_PERSONA, H3_SCHEMA } from '../intent/subagent-provider.js'
 
 const CJK = /[\u4e00-\u9fff]/
 const KANA = /[\u3040-\u30ff]/
 const END_PUNCT = '.!?…'
 
 export function formatTimestamp(seconds: number): string {
   const totalMs = Math.round(seconds * 1000)
   const minutes = Math.floor(totalMs / 60_000)
   const rem = totalMs % 60_000
@@ -236,52 +236,53 @@ export function buildTextZh(textEn: string): string {
     outLines.push(skeletonTokenize(stripped))
   }
   return outLines.join('\n').trim()
 }
 
 export function buildTextPair(stage: string, request: StoryRequest): { text: string; textZh: string } {
   const textEn = buildText(stage, request)
   return { text: textEn, textZh: buildTextZh(textEn) }
 }
 
-/** 供 T7/E2E 消费（brief 接口）：输入扁平 story → {text, textZh} */
+/** 供 T7/E2E 消费（brief 接口）：输入扁平 story → {text, text_zh}（Task 6 键桥接：result 键直接匹配 golden text_zh） */
 export function compileH3(
   input: { duration_seconds: number; shots: H3Shot[]; references?: unknown[] },
   opts?: { stage?: string },
-): { text: string; textZh: string } {
+): { text: string; text_zh: string } {
   const stage = opts?.stage ?? 't2va'
   const refs: Reference[] = Array.isArray(input.references)
     ? (input.references as unknown[]).map((r) => {
         const raw = r as Record<string, unknown>
         return {
           who: raw['who'] != null ? String(raw['who']) : null,
           image: String(raw['image'] ?? ''),
           width: typeof raw['width'] === 'number' ? raw['width'] : null,
           height: typeof raw['height'] === 'number' ? raw['height'] : null,
         }
       })
     : []
   const request: StoryRequest = {
     stage,
     duration_seconds: input.duration_seconds,
     shots: input.shots,
     references: refs,
     videos: [],
     audios: [],
   }
-  return buildTextPair(stage, request)
+  const pair = buildTextPair(stage, request)
+  return { text: pair.text, text_zh: pair.textZh }
 }
 
-/* ── Task 5：方言注册（normalize 收敛 inferH3Stage/toRefs；工具侧副本 Task 6 删）── */
+/* ── Task 5：方言注册（normalize 收敛 inferH3Stage/refs 归一；工具侧副本 Task 6 删）── */
 
-/** toRefs 移植（prompt-author.ts 收敛单点）：who/image 字符串化 + width/height 仅接受 number（否则 null） */
-function toRefsNormalized(raw: unknown[]): Reference[] {
+/** refs 归一单点（prompt-author/prompt-compile/prompt-audit 的 toRefs 收敛）：who/image 字符串化 + width/height 仅接受 number（否则 null） */
+export function normalizeRefs(raw: unknown[]): Reference[] {
   return raw.map((r) => {
     const x = r as Record<string, unknown>
     return {
       who: x['who'] != null ? String(x['who']) : null,
       image: String(x['image'] ?? ''),
       width: typeof x['width'] === 'number' ? x['width'] : null,
       height: typeof x['height'] === 'number' ? x['height'] : null,
     }
   })
 }
@@ -291,41 +292,41 @@ export function normalizeH3Input(
   input: unknown,
   opts: { stage?: string; scenarioId?: string; formFields?: unknown },
 ): { error?: string; value?: H3ShotsInput; stage?: string; references?: Reference[] } {
   const shots = (input as { shots?: H3ShotsInput } | undefined)?.shots
   if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) {
     return { error: 'intent 未产出 shots 结构' }
   }
   const formRefs = Array.isArray((opts.formFields as Record<string, unknown> | undefined)?.references)
     ? ((opts.formFields as Record<string, unknown>).references as unknown[]) : []
   const refs = Array.isArray(shots.references) ? shots.references : []
-  const references = toRefsNormalized(refs.length > 0 ? refs : formRefs)
+  const references = normalizeRefs(refs.length > 0 ? refs : formRefs)
   // 优先级与现 prompt-author.ts inferH3Stage 一致：显式 stage > references 存在 > scenarioId==='full_reference' > t2va
   const stage = opts.stage || (references.length > 0 ? 'ref2va' : opts.scenarioId === 'full_reference' ? 'ref2va' : 't2va')
   return { value: shots, stage, references }
 }
 
 export function registerH3Dialect(): void {
-  const contract: DialectContract<H3ShotsInput, { text: string; textZh: string }> = {
+  const contract: DialectContract<H3ShotsInput, { text: string; text_zh: string }> = {
     id: 'h3',
     label: 'MiniMax-H3',
     auditOnlyOk: true,
     normalize: (input, opts) => normalizeH3Input(input, opts),
     compile: (shots, opts) => compileH3(shots, { stage: opts.stage ?? 't2va' }),
     audit: (compiled, ctx) => {
       const stage = ctx.stage ?? 't2va'
       const shots = ctx.shots as H3ShotsInput
       const gates = [
         ...contractGatesH3(stage, shots, ctx.references ?? []),
         ...auditH3Full(compiled.text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, ctx.references),
       ]
       return { gates, assumptions: [] }
     },
-    budget: (compiled, ctx) => buildH3Budget(ctx.stage ?? 't2va', compiled.text, ctx.references ?? []),
+    budget: (compiled, ctx) => h3BudgetToReport(buildH3Budget(ctx.stage ?? 't2va', compiled.text, ctx.references ?? [])),
     targetSlotHint: 't2v.prompt',
     intent: { persona: H3_PERSONA, schema: H3_SCHEMA },
   }
   registerDialect(contract)
 }
 
 // 模块级副作用注册：plugin/index.ts import 本模块即完成装配
 registerH3Dialect()
\ No newline at end of file
diff --git a/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
index 15cc384..126410f 100644
--- a/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
+++ b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
@@ -33,28 +33,30 @@ export function runStage(input: PipelineInput): StageResult {
     throw new Error(`target ${input.target} 不支持 auditOnly`)
   }
 
   const normalized = d.normalize(
     { target: input.target, slots: input.slots, variant: input.variant, shots: input.shots, stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields, auditOnly },
     { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields },
   )
   const tSchema = performance.now()
   if (normalized.error !== undefined) throw new Error(normalized.error)
   const slots = normalized.value
+  // normalize 单点推断的 stage（h3: references/full_reference → ref2va）优先于显式输入（Task 6：工具侧 inferH3Stage 已删）
+  const stage = normalized.stage ?? input.stage
 
-  const compiled = d.compile(slots as never, { variant: input.variant, stage: input.stage })
+  const compiled = d.compile(slots as never, { variant: input.variant, stage })
   const tDialect = performance.now()
 
-  const audit = d.audit(compiled as never, { stage: input.stage, references: normalized.references, shots: normalized.value ?? input.shots, variant: input.variant })
+  const audit = d.audit(compiled as never, { stage, references: normalized.references, shots: normalized.value ?? input.shots, variant: input.variant })
   const tAudit = performance.now()
 
-  const budgetRaw = d.budget?.(compiled as never, { stage: input.stage, references: normalized.references })
+  const budgetRaw = d.budget?.(compiled as never, { stage, references: normalized.references })
   const tBudget = performance.now()
 
   const ok = audit.gates.every((g) => g.severity !== 'critical')
   const result: Record<string, unknown> = auditOnly ? {} : (compiled as Record<string, unknown>)
 
   const renderMs = 0
   const stages: PipelineTrace['stages'] = [
     { name: 'schema', ms: tSchema - t0 },
     { name: 'dialect', ms: tDialect - tSchema },
     { name: 'audit', ms: tAudit - tDialect },
diff --git a/plugins/prompt-master/src/pe-framework/render/envelope.ts b/plugins/prompt-master/src/pe-framework/render/envelope.ts
index 7fa439a..1a232e5 100644
--- a/plugins/prompt-master/src/pe-framework/render/envelope.ts
+++ b/plugins/prompt-master/src/pe-framework/render/envelope.ts
@@ -3,30 +3,29 @@ import { serializeReport } from '../audit/report.js'
 import type { StageResult } from '../pipeline/types.js'
 
 /** target → 默认 slot 提示；方言自带 targetSlotHint 时优先使用方言值 */
 export function targetSlotHint(target: string): string {
   if (target === 'h3') return 't2v.prompt'
   if (target === 'anima') return 't2i.prompt'
   return 'generic.prompt'
 }
 
 /**
- * P1 Envelope 唯一组装点：
+ * P1 Envelope 唯一组装点（Task 4 定案：audit 收敛为 legacy 形状 {passed, gates, budget?}；
+ * assumptions/advisories 不再入 audit 对象——顶层 advisories 是唯一读取点）：
  * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, advisories:[...stage.advisories, ...trail], target_slot_hint }
  */
 export function assembleEnvelope(stage: StageResult, trail?: string[]): string {
-  const audit: AuditReport = {
+  const audit = {
     passed: stage.ok,
     gates: stage.gates,
     ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
-    assumptions: stage.assumptions,
-    advisories: [...stage.advisories, ...(trail ?? [])],
   }
   const envelope: Record<string, unknown> = {
     ok: stage.ok,
     ...(stage.ok ? { result: stage.result } : {}),
     audit,
-    advisories: audit.advisories,
+    advisories: [...stage.advisories, ...(trail ?? [])],
     target_slot_hint: stage.targetSlotHint,
   }
   return serializeReport(envelope as unknown as AuditReport)
 }
diff --git a/plugins/prompt-master/src/tools/prompt-audit.ts b/plugins/prompt-master/src/tools/prompt-audit.ts
index 9daf339..e73793b 100644
--- a/plugins/prompt-master/src/tools/prompt-audit.ts
+++ b/plugins/prompt-master/src/tools/prompt-audit.ts
@@ -1,12 +1,13 @@
 import { defineTool } from '@deepseek-ai/dsh-tools'
 import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
+import { normalizeRefs } from '../pe-framework/dialect/h3.js'
 import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
 import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
 import { serializeReport } from '../pe-framework/audit/report.js'
 import type { AuditGate } from '../pe-framework/types.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface AuditContent {
   target: 'anima' | 'h3'
@@ -41,43 +42,31 @@ export function auditContentEnvelope(content: AuditContent): string {
     if (typeof content.text !== 'string') throw new Error('h3 审计需要 text 文本')
     const stage = content.stage ?? 't2va'
     const duration = content.duration ?? 10
     const shotCount = content.shotCount ?? ((content.text.match(/\[Shot \d+\]/g) ?? []).length || 1)
     const references = content.references ?? []
     const shots: H3ShotsInput = { duration_seconds: duration, shots: [{ what: content.text.slice(0, 200) }] }
     gates = [
       ...contractGatesH3(stage, { duration_seconds: duration, shots: [{ what: 'x' }] }, references),
       ...auditH3Full(content.text, { stage, duration, shotCount }, references),
     ]
-    budget = h3BudgetToReport(buildH3Budget(stage, content.text, toRefs(references)))
+    budget = h3BudgetToReport(buildH3Budget(stage, content.text, normalizeRefs(references)))
     ok = gates.every((g) => g.severity !== 'critical')
     void shots
   }
   return serializeReport({
     ok,
     audit: { passed: ok, gates, ...(budget ? { budget } : {}) },
     advisories: [],
   } as never)
 }
 
-function toRefs(raw: unknown[]): Array<{ who: string | null; image: string; width: number | null; height: number | null }> {
-  return raw.map((r) => {
-    const x = r as Record<string, unknown>
-    return {
-      who: x['who'] != null ? String(x['who']) : null,
-      image: String(x['image'] ?? ''),
-      width: typeof x['width'] === 'number' ? x['width'] : null,
-      height: typeof x['height'] === 'number' ? x['height'] : null,
-    }
-  })
-}
-
 export function registerAuditTool(_ctx: Context, _config: Config) {
   return defineTool({
     name: 'prompt_audit',
     description:
       '纯审计闸门（无 LLM）：按 target 对已有内容直接跑审计 + budget（anima: positive/negative（可附 slots）；h3: text + stage/duration/shotCount/references）。',
     parameters: {
       target: { type: 'string', default: 'h3', description: 'anima | h3' },
       positive: { type: 'string', default: '', description: 'anima positive' },
       negative: { type: 'string', default: '', description: 'anima negative' },
       variant: { type: 'string', default: 'base', description: 'anima variant' },
diff --git a/plugins/prompt-master/src/tools/prompt-author.ts b/plugins/prompt-master/src/tools/prompt-author.ts
index aba6974..e6fca5f 100644
--- a/plugins/prompt-master/src/tools/prompt-author.ts
+++ b/plugins/prompt-master/src/tools/prompt-author.ts
@@ -1,41 +1,42 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { TARGETS, type Target } from '../pe-framework/index.js'
-import { serializeReport, buildAuditReport } from '../pe-framework/audit/index.js'
-import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
-import { compileH3 } from '../pe-framework/dialect/h3.js'
-import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
-import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
+import { serializeReport } from '../pe-framework/audit/index.js'
+import type { AnimaSlots } from '../pe-framework/dialect/anima.js'
+// 方言模块副作用注册（Task 6：DIALECT_READY 静态表 → 注册表查询）
+import '../pe-framework/dialect/anima.js'
+import '../pe-framework/dialect/h3.js'
+import { isDialectReady as registryIsDialectReady } from '../pe-framework/dialect/registry.js'
+import { runStage } from '../pe-framework/pipeline/runStage.js'
+import { assembleEnvelope } from '../pe-framework/render/envelope.js'
+import type { StageResult } from '../pe-framework/pipeline/types.js'
 import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
-import type { AuditGate } from '../pe-framework/types.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
 
 export interface AuthorArgs {
   target: Target
   input: string
   profile?: string
   variant?: string
   stage?: string
   scenario_id?: string
   form_fields?: Record<string, unknown>
   audit_only?: boolean
 }
 
-/** 方言归化状态机：T13 点亮 anima/h3；sd/generic 保持未归化 */
-const DIALECT_READY: Record<Target, boolean> = { anima: true, h3: true, sd: false, generic: false }
-
+/** 方言归化状态机：查注册表（anima/h3 由上方副作用 import 装配）；sd/generic 未归化 */
 export function isDialectReady(target: Target): boolean {
-  return DIALECT_READY[target] === true
+  return registryIsDialectReady(target)
 }
 
 /* ── intent 层（LLM；测试注入 seam）── */
 
 export interface AuthorDraft {
   slots?: AnimaSlots
   shots?: H3ShotsInput
 }
 
 export interface AuthorIntentRequest {
@@ -93,112 +94,70 @@ function normalizeSlots(raw: Record<string, unknown>): AnimaSlots {
     if (k === 'narrative') {
       out[k] = typeof v === 'string' ? v : (Array.isArray(v) ? (v as unknown[]).map(String).join(' ') : v == null ? '' : String(v))
     } else {
       out[k] = Array.isArray(v) ? (v as unknown[]).map((x) => String(x))
         : v == null ? [] : [String(v)]
     }
   }
   return out as AnimaSlots
 }
 
-/* ── 编排（意图 → schema → dialect → audit → render + 修正闭环）── */
+/* ── 视图层（意图 → runStage 内核 → 场景表单闸门合并 → Envelope + 修正闭环）── */
 
 const VARIANT_SET = new Set(['base', 'aesthetic', 'turbo'])
+const MAX_CORRECTIONS = 2
 
-function inferH3Stage(shots: H3ShotsInput, references: unknown[], scenarioId?: string): string {
-  if (references.length > 0) return 'ref2va'
-  if (scenarioId === 'full_reference') return 'ref2va'
-  return 't2va'
+/** draft → PipelineInput 输入段：anima {slots, variant}；h3 {shots, stage, scenarioId, formFields} */
+function normalizeDraftToInput(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): { slots?: Record<string, unknown>; variant?: string; shots?: unknown; stage?: string; scenarioId?: string; formFields?: Record<string, unknown> } {
+  if (target === 'anima') {
+    if (!draft.slots || typeof draft.slots !== 'object') throw new Error('intent 未产出 slots 结构')
+    return { slots: draft.slots as unknown as Record<string, unknown>, variant: opts.variant ?? 'base' }
+  }
+  if (!draft.shots || !Array.isArray(draft.shots.shots) || draft.shots.shots.length === 0) throw new Error('intent 未产出 shots 结构')
+  return { shots: draft.shots, stage: opts.stage || undefined, scenarioId: opts.scenarioId, formFields: opts.formFields }
 }
 
-function toRefs(raw: unknown[]): Array<{ who: string | null; image: string; width: number | null; height: number | null }> {
-  return raw.map((r) => {
-    const x = r as Record<string, unknown>
-    return {
-      who: x['who'] != null ? String(x['who']) : null,
-      image: String(x['image'] ?? ''),
-      width: typeof x['width'] === 'number' ? x['width'] : null,
-      height: typeof x['height'] === 'number' ? x['height'] : null,
-    }
-  })
+/** h3 references 计数（原 L144-146 优先级：shots.references > form_fields.references） */
+function referencesCount(draft: AuthorDraft, formFields?: Record<string, unknown>): number {
+  const refs = Array.isArray(draft.shots?.references) ? draft.shots!.references : []
+  if (refs.length > 0) return refs.length
+  const formRefs = Array.isArray(formFields?.references) ? (formFields!.references as unknown[]) : []
+  return formRefs.length
 }
 
-function runDraftStage(opts: { target: string; draft: AuthorDraft; stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
-  const target = opts.target
-  if (target === 'anima') {
-    const slots = opts.draft.slots
-    if (!slots || typeof slots !== 'object') throw new Error('intent 未产出 slots 结构')
-    const variant = opts.variant ?? 'base'
-    if (!VARIANT_SET.has(variant)) throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
-    const compiled = compileAnima(slots, { variant: variant as 'base' | 'aesthetic' | 'turbo' })
-    const gates = auditAnima(compiled.positive, compiled.negative, { variant: variant as 'base' | 'aesthetic' | 'turbo', slots })
-    return {
-      ok: gates.every((g) => g.severity !== 'critical'),
-      result: { positive: compiled.positive, negative: compiled.negative },
-      gates,
-      advisories: [],
-      targetSlotHint: 't2i.prompt',
-    }
-  }
-  const shots = opts.draft.shots
-  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) throw new Error('intent 未产出 shots 结构')
-  const refs = Array.isArray(shots.references) ? shots.references : []
-  const formRefs = Array.isArray(opts.formFields?.references) ? (opts.formFields.references as unknown[]) : []
-  const references = refs.length ? refs : formRefs
-  const stage = opts.stage ?? inferH3Stage(shots, references, opts.scenarioId)
-  const extraGates: AuditGate[] = []
-  const extraAdvisories: string[] = []
-  if (opts.scenarioId) {
-    const checked = sceneToShotsChecked(opts.scenarioId, opts.formFields ?? {})
-    const unmapped = references.length > 0
-    extraGates.push(...checked.gates.filter((g) => !(g.rule === 'references_unmapped' && unmapped)))
-    extraAdvisories.push(...checked.advisories.filter((a) => !(a === 'references_unmapped' && unmapped)))
-  }
-  const { text, textZh } = compileH3(shots, { stage })
-  const gates = [
-    ...contractGatesH3(stage, shots, references), // T13 F1
-    ...extraGates,
-    ...auditH3Full(text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, references),
-  ]
-  const budget = h3BudgetToReport(buildH3Budget(stage, text, toRefs(references)))
+/**
+ * 场景表单闸门合并（原 prompt-author L150-155 语义，视图层职责——场景表单语义不是方言本质）：
+ * sceneToShotsChecked 的 extraGates/advisories 并入 stage；references 非空时抑制 references_unmapped；
+ * 合并后 ok 按全部 gates 重算（extraGates 可能引入 critical）。
+ */
+function applyScenarioGates(stage: StageResult, opts: { scenarioId?: string; formFields?: Record<string, unknown>; refsCount: number }): StageResult {
+  if (!opts.scenarioId) return stage
+  const checked = sceneToShotsChecked(opts.scenarioId, opts.formFields ?? {})
+  const unmapped = opts.refsCount > 0
+  const extraGates = checked.gates.filter((g) => !(g.rule === 'references_unmapped' && unmapped))
+  const extraAdvisories = checked.advisories.filter((a) => !(a === 'references_unmapped' && unmapped))
+  const gates = [...stage.gates, ...extraGates]
   return {
-    ok: gates.every((g) => g.severity !== 'critical'),
-    result: { text, text_zh: textZh },
+    ...stage,
     gates,
-    advisories: extraAdvisories,
-    budget,
-    targetSlotHint: 't2v.prompt',
+    advisories: [...stage.advisories, ...extraAdvisories],
+    ok: gates.every((g) => g.severity !== 'critical'),
   }
 }
 
-export interface StageResult {
-  ok: boolean
-  result: Record<string, unknown>
-  gates: AuditGate[]
-  advisories: string[]
-  budget?: { counter: 'official-tokenizer' | 'estimate'; tokens: number; max?: number; over: boolean }
-  targetSlotHint: string
-}
-
-function renderEnvelope(stage: StageResult, trailAdvisories: string[]): string {
-  const envelope: Record<string, unknown> = {
-    ok: stage.ok,
-    result: stage.result,
-    audit: { passed: stage.ok, gates: stage.gates, ...(stage.budget ? { budget: stage.budget } : {}) },
-    advisories: [...stage.advisories, ...trailAdvisories],
-    target_slot_hint: stage.targetSlotHint,
-  }
-  return serializeReport(envelope as never)
+/** draft → runStage → applyScenarioGates（author 每轮统一入口；audit 不通过不在此处理——闭环在 execute） */
+function runDraftThroughStage(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
+  const input = normalizeDraftToInput(target, draft, opts)
+  const stageResult = runStage({ target: target as Target, ...input })
+  return applyScenarioGates(stageResult, { scenarioId: opts.scenarioId, formFields: opts.formFields, refsCount: referencesCount(draft, opts.formFields) })
 }
 
-const MAX_CORRECTIONS = 2
-
 export function registerAuthorTool(ctx: Context, config: Config) {
   return defineTool({
     name: 'prompt_author',
     description:
       '统一提示词工程主入口（全链路编排）：输入创作意图 → intent（LLM 拆结构）→ schema → dialect（compileAnima/compileH3）→ audit → Envelope + target_slot_hint；audit 未过且有 Critical 时自动修正重跑（max 2 次，仍失败置 loop_exhausted）。当前归化状态：' +
       TARGETS.map((t) => `${t}=${isDialectReady(t) ? 'ready' : 'pending'}`).join(' ') +
       '；sd/generic 报 DIALECT_NOT_AVAILABLE。',
     parameters: {
       target: { type: 'string', description: '目标方言：anima | h3 | sd | generic', default: 'anima' },
       input: { type: 'string', description: '创作意图（一句话/图描述/分镜素材）' },
@@ -223,42 +182,48 @@ export function registerAuthorTool(ctx: Context, config: Config) {
             passed: false,
             gates: [{ rule: 'dialect_not_available', target, severity: 'critical', detail: `方言 ${target} 未归化（P4 范围外），请改用 anima / h3 或 prompt_compile`, source: 'tools/prompt-author' }],
           },
           advisories: [],
         } as never)
       }
       const input = String(a.input ?? '')
       if (!input.trim()) throw new Error('input 必填')
 
       const scenarioId = String(a.scenario_id ?? '').trim() || undefined
+      const runOpts = { stage: a.stage || undefined, scenarioId, formFields: a.form_fields, variant: a.variant }
 
-      // audit_only：不调 LLM，把 input 当结构 JSON
+      // anima variant 参数校验（runStage 的 compileAnima 对未知 variant 静默回退 base——契约要求显式报错）
+      if (target === 'anima' && a.variant !== undefined && !VARIANT_SET.has(a.variant)) {
+        throw new Error(`未知 variant: ${a.variant}；可选 base|aesthetic|turbo`)
+      }
+
+      // audit_only：不调 LLM，把 input 当结构 JSON（原语义：完整编译+审计，result 照常产出——不用内核 auditOnly 标志）
       if (a.audit_only === true) {
         let draft: AuthorDraft
         try {
           const parsed = JSON.parse(input) as Record<string, unknown>
           draft = target === 'anima' ? { slots: parsed as unknown as AnimaSlots } : { shots: parsed as unknown as H3ShotsInput }
         } catch {
           throw new Error('audit_only 需要结构化 JSON 输入（anima: slots；h3: shots{...}）')
         }
-        const stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
-        return renderEnvelope(stage, [])
+        const stage = runDraftThroughStage(target, draft, runOpts)
+        return assembleEnvelope(stage, [])
       }
 
       const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
       let draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: 0 }, exec)
-      let stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
+      let stage = runDraftThroughStage(target, draft, runOpts)
       const trailAdvisories: string[] = []
       let corrections = 0
       while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
         corrections++
         const feedback = stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`).join('\n')
         draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: corrections, feedback }, exec)
-        stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
+        stage = runDraftThroughStage(target, draft, runOpts)
       }
       if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
         trailAdvisories.push('loop_exhausted:true')
       }
-      return renderEnvelope(stage, trailAdvisories)
+      return assembleEnvelope(stage, trailAdvisories)
     },
   })
-}
\ No newline at end of file
+}
diff --git a/plugins/prompt-master/src/tools/prompt-compile.ts b/plugins/prompt-master/src/tools/prompt-compile.ts
index 05eccd5..23754bf 100644
--- a/plugins/prompt-master/src/tools/prompt-compile.ts
+++ b/plugins/prompt-master/src/tools/prompt-compile.ts
@@ -1,92 +1,49 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
-import { compileH3 } from '../pe-framework/dialect/h3.js'
-import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
-import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
-import { serializeReport, buildAuditReport } from '../pe-framework/audit/report.js'
-import { sceneToShots, sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
-import type { H3ShotsInput, Reference } from '../pe-framework/schema/h3-shots.js'
-import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
-import type { AuditGate } from '../pe-framework/types.js'
+// 方言模块副作用注册（Task 6：编排走 runStage 注册表，需保证 anima/h3 已装配）
+import '../pe-framework/dialect/anima.js'
+import '../pe-framework/dialect/h3.js'
+import { runStage } from '../pe-framework/pipeline/runStage.js'
+import { assembleEnvelope } from '../pe-framework/render/envelope.js'
+import type { StageResult } from '../pe-framework/pipeline/types.js'
+import { serializeReport } from '../pe-framework/audit/report.js'
+import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
+import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 
 export interface CompileArgs {
   target?: string
   shots?: H3ShotsInput
   scenario_id?: string
   form_fields?: Record<string, unknown>
   output_lang?: string
   audit_only?: boolean
   slots?: Record<string, unknown>
   variant?: string
 }
 
-export function toReferences(raw: unknown[]): Reference[] {
-  return raw.map((r) => {
-    const x = r as Record<string, unknown>
-    return {
-      who: x['who'] != null ? String(x['who']) : null,
-      image: String(x['image'] ?? ''),
-      width: typeof x['width'] === 'number' ? x['width'] : null,
-      height: typeof x['height'] === 'number' ? x['height'] : null,
-    }
-  })
+/** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文） */
+function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean }): string {
+  const env = JSON.parse(assembleEnvelope(stage)) as Record<string, unknown>
+  if (opts?.omitResult) delete env.result
+  return serializeReport(env as never)
 }
 
-/** stage 推断（official-capabilities 路由）：有 references → ref2va；full_reference 场景 → ref2va；否则 t2va */
-export function inferH3Stage(shots: H3ShotsInput, scenarioId?: string): 't2va' | 'ref2va' {
-  if (Array.isArray(shots.references) && shots.references.length > 0) return 'ref2va'
-  if (scenarioId === 'full_reference') return 'ref2va'
-  return 't2va'
-}
+const VARIANT_SET = ['base', 'aesthetic', 'turbo']
 
-export function compileH3Envelope(
-  input: { stage: string; shots: H3ShotsInput; references?: unknown[]; auditOnly?: boolean },
-): string {
-  const { text, textZh } = compileH3(input.shots, { stage: input.stage })
-  const shotCount = input.shots.shots.length
-  const gates = [
-    ...contractGatesH3(input.stage, input.shots, input.references ?? []), // T13 F1 前置契约闸门
-    ...auditH3Full(text, { stage: input.stage, duration: input.shots.duration_seconds, shotCount }, input.references),
-  ]
-  const budget = h3BudgetToReport(buildH3Budget(input.stage, text, toReferences(input.references ?? [])))
-  const report = buildAuditReport({ gates, budget, assumptions: [], advisories: [] })
-  const envelope: Record<string, unknown> = {
-    ok: true,
-    audit: { passed: report.passed, gates: report.gates, budget: report.budget },
-    advisories: report.advisories,
-  }
-  if (!input.auditOnly) {
-    envelope.result = { text, text_zh: textZh }
-  }
-  return serializeReport(envelope as never)
-}
-
-/** anima 分支：slots → compileAnima + auditAnima → Envelope（无 budget）。variant 未知 → 参数错误（t50 Minor 处置） */
+/** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置） */
 export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean): string {
   if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
-  if (variant !== undefined && !['base', 'aesthetic', 'turbo'].includes(variant)) {
+  if (variant !== undefined && !VARIANT_SET.includes(variant)) {
     throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
   }
-  const aSlots = slots as unknown as AnimaSlots
-  const v = (variant ?? 'base') as 'base' | 'aesthetic' | 'turbo'
-  const compiled = compileAnima(aSlots, { variant: v })
-  const gates = auditAnima(compiled.positive, compiled.negative, { variant: v, slots: aSlots })
-  const report = buildAuditReport({ gates, assumptions: [], advisories: [] })
-  const envelope: Record<string, unknown> = {
-    ok: true,
-    audit: { passed: report.passed, gates: report.gates },
-    advisories: report.advisories,
-  }
-  if (!auditOnly) {
-    envelope.result = { positive: compiled.positive, negative: compiled.negative }
-  }
-  return serializeReport(envelope as never)
+  const stage = runStage({ target: 'anima', slots, variant, auditOnly: auditOnly === true })
+  return stageToEnvelope(stage, { omitResult: auditOnly === true })
 }
 
 export function registerCompileTool() {
   return defineTool({
     name: 'prompt_compile',
     description:
       '确定性编译+审计：target=h3（场景/shots → official dialect 文本+审计）或 target=anima（slots → positive/negative+审计；无 budget）。h3 budget counter=estimate（T12 前）。',
     parameters: {
       target: { type: 'string', default: 'h3', description: '目标方言：h3 / anima' },
       slots: { type: 'object', description: 'anima 槽位 brief（AnimaSlots 形状）', default: {}, additionalProperties: true },
@@ -111,37 +68,40 @@ export function registerCompileTool() {
         return compileAnimaEnvelope(a.slots, a.variant, a.audit_only === true)
       }
       if (target !== 'h3') {
         throw new Error(`DIALECT_NOT_AVAILABLE: ${target} 方言未归化（本期支持 h3 / anima）`)
       }
       if (a.slots || a.variant) {
         throw new Error('参数错误：slots/variant 属于 anima 分支，h3 请使用 scenario_id/form_fields 或 shots')
       }
       let shots: H3ShotsInput | null = null
       let scenarioId: string | undefined
-      const extraGates: AuditGate[] = []
+      const extraGates: StageResult['gates'] = []
       const extraAdvisories: string[] = []
       if (a.scenario_id) {
         scenarioId = String(a.scenario_id).trim()
         // T13 F2：references 映射 + ref2va 形态缺引用 advisory/critical
         const checked = sceneToShotsChecked(scenarioId, a.form_fields ?? {}, { lang: a.output_lang })
         shots = checked.shots
         if (!shots) throw new Error(`场景映射不可用: ${scenarioId}`)
         extraGates.push(...checked.gates)
         extraAdvisories.push(...checked.advisories)
       } else if (a.shots && Array.isArray(a.shots.shots) && (a.shots.shots as unknown[]).length > 0) {
         shots = a.shots as unknown as H3ShotsInput
       }
       if (!shots) throw new Error('需要 scenario_id 或 shots 输入')
-      const stage = inferH3Stage(shots, scenarioId)
-      const references = Array.isArray(a.form_fields?.references) ? (a.form_fields.references as unknown[]) : []
-      const envelope = JSON.parse(compileH3Envelope({ stage, shots, references, auditOnly: a.audit_only === true })) as Record<string, unknown>
+      // stage 推断在 runStage normalize 单点（references > full_reference 场景 > t2va）；references 走 formFields
+      let stage = runStage({
+        target: 'h3',
+        shots,
+        scenarioId,
+        formFields: a.form_fields,
+        auditOnly: a.audit_only === true,
+      })
       if (extraGates.length || extraAdvisories.length) {
-        const audit = envelope.audit as { passed: boolean; gates: AuditGate[] }
-        const mergedGates = [...extraGates, ...(audit.gates ?? [])]
-        envelope.audit = { passed: !mergedGates.some((g) => g.severity === 'critical'), gates: mergedGates }
-        envelope.advisories = [...(extraAdvisories), ...((envelope.advisories as string[]) ?? [])]
+        const gates = [...extraGates, ...stage.gates]
+        stage = { ...stage, gates, advisories: [...extraAdvisories, ...stage.advisories], ok: !gates.some((g) => g.severity === 'critical') }
       }
-      return serializeReport(envelope as never)
+      return stageToEnvelope(stage, { omitResult: a.audit_only === true })
     },
   })
-}
\ No newline at end of file
+}
diff --git a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
index e056d70..c2fd10d 100644
--- a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
@@ -57,20 +57,22 @@ describe('runStage', () => {
 
 describe('assembleEnvelope', () => {
   it('emits P1 envelope with ok/result/audit/advisories/target_slot_hint', () => {
     const s = JSON.parse(assembleEnvelope(
       { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
       ['trail'],
     ))
     expect(s.ok).toBe(true)
     expect(s.result).toEqual({ x: 1 })
     expect(s.audit.passed).toBe(true)
+    // Task 4 定案：audit 收敛为 {passed, gates, budget?}——assumptions/advisories 不再入 audit 对象
+    expect(Object.keys(s.audit).sort()).toEqual(['gates', 'passed'])
     expect(s.target_slot_hint).toBe('t2i.prompt')
     expect(s.advisories).toEqual(['a', 'trail'])
   })
 
   it('omits result when ok=false (audit_only semantics)', () => {
     const s = JSON.parse(assembleEnvelope(
       { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
     ))
     expect(s.ok).toBe(false)
     expect(s.result).toBeUndefined()
diff --git a/plugins/prompt-master/tests/plugin/compile-h3.test.ts b/plugins/prompt-master/tests/plugin/compile-h3.test.ts
index 86281c2..516b70e 100644
--- a/plugins/prompt-master/tests/plugin/compile-h3.test.ts
+++ b/plugins/prompt-master/tests/plugin/compile-h3.test.ts
@@ -1,61 +1,76 @@
 import { describe, expect, it } from 'vitest'
-import { registerCompileTool, compileH3Envelope, inferH3Stage } from '../../src/tools/prompt-compile.js'
+import { registerCompileTool } from '../../src/tools/prompt-compile.js'
 import { stubCtx, runTool } from './helpers.js'
 
 const def = () => registerCompileTool()
+const run = async (args: Record<string, unknown>) => JSON.parse(String(await runTool(stubCtx(), def(), args)))
 
 describe('prompt_compile (target=h3)', () => {
   it('scenario_id=full_reference maps to shots (with references) and compiles six-section text', async () => {
-    const ctx = stubCtx()
-    const raw = JSON.parse(String(await runTool(ctx, def(), {
+    const raw = await run({
       target: 'h3',
       scenario_id: 'full_reference',
       form_fields: {
         subject: 'bai fa jian ke', scene: 'xue shan', duration_seconds: '10', ambient: 'feng xue', music: 'gu zheng',
         references: [{ kind: 'picture', who: 'Sword', image: 'snow.png', width: 1024, height: 1024 }], // T13 F2 refs mapping
       },
-    })))
+    })
     expect(raw.ok).toBe(true) // refs mapped → no references_unmapped critical
     const text: string = raw.result.text
     expect(text.length).toBeGreaterThan(0)
   })
 
   it('direct shots input compiles deterministically', async () => {
-    const raw = JSON.parse(compileH3Envelope({ stage: 't2va', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } }))
+    const raw = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
     expect(raw.ok).toBe(true)
     expect(raw.result.text).toContain('integrated_multimodal_description: [Shot 1]')
   })
 
   it('ref2va → auditH3Full label gates run with references (F2)', async () => {
-    const raw = JSON.parse(compileH3Envelope({
+    const raw = await run({
+      target: 'h3',
       stage: 'ref2va',
       shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }], references: [{ kind: 'picture', who: 'A', image: 'a.png' }] as never },
-    }))
+    })
     expect(raw.result.text).toContain('subject_definitions:')
   })
 
   it('F1 contract gate: ref2va with 2 references rejected as critical ref_count', async () => {
-    const raw = JSON.parse(compileH3Envelope({
+    const raw = await run({
+      target: 'h3',
       stage: 'ref2va',
       shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }] },
-      references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }],
-    }))
-    expect(raw.audit.passed).toBe(false) // ok=编译成功；审计闸门经 audit.passed 表达
+      form_fields: { references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }] },
+    })
+    expect(raw.audit.passed).toBe(false) // 审计闸门经 audit.passed 表达
     expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count' && g.severity === 'critical')).toBe(true)
   })
 
   it('budget counter is official-tokenizer (T12 switch)', async () => {
-    const v = compileH3Envelope({ stage: 't2va', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
-    expect(JSON.parse(v).audit.budget.counter).toBe('official-tokenizer')
+    const raw = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
+    expect(raw.audit.budget.counter).toBe('official-tokenizer')
   })
 
   it('unknown target errors with DIALECT_NOT_AVAILABLE', async () => {
     await expect(runTool(stubCtx(), def(), { target: 'sd', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } } as any)).rejects.toThrow(/DIALECT_NOT_AVAILABLE/)
   })
 
-  it('stage inference: references → ref2va, else t2va, full_reference → ref2va', () => {
-    expect(inferH3Stage({ duration_seconds: 8, shots: [{ what: 'x' }], references: [{ who: 'A', image: 'a.png' }] as never })).toBe('ref2va')
-    expect(inferH3Stage({ duration_seconds: 6, shots: [{ what: 'x' }] })).toBe('t2va')
-    expect(inferH3Stage({ duration_seconds: 8, shots: [{ what: 'x' }] }, 'full_reference')).toBe('ref2va')
+  it('stage inference via tool: references → ref2va, else t2va, full_reference scenario → ref2va', async () => {
+    // stage 推断收敛进 runStage normalize 单点（Task 6）；此处经工具入口做行为等价断言
+    const withRefs = await run({
+      target: 'h3',
+      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }], references: [{ kind: 'picture', who: 'A', image: 'a.png' }] as never },
+    })
+    expect(withRefs.result.text).toContain('subject_definitions:') // ref2va
+    const noRefs = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
+    expect(noRefs.result.text).toContain('integrated_multimodal_description:') // t2va
+    const fullRef = await run({
+      target: 'h3', scenario_id: 'full_reference',
+      form_fields: {
+        subject: 'bai fa jian ke', scene: 'xue shan', duration_seconds: '10', ambient: 'feng xue', music: 'gu zheng',
+        references: [{ kind: 'picture', who: 'Sword', image: 'snow.png', width: 1024, height: 1024 }],
+      },
+    })
+    expect(fullRef.result.text).toContain('subject_definitions:') // ref2va
   })
-})
\ No newline at end of file
+})
diff --git a/plugins/prompt-master/tests/plugin/h3-dialect.test.ts b/plugins/prompt-master/tests/plugin/h3-dialect.test.ts
index 038af5d..e816c51 100644
--- a/plugins/prompt-master/tests/plugin/h3-dialect.test.ts
+++ b/plugins/prompt-master/tests/plugin/h3-dialect.test.ts
@@ -80,21 +80,21 @@ describe('h3 dialect golden double-run (dialect.py port)', () => {
     { name: 'ref2va-neko', stage: 'ref2va' },
     { name: 'ref2va-mei-three-refs', stage: 'ref2va' },
   ]
 
   for (const { name, stage } of CASES) {
     it(`${name}: compileH3 text/text_zh byte-exact against golden`, () => {
       const golden = readGolden(name) as any
       const input = golden.input
       const compiled = compileH3(input, { stage })
       assertGolden(
-        { result: { text: compiled.text, text_zh: compiled.textZh } },
+        { result: { text: compiled.text, text_zh: compiled.text_zh } },
         name,
         ['result.text', 'result.text_zh'],
       )
     })
   }
 
   it('fl2va-multishot: official validation failure reproduced (no refs under fl2va)', () => {
     const golden = readGolden('fl2va-multishot') as any
     const input = golden.input
     let threw: Error | undefined
```
