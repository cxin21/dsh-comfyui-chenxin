# Review package - 89641cd..91c1196

## Commits
``````

## Stat
``` .../src/pe-framework/anima-knowledge/relations.ts      |  5 ++++-
 .../src/pe-framework/dialect/anima-catalog.ts          |  5 +++--
 .../pe-framework/anima-knowledge/relations.test.ts     | 16 +++++++++++++++-
 .../tests/pe-framework/dialect/anima-catalog.test.ts   | 18 +++++++++++++++++-
 4 files changed, 39 insertions(+), 5 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts
index 5f58430..baf1807 100644
--- a/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts
+++ b/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts
@@ -9,20 +9,23 @@
  * - cli.py relation.* actions（默认路径 <preset>/temp/anima-prompt-v1/relation-overlay.sqlite）
  *
  * node:sqlite DatabaseSync 读写模式；每次操作开/关连接（对齐源码 closing(connection)）。
  * 零日志。
  */
 import { DatabaseSync } from 'node:sqlite'
 import { mkdirSync } from 'node:fs'
 import { dirname, join } from 'node:path'
 import { createHash } from 'node:crypto'
 import { resolveKnowledgePath } from '../resources/resolve.js'
+// MF-1：normalizeTag 值导入（anima-catalog 是下层模块；两侧均为函数声明，ESM 循环 import 安全，
+// 运行期只在函数体内互调）。overlayStatus 路径探针反向依赖已存在（anima-catalog → relations）。
+import { normalizeTag } from '../dialect/anima-catalog.js'
 import type { MatchKind } from '../dialect/anima-catalog.js'
 
 export const RELATION_TYPES = ['parent', 'child', 'related'] as const
 export type RelationType = (typeof RELATION_TYPES)[number]
 
 export interface ProposalRow {
   proposal_id: string
   from_record_id: string
   to_record_id: string
   relation_type: string
@@ -224,21 +227,21 @@ export function submitProposal(
        (proposal_id, from_record_id, to_record_id, relation_type, status,
         confidence, source, rationale, model, evidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(from_record_id, to_record_id, relation_type) DO UPDATE SET
          proposal_id=excluded.proposal_id,
          status=CASE WHEN relation_proposals.status='accepted' THEN 'accepted' ELSE excluded.status END,
          confidence=excluded.confidence, source=excluded.source,
          rationale=excluded.rationale, model=excluded.model,
          evidence=excluded.evidence, updated_at=excluded.updated_at`,
     ).run(
-      proposalId, p.from, p.to, p.relation,
+      proposalId, normalizeTag(p.from), normalizeTag(p.to), p.relation,
       p.confidence, 'llm', p.rationale, opts?.model ?? 'current-llm',
       JSON.stringify(p.evidence), now, now,
     )
   } finally {
     db.close()
   }
   return { proposal_id: proposalId, status: 'candidate' }
 }
 
 /** relation.list 语义：status 过滤（默认 all，对齐 CLI --status 默认），confidence DESC, proposal_id 排序 */
diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index 23c977e..f909412 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -25,21 +25,20 @@ export interface CatalogQueryOptions {
   /** G7：records.category 白名单（下划线/空格等价归一） */
   categories?: string[]
   /** G7：source 白名单（names.source_id 精确匹配 ∪ records.source_ids 包含匹配）。
    *  overlay accepted 别名命中同样受 categories/sources 过滤（目标端解析走 records JOIN）。 */
   sources?: string[]
 }
 
 export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'
 
 const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
-const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })
 
 let _db: DatabaseSync | null = null
 /** 惰性解析（MF-1）：路径在 db() 打开时才解析，保证 setPresetRoot(config.presetRoot) 先于路径求值；
  *  模块求值期不再触碰文件系统（resolveKnowledgePath fallback 失败的 throw 不再发生在 import 时）。 */
 let _dbPathOverride: string | null = process.env.ANIMA_CATALOG_PATH ?? null
 let _manifestChecked = false
 /** G4（Task 1）：句柄缓存 mtime 与 manifest 对账结果（mtime 变化 → close+reopen + 重新对账） */
 let _lastMtimeMs = 0
 let _dbGeneration = 0
 let _manifestChecks = 0
@@ -247,21 +246,23 @@ export function classifyTag(tag: string): MatchKind {
   }
   return 'miss'
 }
 
 /** relation-overlay 缺失 → 降级空视图 + advisory（B3 定案） */
 export function overlayView(): { tags: Record<string, string> } {
   return { tags: {} }
 }
 
 export function overlayStatus(): 'available' | 'unavailable' {
-  return existsSync(defaultOverlayPath()) ? 'available' : 'unavailable'
+  // MF-2：探针与 relations.ts 写入路径一致（overlayLibraryPath = <preset>/temp/anima-prompt-v1/relation-overlay.sqlite），
+  // 不再探 knowledge 目录的旧位置；env ANIMA_OVERLAY_PATH / setOverlayPath 覆盖同样生效。
+  return existsSync(overlayLibraryPath()) ? 'available' : 'unavailable'
 }
 
 export const OVERLAY_ADVISORY = 'overlay_unavailable'
 
 export function catalogMeta(): { file: string; sizeBytes: number; tables: string[]; fts: boolean } {
   const tables = db()
     .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
     .all()
     .map((r) => (r as { name: string }).name)
   const fts = tables.includes('catalog_fts')
diff --git a/plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts b/plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts
index a463d9a..d69118f 100644
--- a/plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts
@@ -100,21 +100,21 @@ describe('overlay lifecycle (tmp db)', () => {
       { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child', rationale: 'blue hair is a kind of hair', evidence: ['taxonomy'] },
       { classify },
     )
     if (!('proposal_id' in r)) throw new Error(`submit failed: ${JSON.stringify(r)}`)
     expect(r.status).toBe('candidate')
     // 目录不存在 → mkdir -p（db 已落盘）
     expect(existsSync(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))).toBe(true)
 
     const candidates = listProposals({ status: 'candidate' })
     expect(candidates).toHaveLength(1)
-    expect(candidates[0].from_record_id).toBe('blue_hair')
+    expect(candidates[0].from_record_id).toBe('blue hair')
     expect(candidates[0].to_record_id).toBe('hair')
     expect(candidates[0].relation_type).toBe('child')
 
     const acc = decideProposal(r.proposal_id, 'accept')
     expect(acc).toEqual({ proposal_id: r.proposal_id, status: 'accepted' })
     expect(listProposals({ status: 'candidate' })).toHaveLength(0)
     expect(listProposals({ status: 'accepted' })).toHaveLength(1)
     expect(listProposals({ status: 'all' })).toHaveLength(1)
   })
 
@@ -156,11 +156,25 @@ describe('overlay lifecycle (tmp db)', () => {
   })
 
   it('submit with endpoint missing → ok:false, nothing persisted', () => {
     const r = submitProposal(
       { source_tag: 'blue_hair', target_tag: 'ghost_tag', relation: 'child' },
       { classify },
     )
     expect(r).toEqual({ ok: false, issues: [expect.stringContaining('ghost_tag')] })
     expect(listProposals({ status: 'all' })).toHaveLength(0)
   })
+
+  it('MF-1: underscore endpoints stored normalized (matches overlayAliasHits from_record_id=? query)', () => {
+    const r = submitProposal(
+      { source_tag: 'blue_hair', target_tag: 'long_hair', relation: 'related', rationale: 'color variant', evidence: ['taxonomy'] },
+      { classify },
+    )
+    if (!('proposal_id' in r)) throw new Error('submit failed')
+    decideProposal(r.proposal_id, 'accept')
+    const rows = listProposals({ status: 'accepted' })
+    expect(rows).toHaveLength(1)
+    // 存储面归一化：查询侧 overlayAliasHits 用 normalizeTag(tag) 做 from_record_id=? —— 存储必须同形
+    expect(rows[0].from_record_id).toBe('blue hair')
+    expect(rows[0].to_record_id).toBe('long hair')
+  })
 })
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
index fdb30fe..fa85869 100644
--- a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
@@ -1,16 +1,16 @@
 import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest'
 import { mkdtempSync, rmSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
 import { searchCatalog, classifyTag, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'
-import { setOverlayPath, openOverlayDb } from '../../../src/pe-framework/anima-knowledge/relations.js'
+import { setOverlayPath, openOverlayDb, submitProposal, decideProposal } from '../../../src/pe-framework/anima-knowledge/relations.js'
 
 let tmp: string
 
 beforeEach(() => {
   tmp = mkdtempSync(join(tmpdir(), 'pm-g7-'))
   setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
 })
 
 afterEach(() => {
   setOverlayPath('')
@@ -113,13 +113,29 @@ describe('G7: overlay accepted-alias resolution in cascade', () => {
 
   it('G7 fix: overlay alias hits respect categories/sources filters (filter active → overlay target 被过滤掉)', () => {
     seedAccepted('glistening hair', 'waving')
     // 不带过滤：overlay alias 命中在（对照）
     expect(searchCatalog('glistening hair', { mode: 'exact' }).length).toBeGreaterThan(0)
     // categories 过滤不含目标 record → overlay 命中被过滤排除
     expect(searchCatalog('glistening hair', { mode: 'exact', categories: ['nonexistent_category_xyz'] })).toEqual([])
     // sources 过滤同理
     expect(searchCatalog('glistening hair', { mode: 'exact', sources: ['official_anima_rule:protocol-v1@anima-f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b'] })).toEqual([])
   })
+
+  it('MF-1: underscore-endpoint round-trip — submit(underline) → accept → searchCatalog(normalized) surfaces overlay alias', () => {
+    // 'blue hair' 是真实 catalog 端点（classifyTag 走 normalizeTag → 查 names.normalized_value）
+    expect(classifyTag('blue_hair')).toBe('canonical')
+    const sub = submitProposal(
+      { source_tag: 'blue_hair', target_tag: 'waving', relation: 'related', rationale: 'test round-trip', evidence: ['taxonomy'] },
+      { classify: classifyTag },
+    )
+    if (!('proposal_id' in sub)) throw new Error(`submit failed: ${JSON.stringify(sub)}`)
+    decideProposal(sub.proposal_id, 'accept')
+    // 'blue hair' 本身是 canonical：cascade 命中在前，overlay alias 追加在后（永不降级）
+    const hits = searchCatalog('blue hair', { limit: 100000 })
+    const overlayHits = hits.filter((h) => h.prompt_form === 'waving')
+    expect(overlayHits.length).toBeGreaterThan(0)
+    expect(overlayHits[0].match_type).toBe('alias')
+  })
 })
 
 afterAll(() => closeCatalog())
```
