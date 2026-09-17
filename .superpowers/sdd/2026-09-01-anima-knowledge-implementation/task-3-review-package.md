# Review package - 24e1874..47a26be

## Commits
``````

## Stat
``` plugins/prompt-master/src/tools/catalog-search.ts       | 13 ++++++++++---
 .../prompt-master/tests/plugin/catalog-search.test.ts   | 17 +++++++++++++++++
 2 files changed, 27 insertions(+), 3 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/tools/catalog-search.ts b/plugins/prompt-master/src/tools/catalog-search.ts
index a4509d4..f944ac6 100644
--- a/plugins/prompt-master/src/tools/catalog-search.ts
+++ b/plugins/prompt-master/src/tools/catalog-search.ts
@@ -1,35 +1,42 @@
 import { defineTool } from '@deepseek-ai/dsh-tools'
-import { searchCatalog, overlayStatus, type CatalogHit, type CatalogQueryOptions } from '../pe-framework/dialect/anima-catalog.js'
+import { lastManifestCheck, overlayStatus, searchCatalog, type CatalogHit, type CatalogQueryOptions } from '../pe-framework/dialect/anima-catalog.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 /** 纯查询（无 LLM）：Anima 证据检索 → JSON 字符串 */
 export function registerCatalogSearchTool(_ctx: Context, _config: Config) {
   return defineTool({
     name: 'catalog_search',
     description:
       'Anima tag-catalog 证据查询（canonical/alias/fuzzy/miss 级联；不自动改写）。返回命中列表与 overlay 状态。',
     parameters: {
       tag: { type: 'string', description: '待查询标签（必填）' },
       mode: { type: 'string', default: 'auto', description: 'auto（canonical→alias→fuzzy 级联）/ exact（无 fuzzy）' },
       limit: { type: 'integer', default: 5, description: '返回命中数上限（1-20）' },
     },
     output: {
-      schema: { type: 'string', description: 'JSON 字符串 {hits, overlay}' },
+      schema: { type: 'string', description: 'JSON 字符串 {hits[].candidate, advisories?, manifest, overlay}' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
     async execute(args: { tag?: string; mode?: string; limit?: number }) {
       const tag = String(args.tag ?? '').trim()
       if (!tag) throw new Error('tag is required')
       const mode = (args.mode === 'exact' ? 'exact' : 'auto') as CatalogQueryOptions['mode']
       let limit = args.limit ?? 5
       if (!(limit >= 1 && limit <= 20)) limit = 5
       const hits: CatalogHit[] = searchCatalog(tag, { mode, limit })
       const status = overlayStatus()
+      // G5：fuzzy 命中仅作候选参考；usage_count 低于采纳阈值时给出 advisory
+      const flagged = hits.map((h) => ({ ...h, candidate: h.match_type === 'fuzzy' }))
+      const advisories = flagged
+        .filter((h) => h.match_type === 'fuzzy' && (h.usage_count ?? 0) < 1000)
+        .map((h) => `fuzzy_below_threshold: usage_count=${h.usage_count ?? 0} 低于采纳阈值 1000，仅作候选参考`)
       return JSON.stringify({
-        hits,
+        hits: flagged,
+        advisories: advisories.length > 0 ? advisories : undefined,
+        manifest: lastManifestCheck(),
         overlay: { status, advisory: status === 'available' ? undefined : 'overlay_unavailable：关系覆盖层未启用——运行 anima-prompt-v1 relation.submit 初始化后可见 overlay 命中' },
       })
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/plugin/catalog-search.test.ts b/plugins/prompt-master/tests/plugin/catalog-search.test.ts
index d34472a..bd050fa 100644
--- a/plugins/prompt-master/tests/plugin/catalog-search.test.ts
+++ b/plugins/prompt-master/tests/plugin/catalog-search.test.ts
@@ -37,12 +37,29 @@ describe('catalog_search', () => {
     expect(raw.hits.length).toBe(1)
     const raw2 = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 99 })))
     expect(raw2.hits.length).toBe(5)
   })
 
   it('unknown mode tolerates as auto', async () => {
     const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silvery hair', mode: 'bogus' })))
     expect(raw.hits[0].match_type).toBe('canonical')
   })
 
+  it('G5: fuzzy hits carry candidate=true; canonical without', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 3 })))
+    for (const h of raw.hits) expect(h.candidate).toBe(h.match_type === 'fuzzy')
+  })
+
+  it('G5: fuzzy_below_threshold advisory when usage_count < 1000', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 5 })))
+    const lowUse = (raw.hits ?? []).some((h: any) => h.match_type === 'fuzzy' && (h.usage_count ?? 0) < 1000)
+    if (lowUse) expect((raw.advisories ?? []).some((a: string) => a.includes('fuzzy_below_threshold'))).toBe(true)
+  })
+
+  it('G4: manifest status surfaced in output', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: '1girl' })))
+    expect(raw.manifest).toBeDefined()
+    expect(typeof raw.manifest.ok).toBe('boolean')
+  })
+
   afterAll(() => closeCatalog())
 })
\ No newline at end of file
```
