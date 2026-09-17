# Review package - 70c3124..89641cd

## Commits
``````

## Stat
``` .../src/pe-framework/dialect/anima-catalog.ts            | 16 +++++++++-------
 .../tests/pe-framework/dialect/anima-catalog.test.ts     | 10 ++++++++++
 2 files changed, 19 insertions(+), 7 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index 0d503a6..23c977e 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -17,21 +17,22 @@ export interface CatalogHit {
   usage_count?: number
   raw?: string
 }
 
 export interface CatalogQueryOptions {
   /** G7：auto/exact 级联之外支持单级直查（canonical/alias/fuzzy） */
   mode?: 'auto' | 'exact' | 'canonical' | 'alias' | 'fuzzy'
   limit?: number
   /** G7：records.category 白名单（下划线/空格等价归一） */
   categories?: string[]
-  /** G7：source 白名单（names.source_id 精确匹配 ∪ records.source_ids 包含匹配） */
+  /** G7：source 白名单（names.source_id 精确匹配 ∪ records.source_ids 包含匹配）。
+   *  overlay accepted 别名命中同样受 categories/sources 过滤（目标端解析走 records JOIN）。 */
   sources?: string[]
 }
 
 export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'
 
 const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
 const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })
 
 let _db: DatabaseSync | null = null
 /** 惰性解析（MF-1）：路径在 db() 打开时才解析，保证 setPresetRoot(config.presetRoot) 先于路径求值；
@@ -171,37 +172,38 @@ function fuzzyQuery(value: string, limit: number, categories?: string[], sources
     match_type: 'fuzzy',
     prompt_form: r.prompt_form,
     record_id: r.record_id,
     usage_count: r.usage_count,
     raw: r.matched_name,
   }))
 }
 
 /** G7 overlay accepted-alias：auto/exact 级联全部落空后，读 overlay accepted 提案
  *  （from_record_id=查询 tag）→ 目标端按 canonical→alias 解析，命中以 alias 级返回。
- *  canonical 保护：本函数只在 catalog 级联零命中时执行，真实 canonical/alias 命中永不降级。 */
-function overlayAliasHits(normalized: string, limit: number): CatalogHit[] {
+ *  canonical 保护：本函数只在 catalog 级联零命中时执行，真实 canonical/alias 命中永不降级。
+ *  G7：categories/sources 过滤透传到目标端 exactQuery 解析（overlay 命中走 records JOIN，真实过滤而非豁免）。 */
+function overlayAliasHits(normalized: string, limit: number, categories?: string[], sources?: string[]): CatalogHit[] {
   if (!existsSync(overlayLibraryPath())) return []
   const odb = openOverlayDb()
   try {
     const rows = odb
       .prepare(
         "SELECT DISTINCT to_record_id FROM relation_proposals WHERE status='accepted' AND from_record_id=? ORDER BY to_record_id",
       )
       .all(normalized) as Array<{ to_record_id: string }>
     const hits: CatalogHit[] = []
     for (const row of rows) {
       const target = normalizeTag(row.to_record_id)
       if (!target) continue
-      const resolved = exactQuery(target, 'canonical', limit - hits.length).length
-        ? exactQuery(target, 'canonical', limit - hits.length)
-        : exactQuery(target, 'alias', limit - hits.length)
+      const resolved = exactQuery(target, 'canonical', limit - hits.length, categories, sources).length
+        ? exactQuery(target, 'canonical', limit - hits.length, categories, sources)
+        : exactQuery(target, 'alias', limit - hits.length, categories, sources)
       for (const h of resolved) {
         hits.push({ ...h, match_type: 'alias' })
         if (hits.length >= limit) return hits
       }
     }
     return hits
   } finally {
     odb.close()
   }
 }
@@ -218,21 +220,21 @@ export function searchCatalog(tag: string, opts?: CatalogQueryOptions): CatalogH
   if (single) return exactQuery(normalized, single, limit, opts?.categories, opts?.sources)
   const mode = modeRaw === 'exact' ? 'exact' : 'auto'
   const modes = mode === 'exact' ? (['canonical', 'alias'] as const) : (['canonical', 'alias', 'fuzzy'] as const)
   let cascadeHits: CatalogHit[] = []
   for (const m of modes) {
     const hits = m === 'fuzzy' ? fuzzyQuery(tag, limit, opts?.categories, opts?.sources) : exactQuery(normalized, m, limit, opts?.categories, opts?.sources)
     if (hits.length) { cascadeHits = hits.slice(0, limit); break }
   }
   // G7：级联结果之后追加 overlay accepted 别名命中（alias 级；canonical/alias 命中在前，永不降级）
   if (cascadeHits.length >= limit) return cascadeHits
-  const overlay = overlayAliasHits(normalized, limit - cascadeHits.length)
+  const overlay = overlayAliasHits(normalized, limit - cascadeHits.length, opts?.categories, opts?.sources)
   return overlay.length ? [...cascadeHits, ...overlay] : cascadeHits
 }
 
 /** 单标签类别判定（canonical/alias/fuzzy/miss）——测试与前端分流用 */
 export function classifyTag(tag: string): MatchKind {
   const normalized = normalizeTag(tag)
   if (!normalized) return 'miss'
   const dbc = db()
   const canonical = dbc.prepare("SELECT 1 FROM names WHERE normalized_value=? AND name_type='canonical'").get(normalized)
   if (canonical) return 'canonical'
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
index 4049541..fdb30fe 100644
--- a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
@@ -103,13 +103,23 @@ describe('G7: overlay accepted-alias resolution in cascade', () => {
     seedAccepted('silvery hair', 'waving') // silvery hair 本身就是 canonical
     const hits = searchCatalog('silvery hair')
     expect(hits[0].match_type).toBe('canonical')
     expect(hits[0].prompt_form).toBe('silvery hair')
   })
 
   it('overlay alias does not fire when overlay is empty (golden 行为不变)', () => {
     expect(searchCatalog('zzzzzzzzq')).toEqual([])
     expect(classifyTag('wave')).toBe('alias')
   })
+
+  it('G7 fix: overlay alias hits respect categories/sources filters (filter active → overlay target 被过滤掉)', () => {
+    seedAccepted('glistening hair', 'waving')
+    // 不带过滤：overlay alias 命中在（对照）
+    expect(searchCatalog('glistening hair', { mode: 'exact' }).length).toBeGreaterThan(0)
+    // categories 过滤不含目标 record → overlay 命中被过滤排除
+    expect(searchCatalog('glistening hair', { mode: 'exact', categories: ['nonexistent_category_xyz'] })).toEqual([])
+    // sources 过滤同理
+    expect(searchCatalog('glistening hair', { mode: 'exact', sources: ['official_anima_rule:protocol-v1@anima-f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b'] })).toEqual([])
+  })
 })
 
 afterAll(() => closeCatalog())
```
