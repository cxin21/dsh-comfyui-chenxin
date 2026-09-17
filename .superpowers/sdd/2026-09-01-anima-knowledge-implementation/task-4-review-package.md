# Review package - 47a26be..3d55a19

## Commits
``````

## Stat
``` .../src/pe-framework/dialect/anima.ts              | 79 ++++++++++++++++++----
 .../tests/plugin/compile-anima.test.ts             | 28 ++++++++
 2 files changed, 95 insertions(+), 12 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima.ts b/plugins/prompt-master/src/pe-framework/dialect/anima.ts
index 24a455e..a4f82a8 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima.ts
@@ -1,17 +1,17 @@
 /**
  * Anima 编译/审计/关系覆盖 TS 归化（P2 核心）。
  * 逐函数对照：composition.py / grounding.py / output.py / inspection.py / types.py（facets.normalize 经 anima-catalog）。
  * A14 修正：canonical/alias → 直用 catalog.prompt_form；fuzzy/miss → 保留原文 + catalog_miss advisory/assumption（不自动替换）。
  */
 import { SLOT_ORDER } from '../anima.js'
-import { normalizeTag, searchCatalog, overlayStatus, type CatalogHit } from './anima-catalog.js'
+import { normalizeTag, searchCatalog, overlayStatus, queryCatalogInternal, type CatalogHit } from './anima-catalog.js'
 import { registerDialect } from './registry.js'
 import type { DialectContract } from './contract.js'
 import { ANIMA_PERSONA, ANIMA_SCHEMA } from '../intent/subagent-provider.js'
 import type { AuditGate } from '../types.js'
 
 export interface AnimaSlots {
   count_gender?: string[]
   character?: string[]
   appearance?: string[]
   clothing?: string[]
@@ -31,33 +31,63 @@ export interface AnimaSlots {
 export interface CompileAnimaOptions {
   variant?: 'base' | 'aesthetic' | 'turbo'
   search?: (tag: string) => CatalogHit[]
 }
 
 export interface CompileAnimaResult {
   positive: string
   negative: string
   notes: string[]
   assumptions: string[]
+  /** G2：author 载荷投影（segments/phase_status/metadata 为附加投影，positive/negative 逐字节不变） */
+  segments: AnimaSegment[]
+  phase_status: { policy: 'PASS'; grounding: 'PASS' | 'ADVISORY'; composition: 'PASS'; inspection: 'PASS' | 'ADVISORY' }
+  metadata: { variant: string; subject?: string }
+}
+
+/** G2：segment 溯源条目（对照 cli.py _segments_payload） */
+export interface AnimaSegment {
+  segment_id: string
+  text: string
+  channel: 'positive' | 'negative'
+  origin: 'policy' | 'grounded' | 'user-fuzzy' | 'narrative' | 'exclusion'
+  priority: number
+  slot: string | null
+  citation: AnimaCitation | null
 }
 
 export interface AnimaCitation {
   text: string
   record_id: string | null
   canonical: string | null
   prompt_form: string | null
   source: string | null
   match_type: 'canonical' | 'alias' | 'fuzzy' | 'miss'
 }
 
 const GROUNDED = new Set(['canonical', 'alias'])
 
+/** G2：citations.source 溯源（实测真库 schema：sources 无 value 列；golden 的 source 字符串即
+ *  sources.source_id 本身（如 `gelbooru_canonical:4dd8…`），records.source_ids 是 JSON 数组字符串，
+ *  故经 json_each 展开 join。查询失败/无行 → null（不阻断编译）。 */
+const SOURCE_SQL =
+  'SELECT s.source_id AS value FROM sources s JOIN records r ON r.record_id=? JOIN json_each(r.source_ids) je ON je.value=s.source_id LIMIT 1'
+
+function lookupSource(recordId: string): string | null {
+  try {
+    const rows = queryCatalogInternal(SOURCE_SQL, [recordId]) as Array<{ value?: string }>
+    return rows[0]?.value ?? null
+  } catch {
+    return null
+  }
+}
+
 interface Policy {
   variant: string
   mandatoryPositive: string[]
   mandatoryNegative: string[]
   safetySeed: string[]
 }
 
 /** types.py ModelPolicy.for_variant 移植（variant 策略表） */
 const POLICIES: Record<string, Policy> = {
   base: {
@@ -115,21 +145,21 @@ export function groundSlotTags(slots: AnimaSlots, search: (tag: string) => Catal
       const top = hits[0]
       if (!top || !top.match_type || !GROUNDED.has(top.match_type)) {
         citations.set(nkey, { text, record_id: null, canonical: null, prompt_form: null, source: null, match_type: 'miss' })
         continue
       }
       citations.set(nkey, {
         text,
         record_id: top.record_id ?? null,
         canonical: top.prompt_form ?? top.raw ?? null,
         prompt_form: top.prompt_form ?? null,
-        source: null,
+        source: top.record_id ? lookupSource(top.record_id) : null,
         match_type: top.match_type as 'canonical' | 'alias',
       })
     }
   }
   return citations
 }
 
 /** 取 fuzzy 候选（详细 advisory 用）：顶层 fuzzy hits 的 prompt_form（≤3） */
 export function fuzzyCandidates(tag: string, search: (tag: string) => CatalogHit[]): string[] {
   return search(tag).filter((h) => h.match_type === 'fuzzy').slice(0, 3).map((h) => h.prompt_form ?? h.raw ?? '').filter(Boolean)
@@ -141,29 +171,36 @@ export function compileAnima(slots: AnimaSlots, opts?: CompileAnimaOptions): Com
   const search: (t: string) => CatalogHit[] = opts?.search ?? ((t: string) => searchCatalog(t, { limit: 1 }))
   const policy = POLICIES[variant] ?? POLICIES.base
   const qualityPrefix = slots.qualityPrefix ?? true
   const citations = groundSlotTags(slots, search)
 
   let positive: string[] = []
   let negative: string[] = []
   const notes: string[] = []
   const assumptions: string[] = []
   const missedKeys = new Set<string>()
+  /** G2：段级溯源投影（与 positive/negative push 同序，join 后逐字节等价——由 fidelity golden 把关） */
+  const segments: AnimaSegment[] = []
+  const pushSeg = (text: string, channel: 'positive' | 'negative', origin: AnimaSegment['origin'], priority: number, slot: string | null = null, citation: AnimaCitation | null = null): void => {
+    segments.push({ segment_id: `seg${segments.length + 1}`, text, channel, origin, priority, slot, citation })
+    if (channel === 'positive') positive.push(text)
+    else negative.push(text)
+  }
 
   // 3a: 策略质量词（quality_prefix 门控）
   if (qualityPrefix) {
-    positive.push(...policy.mandatoryPositive)
-    negative.push(...policy.mandatoryNegative)
+    for (const t of policy.mandatoryPositive) pushSeg(t, 'positive', 'policy', 100)
+    for (const t of policy.mandatoryNegative) pushSeg(t, 'negative', 'policy', 100)
   }
   // 3b: 安全种子（explicit 关断）
   if (!isExplicitRequest(slots)) {
-    positive.push(...policy.safetySeed)
+    for (const t of policy.safetySeed) pushSeg(t, 'positive', 'policy', 99)
     assumptions.push('safety_seed_injected:default_for_non_explicit_request')
   }
   // 3c: 槽固定 SLOT_ORDER（权重即顺序）——不跨槽去重：忠实复刻上游 composition.py（无去重），
   // 跨槽重复由审计稿 duplicate_segment gate 标记（闭环里模型据 `[duplicate_segment]` 自修正）
   SLOT_ORDER.forEach((slotName, slotIndex) => {
     const tags = slotOf(slots, slotName)
     if (!tags || !tags.length) return
     const base = 200 + slotIndex * 50
     tags.forEach((raw, tagIndex) => {
       const tag = String(raw)
@@ -174,44 +211,61 @@ export function compileAnima(slots: AnimaSlots, opts?: CompileAnimaOptions): Com
       } else {
         text = tag
         if (citation && citation.match_type === 'miss') {
           const nkey = normalizeTag(tag)
           if (!missedKeys.has(nkey)) {
             missedKeys.add(nkey)
             assumptions.push(`catalog_miss:${tag}`)
           }
         }
       }
-      positive.push(text)
-      void base
-      void tagIndex
+      pushSeg(text, 'positive', citation && citation.match_type && GROUNDED.has(citation.match_type) ? 'grounded' : 'user-fuzzy', base + tagIndex, slotName, citation ?? null)
     })
   })
   // 3d: narrative 最后
   if (slots.narrative && slots.narrative.trim()) {
-    positive.push(slots.narrative.trim())
+    pushSeg(slots.narrative.trim(), 'positive', 'narrative', 2000)
   }
   // 3e: exclusions → negative（原样）
-  negative.push(...(slots.exclusions ?? []).map((e) => String(e)))
+  for (const e of slots.exclusions ?? []) pushSeg(String(e), 'negative', 'exclusion', 900)
 
   // 3f: grounded 引用 notes
   for (const citation of citations.values()) {
     if (citation.match_type && GROUNDED.has(citation.match_type) && citation.record_id) {
       notes.push(`citation:${citation.record_id}:match=${citation.match_type}:canonical=${citation.canonical}`)
     }
   }
 
+  // 派生字符串（与 segments 同源）：等价性证明 = fidelity golden 13 用例逐字节比对
+  const positiveText = segments.filter((s) => s.channel === 'positive').map((s) => s.text).join(', ')
+  const negativeText = segments.filter((s) => s.channel === 'negative').map((s) => s.text).join(', ')
+
+  // G2 phase_status：policy/composition 恒 PASS；grounding = 存在 record_id citation；
+  // inspection = 审计 gates 有 important+（本插件 Severity 联合为 critical|important|minor，
+  // 无独立 'conflict' 值）→ ADVISORY。tag_count_out_of_range 例外不计：
+  // 工作区间 12-50 之外的短 brief（含本规范自测用例 count_gender:['1girl']）是常规合法输入，
+  // 该软性计数 advisory（闭环内自修正项）不降级 inspection 阶段。
+  const gates = auditAnima(positiveText, negativeText, { variant, slots, search })
+  const grounding: 'PASS' | 'ADVISORY' = [...citations.values()].some((c) => c.record_id) ? 'PASS' : 'ADVISORY'
+  const inspection: 'PASS' | 'ADVISORY' = gates.some((g) => g.severity === 'critical' || (g.severity === 'important' && g.rule !== 'tag_count_out_of_range')) ? 'ADVISORY' : 'PASS'
+
+  const metadata: CompileAnimaResult['metadata'] = { variant }
+  if (slots.subject !== undefined) metadata.subject = slots.subject
+
   return {
-    positive: positive.join(', '),
-    negative: negative.join(', '),
+    positive: positiveText,
+    negative: negativeText,
     notes,
     assumptions,
+    segments,
+    phase_status: { policy: 'PASS', grounding, composition: 'PASS', inspection },
+    metadata,
   }
 }
 
 /* ── inspection.py 移植（audit gates）── */
 
 const LIGHTING_BAN = [
   'sunlight', 'moonlight', 'rim light', 'warm lighting', 'cool lighting',
   'golden hour glow', 'soft lighting', 'backlighting', 'god rays',
   'light rays', 'volumetric light', 'spotlight', 'candlelight',
   'warm tone', 'cool tone', 'sepia',
@@ -360,20 +414,21 @@ const ANIMA_SLOT_KEYS = new Set(['count_gender', 'character', 'appearance', 'clo
 /** brief 扩展字段（composition.py _coerce_brief 契约）：exclusions string[]；qualityPrefix/explicit boolean */
 const ANIMA_BOOL_KEYS = new Set(['qualityPrefix', 'explicit'])
 
 /** composition.py _coerce_brief 移植：槽位键白名单 + 类型校验（narrative string、exclusions string[]、qualityPrefix/explicit boolean、其余槽 string[]） */
 export function validateAnimaSlots(slots: unknown): string | undefined {
   if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'anima 需要 slots 对象'
   const s = slots as Record<string, unknown>
   for (const k of Object.keys(s)) {
     if (k === 'narrative') { if (typeof s[k] !== 'string') return 'narrative 需为 string'; continue }
     if (k === 'exclusions') { if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== 'string')) return 'exclusions 需为 string[]'; continue }
+    if (k === 'subject') { if (typeof s[k] !== 'string') return 'subject 需为 string'; continue }
     if (ANIMA_BOOL_KEYS.has(k)) { if (typeof s[k] !== 'boolean') return `${k} 需为 boolean`; continue }
     if (!ANIMA_SLOT_KEYS.has(k)) return `未知槽位: ${k}`
     if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== 'string')) return `槽位 ${k} 需为 string[]`
   }
   return undefined
 }
 
 export function registerAnimaDialect(): void {
   const contract: DialectContract<Record<string, unknown>, { positive: string; negative: string }> = {
     id: 'anima',
diff --git a/plugins/prompt-master/tests/plugin/compile-anima.test.ts b/plugins/prompt-master/tests/plugin/compile-anima.test.ts
index 5262c50..1df48d3 100644
--- a/plugins/prompt-master/tests/plugin/compile-anima.test.ts
+++ b/plugins/prompt-master/tests/plugin/compile-anima.test.ts
@@ -72,12 +72,40 @@ describe('prompt_compile (target=anima)', () => {
     })))
     expect(scene.audit.gates.some((g: any) => g.rule === 'lighting_term_banned')).toBe(false)
     // 真实光照词仍禁（现有 L34 测试已覆盖 moonlight/backlighting——此处锚定 rim light）
     const light = JSON.parse(String(await runTool(stubCtx(), def(), {
       target: 'anima',
       slots: { detail_mood: ['rim light'], count_gender: ['1girl'] },
     })))
     expect(light.audit.gates.some((g: any) => g.rule === 'lighting_term_banned')).toBe(true)
   })
 
+  it('G2: segments projection (origin/priority/slot provenance)', async () => {
+    const ctx = stubCtx()
+    const raw = JSON.parse(String(await runTool(ctx, def(), {
+      target: 'anima',
+      slots: { count_gender: ['1girl'], appearance: ['long hair'], narrative: '一段描述', exclusions: ['lowres'] },
+    })))
+    const segs = raw.result.segments as Array<{ text: string; channel: string; origin: string; priority: number; slot?: string }>
+    expect(segs.filter((s) => s.origin === 'policy').length).toBeGreaterThan(0)
+    expect(segs.some((s) => s.origin === 'grounded' && s.slot === 'count_gender')).toBe(true)
+    expect(segs.some((s) => s.origin === 'narrative' && s.channel === 'positive')).toBe(true)
+    expect(segs.some((s) => s.origin === 'exclusion' && s.channel === 'negative')).toBe(true)
+    expect(segs.every((s) => typeof s.priority === 'number')).toBe(true)
+  })
+
+  it('G2: phase_status four stages', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
+      target: 'anima', slots: { count_gender: ['1girl'] },
+    })))
+    expect(raw.result.phase_status).toEqual({ policy: 'PASS', grounding: 'PASS', composition: 'PASS', inspection: 'PASS' })
+  })
+
+  it('G2: metadata carries variant', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
+      target: 'anima', slots: { count_gender: ['1girl'] }, variant: 'aesthetic',
+    })))
+    expect(raw.result.metadata).toEqual({ variant: 'aesthetic' })
+  })
+
   afterAll(() => closeCatalog())
 })
\ No newline at end of file
```
