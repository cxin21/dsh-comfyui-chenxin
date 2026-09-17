# Review package — Task 5 (base c9f095d..84ea750)

## Commits
```84ea750 feat(prompt-master): register anima/h3 dialects (normalize converges stage/references)
```n
## Stat
``` .../src/pe-framework/dialect/anima.ts              | 50 +++++++++++++++-
 .../prompt-master/src/pe-framework/dialect/h3.ts   | 68 +++++++++++++++++++++-
 .../src/pe-framework/intent/subagent-provider.ts   | 61 +++++++++++++++++++
 .../src/pe-framework/pipeline/runStage.ts          |  2 +-
 plugins/prompt-master/src/plugin/index.ts          |  2 +
 .../pe-framework/dialect/anima-register.test.ts    | 23 ++++++++
 .../tests/pe-framework/dialect/h3-register.test.ts | 27 +++++++++
 7 files changed, 229 insertions(+), 4 deletions(-)
```n
## Full diff (-U10, src+tests)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima.ts b/plugins/prompt-master/src/pe-framework/dialect/anima.ts
index 83573e7..1d857a4 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima.ts
@@ -1,17 +1,20 @@
 /**
  * Anima 编译/审计/关系覆盖 TS 归化（P2 核心）。
  * 逐函数对照：composition.py / grounding.py / output.py / inspection.py / types.py（facets.normalize 经 anima-catalog）。
  * A14 修正：canonical/alias → 直用 catalog.prompt_form；fuzzy/miss → 保留原文 + catalog_miss advisory/assumption（不自动替换）。
  */
 import { SLOT_ORDER } from '../anima.js'
 import { normalizeTag, searchCatalog, overlayStatus, type CatalogHit } from './anima-catalog.js'
+import { registerDialect } from './registry.js'
+import type { DialectContract } from './contract.js'
+import { ANIMA_PERSONA, ANIMA_SCHEMA } from '../intent/subagent-provider.js'
 import type { AuditGate } from '../types.js'
 
 export interface AnimaSlots {
   count_gender?: string[]
   character?: string[]
   appearance?: string[]
   clothing?: string[]
   pose_action?: string[]
   expression?: string[]
   camera?: string[]
@@ -339,11 +342,56 @@ export function overlayAdvisory(): string[] {
 
 export function applyRelationOverlay(catalog: { overlayStatus(): string }): void {
   if (catalog.overlayStatus() !== 'available') {
     _overlayAdvisories = ['overlay_unavailable']
   }
 }
 
 /** 便捷导出：variant 策略表供报告/测试 */
 export function variantPolicy(variant: string): Policy {
   return POLICIES[variant] ?? POLICIES.base
-}
\ No newline at end of file
+}
+
+/* ── Task 5：方言注册（validateAnimaSlots 收敛 _coerce_brief 校验）── */
+
+const ANIMA_SLOT_KEYS = new Set(['count_gender', 'character', 'appearance', 'clothing', 'pose_action', 'expression', 'camera', 'scene', 'detail_mood'])
+
+/** composition.py _coerce_brief 移植：槽位键白名单 + 类型校验（narrative string、其余 string[]） */
+export function validateAnimaSlots(slots: unknown): string | undefined {
+  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'anima 需要 slots 对象'
+  const s = slots as Record<string, unknown>
+  for (const k of Object.keys(s)) {
+    if (k === 'narrative') { if (typeof s[k] !== 'string') return 'narrative 需为 string'; continue }
+    if (!ANIMA_SLOT_KEYS.has(k)) return `未知槽位: ${k}`
+    if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== 'string')) return `槽位 ${k} 需为 string[]`
+  }
+  return undefined
+}
+
+export function registerAnimaDialect(): void {
+  const contract: DialectContract<Record<string, unknown>, { positive: string; negative: string }> = {
+    id: 'anima',
+    label: 'Anima',
+    auditOnlyOk: true,
+    normalize: (input) => {
+      const slots = (input as { slots?: Record<string, unknown> } | undefined)?.slots
+      const err = validateAnimaSlots(slots)
+      if (err) return { error: err }
+      return { value: slots as Record<string, unknown> }
+    },
+    compile: (slots, opts) => {
+      const variant = (opts.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
+      return compileAnima(slots as AnimaSlots, { variant })
+    },
+    audit: (compiled, ctx) => {
+      const variant = (ctx.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
+      const slots = ctx.shots as unknown as AnimaSlots // runStage audit ctx.shots = 归一化 value（slots）
+      return { gates: auditAnima(compiled.positive, compiled.negative, { variant, slots }) }
+    },
+    targetSlotHint: 't2i.prompt',
+    intent: { persona: ANIMA_PERSONA, schema: ANIMA_SCHEMA },
+  }
+  registerDialect(contract)
+}
+
+// 模块级副作用注册：plugin/index.ts import 本模块即完成装配
+registerAnimaDialect()
\ No newline at end of file
diff --git a/plugins/prompt-master/src/pe-framework/dialect/h3.ts b/plugins/prompt-master/src/pe-framework/dialect/h3.ts
index baf89ee..7989835 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/h3.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/h3.ts
@@ -1,14 +1,19 @@
 /**
  * H3 authoring dialect（TS 移植，逐字符对照 h3_prompt/dialect.py）。
  */
-import { KEYFRAME_STAGES, type Reference, type H3Shot, type StoryRequest } from '../schema/h3-shots.js'
+import { KEYFRAME_STAGES, type Reference, type H3Shot, type StoryRequest, type H3ShotsInput } from '../schema/h3-shots.js'
+import { registerDialect } from './registry.js'
+import type { DialectContract } from './contract.js'
+import { contractGatesH3, auditH3Full } from '../audit/rules-h3.js'
+import { buildH3Budget } from '../audit/budget.js'
+import { H3_PERSONA, H3_SCHEMA } from '../intent/subagent-provider.js'
 
 const CJK = /[\u4e00-\u9fff]/
 const KANA = /[\u3040-\u30ff]/
 const END_PUNCT = '.!?…'
 
 export function formatTimestamp(seconds: number): string {
   const totalMs = Math.round(seconds * 1000)
   const minutes = Math.floor(totalMs / 60_000)
   const rem = totalMs % 60_000
   const secs = Math.floor(rem / 1000)
@@ -257,11 +262,70 @@ export function compileH3(
     : []
   const request: StoryRequest = {
     stage,
     duration_seconds: input.duration_seconds,
     shots: input.shots,
     references: refs,
     videos: [],
     audios: [],
   }
   return buildTextPair(stage, request)
-}
\ No newline at end of file
+}
+
+/* ── Task 5：方言注册（normalize 收敛 inferH3Stage/toRefs；工具侧副本 Task 6 删）── */
+
+/** toRefs 移植（prompt-author.ts 收敛单点）：who/image 字符串化 + width/height 仅接受 number（否则 null） */
+function toRefsNormalized(raw: unknown[]): Reference[] {
+  return raw.map((r) => {
+    const x = r as Record<string, unknown>
+    return {
+      who: x['who'] != null ? String(x['who']) : null,
+      image: String(x['image'] ?? ''),
+      width: typeof x['width'] === 'number' ? x['width'] : null,
+      height: typeof x['height'] === 'number' ? x['height'] : null,
+    }
+  })
+}
+
+/** stage 推断 + references 规范化（从 prompt-author.ts inferH3Stage/toRefs 收敛；Task 6 删除工具侧副本） */
+export function normalizeH3Input(
+  input: unknown,
+  opts: { stage?: string; scenarioId?: string; formFields?: unknown },
+): { error?: string; value?: H3ShotsInput; stage?: string; references?: Reference[] } {
+  const shots = (input as { shots?: H3ShotsInput } | undefined)?.shots
+  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) {
+    return { error: 'intent 未产出 shots 结构' }
+  }
+  const formRefs = Array.isArray((opts.formFields as Record<string, unknown> | undefined)?.references)
+    ? ((opts.formFields as Record<string, unknown>).references as unknown[]) : []
+  const refs = Array.isArray(shots.references) ? shots.references : []
+  const references = toRefsNormalized(refs.length > 0 ? refs : formRefs)
+  // 优先级与现 prompt-author.ts inferH3Stage 一致：显式 stage > references 存在 > scenarioId==='full_reference' > t2va
+  const stage = opts.stage || (references.length > 0 ? 'ref2va' : opts.scenarioId === 'full_reference' ? 'ref2va' : 't2va')
+  return { value: shots, stage, references }
+}
+
+export function registerH3Dialect(): void {
+  const contract: DialectContract<H3ShotsInput, { text: string; textZh: string }> = {
+    id: 'h3',
+    label: 'MiniMax-H3',
+    auditOnlyOk: true,
+    normalize: (input, opts) => normalizeH3Input(input, opts),
+    compile: (shots, opts) => compileH3(shots, { stage: opts.stage ?? 't2va' }),
+    audit: (compiled, ctx) => {
+      const stage = ctx.stage ?? 't2va'
+      const shots = ctx.shots as H3ShotsInput
+      const gates = [
+        ...contractGatesH3(stage, shots, ctx.references ?? []),
+        ...auditH3Full(compiled.text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, ctx.references),
+      ]
+      return { gates, assumptions: [] }
+    },
+    budget: (compiled, ctx) => buildH3Budget(ctx.stage ?? 't2va', compiled.text, ctx.references ?? []),
+    targetSlotHint: 't2v.prompt',
+    intent: { persona: H3_PERSONA, schema: H3_SCHEMA },
+  }
+  registerDialect(contract)
+}
+
+// 模块级副作用注册：plugin/index.ts import 本模块即完成装配
+registerH3Dialect()
\ No newline at end of file
diff --git a/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts b/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
index c97a3a6..ea96b5c 100644
--- a/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
+++ b/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
@@ -164,20 +164,81 @@ function normalizeSlots(raw: unknown): AnimaSlots {
     if (k === 'narrative') {
       out[k] = typeof v === 'string' ? v : (Array.isArray(v) ? (v as unknown[]).map(String).join(' ') : v == null ? '' : String(v))
     } else {
       out[k] = Array.isArray(v) ? (v as unknown[]).map((x) => String(x))
         : v == null ? [] : [String(v)]
     }
   }
   return out as AnimaSlots
 }
 
+/* ── per-target persona/schema 拆分（Task 5）：语义等价拆出，DEFAULT_* 保留原值作兜底 ── */
+
+export const ANIMA_PERSONA = `你是一位资深的 Anima 提示词工程创作者。
+你的任务：根据用户的创作意图，产出与 Anima 方言严格对齐的结构化输入内容。
+
+规则：
+1. 产出 Anima slots（count_gender / character / appearance / clothing / pose_action / expression / camera / scene / detail_mood 等）与 narrative；不输出方言编译结果
+2. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
+3. **尊重用户原始意图**：用户给的描述字符串（narrative 等）保持原文字面，不要为了更"通顺"而重写或编造
+4. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）
+
+输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
+`
+
+export const H3_PERSONA = `你是一位资深的 MiniMax-H3 视频提示词工程创作者。
+你的任务：根据用户的创作意图，产出与 H3 方言严格对齐的结构化输入内容。
+
+规则：
+1. 产出 H3 shots（duration_seconds + 每 shot 的 what/ambient/music/dialogue/who）
+2. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
+3. **尊重用户原始意图**：用户给的描述字符串（what/ambient 等）保持原文字面，不要为了更"通顺"而重写或编造
+4. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）
+
+输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
+`
+
+export const ANIMA_SCHEMA = `{
+  "slots": {
+    "count_gender": ["1girl"],
+    "character": ["Subject 1 from <Picture 1>"],
+    "appearance": ["long hair", "blue eyes"],
+    "clothing": ["red dress"],
+    "pose_action": ["standing"],
+    "expression": ["smile"],
+    "camera": ["close-up"],
+    "scene": ["sunset rooftop"],
+    "detail_mood": ["cinematic"],
+    "narrative": "自由文本，可空"
+  }
+}
+
+输出规则：
+- 只能输出一个 JSON 对象，不要任何前缀后缀文字
+- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
+- 用户提供 references 时保持 ref 标签稳定
+`
+
+export const H3_SCHEMA = `{
+  "duration_seconds": 10,
+  "references": [],
+  "shots": [
+    { "what": "镜头内容", "who": "<Subject 1>", "ambient": "环境声", "music": "BGM", "dialogue": "对白或省略" }
+  ]
+}
+
+输出规则：
+- 只能输出一个 JSON 对象，不要任何前缀后缀文字
+- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
+- 用户提供 references 时保持 ref 标签稳定
+`
+
 const DEFAULT_PERSONA = `你是一位资深的提示词工程创作者（Anima / MiniMax-H3 方言）。
 你的任务：根据用户的创作意图与目标方言，产出与目标方言严格对齐的结构化输入内容。
 
 规则：
 1. 若 target=anima：产出 Anima slots（count_gender / character / appearance / clothing / pose_action / expression / camera / scene / detail_mood 等）与 narrative；不输出方言编译结果
 2. 若 target=h3：产出 H3 shots（duration_seconds + 每 shot 的 what/ambient/music/dialogue/who）
 3. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
 4. **尊重用户原始意图**：用户给的描述字符串（narrative/what/ambient 等）保持原文字面，不要为了更"通顺"而重写或编造
 5. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）
 
diff --git a/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
index 1d2a29f..15cc384 100644
--- a/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
+++ b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
@@ -37,21 +37,21 @@ export function runStage(input: PipelineInput): StageResult {
     { target: input.target, slots: input.slots, variant: input.variant, shots: input.shots, stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields, auditOnly },
     { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields },
   )
   const tSchema = performance.now()
   if (normalized.error !== undefined) throw new Error(normalized.error)
   const slots = normalized.value
 
   const compiled = d.compile(slots as never, { variant: input.variant, stage: input.stage })
   const tDialect = performance.now()
 
-  const audit = d.audit(compiled as never, { stage: input.stage, references: normalized.references, shots: input.shots, variant: input.variant })
+  const audit = d.audit(compiled as never, { stage: input.stage, references: normalized.references, shots: normalized.value ?? input.shots, variant: input.variant })
   const tAudit = performance.now()
 
   const budgetRaw = d.budget?.(compiled as never, { stage: input.stage, references: normalized.references })
   const tBudget = performance.now()
 
   const ok = audit.gates.every((g) => g.severity !== 'critical')
   const result: Record<string, unknown> = auditOnly ? {} : (compiled as Record<string, unknown>)
 
   const renderMs = 0
   const stages: PipelineTrace['stages'] = [
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
index 778acf5..26fb0c6 100644
--- a/plugins/prompt-master/src/plugin/index.ts
+++ b/plugins/prompt-master/src/plugin/index.ts
@@ -3,20 +3,22 @@ import type { Context } from '@deepseek-ai/cordis'
 import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
 import { registerExpandTool } from '../tools/prompt-expand.js'
 import { registerReverseTool } from '../tools/prompt-reverse.js'
 import { registerMinimaxTool } from '../tools/minimax-scenario.js'
 import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
 import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
 import { registerCompileTool } from '../tools/prompt-compile.js'
 import { registerCatalogSearchTool } from '../tools/catalog-search.js'
 import { registerAuditTool } from '../tools/prompt-audit.js'
 import { setCustomProfileSource } from '../resolver/profiles/source.js'
+import '../pe-framework/dialect/anima.js'
+import '../pe-framework/dialect/h3.js'
 import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
 import { setPresetRoot } from '../pe-framework/resources/resolve.js'
 import { Config, type Config as ConfigShape } from './config.js'
 
 export const name = 'prompt-master'
 export const inject = ['tools', 'llm', 'settings', 'subagents']
 export { Config }
 
 export function apply(ctx: Context, config: ConfigShape) {
   // 资源路径解析：显式 presetRoot 优先（其后 env / preset 布局 fallback 在 resolve 内部处理）
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-register.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-register.test.ts
new file mode 100644
index 0000000..32f927e
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-register.test.ts
@@ -0,0 +1,23 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
+import { registerAnimaDialect, validateAnimaSlots } from '../../../src/pe-framework/dialect/anima.js'
+
+describe('Anima dialect registration', () => {
+  beforeEach(() => { __resetDialectsForTests(); registerAnimaDialect() })
+
+  it('registers anima with targetSlotHint t2i.prompt', () => {
+    expect(getDialect('anima')?.targetSlotHint).toBe('t2i.prompt')
+  })
+
+  it('validateAnimaSlots rejects unknown key', () => {
+    expect(validateAnimaSlots({ bogus_key: ['x'] })).toContain('bogus_key')
+  })
+
+  it('validateAnimaSlots rejects non-string-array slot', () => {
+    expect(validateAnimaSlots({ appearance: 'long hair' })).toContain('string[]')
+  })
+
+  it('validateAnimaSlots accepts valid slots', () => {
+    expect(validateAnimaSlots({ count_gender: ['1girl'], narrative: '描述' })).toBeUndefined()
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/h3-register.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/h3-register.test.ts
new file mode 100644
index 0000000..5719994
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/h3-register.test.ts
@@ -0,0 +1,27 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
+import { normalizeH3Input, registerH3Dialect } from '../../../src/pe-framework/dialect/h3.js'
+
+describe('H3 dialect registration', () => {
+  beforeEach(() => { __resetDialectsForTests(); registerH3Dialect() })
+
+  it('registers h3 with targetSlotHint t2v.prompt and auditOnlyOk', () => {
+    const d = getDialect('h3')
+    expect(d?.targetSlotHint).toBe('t2v.prompt')
+    expect(d?.auditOnlyOk).toBe(true)
+  })
+
+  it('normalizeH3Input infers ref2va when references present', () => {
+    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }], references: [{ who: 'x', image: 'p' }] } }, {})
+    expect(r.stage).toBe('ref2va')
+  })
+
+  it('normalizeH3Input infers t2va when no references', () => {
+    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }] } }, {})
+    expect(r.stage).toBe('t2va')
+  })
+
+  it('normalizeH3Input error on missing shots', () => {
+    expect(normalizeH3Input({}, {})?.error).toBeTruthy()
+  })
+})
```
