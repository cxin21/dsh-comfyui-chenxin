# Review package - 96bb73a..70c3124

## Commits
``````

## Stat
``` .../src/pe-framework/dialect/anima-catalog.ts      | 102 +++++++++++++++--
 plugins/prompt-master/src/plugin/index.ts          |   2 +
 .../prompt-master/src/tools/catalog-relations.ts   | 123 +++++++++++++++++++++
 .../pe-framework/dialect/anima-catalog.test.ts     | 115 +++++++++++++++++++
 .../tests/plugin/catalog-relations.test.ts         | 111 +++++++++++++++++++
 .../prompt-master/tests/plugin/registry.test.ts    |   4 +-
 6 files changed, 443 insertions(+), 14 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index 90152f4..0d503a6 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -1,32 +1,38 @@
 /**
  * Anima tag-catalog 查询层（P2 定案）。
  * 来源：comfyui-chenxin preset knowledge/tag-catalog.sqlite（FTS5 1.39M 行）+ catalog/search.py 匹配语义。
  * node:sqlite DatabaseSync 只读直读；canonical→alias→fuzzy 级联（mode auto）；'exact' = 不含 fuzzy 的精确级联。
  */
 import { DatabaseSync } from 'node:sqlite'
 import { statSync, existsSync } from 'node:fs'
 import { dirname } from 'node:path'
 import { resolveKnowledgePath } from '../resources/resolve.js'
 import { assertAnimaCatalog } from '../resources/manifest.js'
+import { openOverlayDb, overlayPath as overlayLibraryPath } from '../anima-knowledge/relations.js'
 
 export interface CatalogHit {
   match_type: 'canonical' | 'alias' | 'fuzzy' | 'miss'
   prompt_form?: string
   record_id?: string
   usage_count?: number
   raw?: string
 }
 
 export interface CatalogQueryOptions {
-  mode?: 'auto' | 'exact'
+  /** G7：auto/exact 级联之外支持单级直查（canonical/alias/fuzzy） */
+  mode?: 'auto' | 'exact' | 'canonical' | 'alias' | 'fuzzy'
   limit?: number
+  /** G7：records.category 白名单（下划线/空格等价归一） */
+  categories?: string[]
+  /** G7：source 白名单（names.source_id 精确匹配 ∪ records.source_ids 包含匹配） */
+  sources?: string[]
 }
 
 export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'
 
 const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
 const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })
 
 let _db: DatabaseSync | null = null
 /** 惰性解析（MF-1）：路径在 db() 打开时才解析，保证 setPresetRoot(config.presetRoot) 先于路径求值；
  *  模块求值期不再触碰文件系统（resolveKnowledgePath fallback 失败的 throw 不再发生在 import 时）。 */
@@ -98,64 +104,136 @@ export function normalizeTag(value: string): string {
 
 /** search.py _fts_query 移植：OR + prefix tokens（word-root discovery） */
 export function ftsQuery(value: string): string {
   return normalizeTag(value)
     .split(' ')
     .filter(Boolean)
     .map((part) => `"${part.replaceAll('"', '')}"*`)
     .join(' OR ')
 }
 
-function exactQuery(normalized: string, nameType: 'canonical' | 'alias', limit: number): CatalogHit[] {
+/** G7 过滤子句：categories / sources → WHERE 片段 + 参数（全部参数化，无注入面） */
+function filterClause(categories?: string[], sources?: string[]): { sql: string; params: string[] } {
+  const clauses: string[] = []
+  const params: string[] = []
+  if (categories?.length) {
+    const values = new Set<string>()
+    for (const raw of categories) {
+      const trimmed = raw.trim().toLowerCase()
+      if (!trimmed) continue
+      values.add(trimmed)
+      values.add(trimmed.replaceAll(' ', '_'))
+      values.add(trimmed.replaceAll('_', ' '))
+    }
+    const list = [...values]
+    if (list.length) {
+      clauses.push(`r.category IN (${list.map(() => '?').join(',')})`)
+      params.push(...list)
+    }
+  }
+  if (sources?.length) {
+    const clean = sources.map((s) => s.trim()).filter(Boolean)
+    if (clean.length) {
+      // 每个 source 两个匹配面：names.source_id 精确 ∪ records.source_ids（JSON 数组文本）带引号包含
+      clauses.push(`(n.source_id IN (${clean.map(() => '?').join(',')}) OR (${clean.map(() => 'r.source_ids LIKE ?').join(' OR ')}))`)
+      params.push(...clean)
+      params.push(...clean.map((s) => `%"${s.replaceAll('"', '')}"%`))
+    }
+  }
+  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params }
+}
+
+function exactQuery(normalized: string, nameType: 'canonical' | 'alias', limit: number, categories?: string[], sources?: string[]): CatalogHit[] {
+  const filter = filterClause(categories, sources)
   const rows = db()
     .prepare(
-      "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM names n JOIN records r ON r.record_id=n.record_id WHERE n.normalized_value=? AND n.name_type=? ORDER BY r.usage_count DESC, r.record_id LIMIT ?",
+      "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM names n JOIN records r ON r.record_id=n.record_id WHERE n.normalized_value=? AND n.name_type=?" + filter.sql + " ORDER BY r.usage_count DESC, r.record_id LIMIT ?",
     )
-    .all(normalized, nameType, limit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
+    .all(normalized, nameType, ...filter.params, limit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
   return rows.map((r) => ({
     match_type: nameType,
     prompt_form: r.prompt_form,
     record_id: r.record_id,
     usage_count: r.usage_count,
     raw: r.matched_name,
   }))
 }
 
-function fuzzyQuery(value: string, limit: number): CatalogHit[] {
+function fuzzyQuery(value: string, limit: number, categories?: string[], sources?: string[]): CatalogHit[] {
   const fts = ftsQuery(value)
   if (!fts) return []
+  const filter = filterClause(categories, sources)
   const rows = db()
     .prepare(
-      "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM catalog_fts f JOIN names n ON n.name_id=f.name_id JOIN records r ON r.record_id=f.record_id WHERE catalog_fts MATCH ? ORDER BY bm25(catalog_fts), r.usage_count DESC LIMIT ?",
+      "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM catalog_fts f JOIN names n ON n.name_id=f.name_id JOIN records r ON r.record_id=f.record_id WHERE catalog_fts MATCH ?" + filter.sql + " ORDER BY bm25(catalog_fts), r.usage_count DESC LIMIT ?",
     )
-    .all(fts, limit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
+    .all(fts, ...filter.params, limit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
   return rows.map((r) => ({
     match_type: 'fuzzy',
     prompt_form: r.prompt_form,
     record_id: r.record_id,
     usage_count: r.usage_count,
     raw: r.matched_name,
   }))
 }
 
-/** 匹配语义对齐 catalog/search.py：auto=canonical→alias→fuzzy 级联；exact=canonical→alias（无 fuzzy） */
+/** G7 overlay accepted-alias：auto/exact 级联全部落空后，读 overlay accepted 提案
+ *  （from_record_id=查询 tag）→ 目标端按 canonical→alias 解析，命中以 alias 级返回。
+ *  canonical 保护：本函数只在 catalog 级联零命中时执行，真实 canonical/alias 命中永不降级。 */
+function overlayAliasHits(normalized: string, limit: number): CatalogHit[] {
+  if (!existsSync(overlayLibraryPath())) return []
+  const odb = openOverlayDb()
+  try {
+    const rows = odb
+      .prepare(
+        "SELECT DISTINCT to_record_id FROM relation_proposals WHERE status='accepted' AND from_record_id=? ORDER BY to_record_id",
+      )
+      .all(normalized) as Array<{ to_record_id: string }>
+    const hits: CatalogHit[] = []
+    for (const row of rows) {
+      const target = normalizeTag(row.to_record_id)
+      if (!target) continue
+      const resolved = exactQuery(target, 'canonical', limit - hits.length).length
+        ? exactQuery(target, 'canonical', limit - hits.length)
+        : exactQuery(target, 'alias', limit - hits.length)
+      for (const h of resolved) {
+        hits.push({ ...h, match_type: 'alias' })
+        if (hits.length >= limit) return hits
+      }
+    }
+    return hits
+  } finally {
+    odb.close()
+  }
+}
+
+/** 匹配语义对齐 catalog/search.py：auto=canonical→alias→fuzzy 级联；exact=canonical→alias（无 fuzzy）；
+ *  G7：canonical/alias/fuzzy 单级直查；auto/exact 级联落空后追加 overlay accepted 别名命中。 */
 export function searchCatalog(tag: string, opts?: CatalogQueryOptions): CatalogHit[] {
   const normalized = normalizeTag(tag)
   const limit = opts?.limit === undefined ? 20 : opts.limit
   if (!normalized || limit < 1) return []
-  const mode = opts?.mode === 'exact' ? 'exact' : 'auto'
+  const modeRaw = opts?.mode ?? 'auto'
+  const single = modeRaw === 'canonical' || modeRaw === 'alias' || modeRaw === 'fuzzy' ? modeRaw : null
+  if (single === 'fuzzy') return fuzzyQuery(tag, limit, opts?.categories, opts?.sources)
+  if (single) return exactQuery(normalized, single, limit, opts?.categories, opts?.sources)
+  const mode = modeRaw === 'exact' ? 'exact' : 'auto'
   const modes = mode === 'exact' ? (['canonical', 'alias'] as const) : (['canonical', 'alias', 'fuzzy'] as const)
+  let cascadeHits: CatalogHit[] = []
   for (const m of modes) {
-    const hits = m === 'fuzzy' ? fuzzyQuery(tag, limit) : exactQuery(normalized, m, limit)
-    if (hits.length) return hits.slice(0, limit)
+    const hits = m === 'fuzzy' ? fuzzyQuery(tag, limit, opts?.categories, opts?.sources) : exactQuery(normalized, m, limit, opts?.categories, opts?.sources)
+    if (hits.length) { cascadeHits = hits.slice(0, limit); break }
   }
-  return []
+  // G7：级联结果之后追加 overlay accepted 别名命中（alias 级；canonical/alias 命中在前，永不降级）
+  if (cascadeHits.length >= limit) return cascadeHits
+  const overlay = overlayAliasHits(normalized, limit - cascadeHits.length)
+  return overlay.length ? [...cascadeHits, ...overlay] : cascadeHits
 }
 
 /** 单标签类别判定（canonical/alias/fuzzy/miss）——测试与前端分流用 */
 export function classifyTag(tag: string): MatchKind {
   const normalized = normalizeTag(tag)
   if (!normalized) return 'miss'
   const dbc = db()
   const canonical = dbc.prepare("SELECT 1 FROM names WHERE normalized_value=? AND name_type='canonical'").get(normalized)
   if (canonical) return 'canonical'
   const alias = dbc.prepare("SELECT 1 FROM names WHERE normalized_value=? AND name_type='alias'").get(normalized)
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
index 34f41dd..8db593d 100644
--- a/plugins/prompt-master/src/plugin/index.ts
+++ b/plugins/prompt-master/src/plugin/index.ts
@@ -1,20 +1,21 @@
 import z from '@deepseek-ai/schemastery'
 import type { Context } from '@deepseek-ai/cordis'
 import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
 import { registerExpandTool } from '../tools/prompt-expand.js'
 import { registerReverseTool } from '../tools/prompt-reverse.js'
 import { registerMinimaxTool } from '../tools/minimax-scenario.js'
 import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
 import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
 import { registerCompileTool } from '../tools/prompt-compile.js'
 import { registerCatalogSearchTool } from '../tools/catalog-search.js'
+import { registerCatalogRelationsTool } from '../tools/catalog-relations.js'
 import { registerAuditTool } from '../tools/prompt-audit.js'
 import { setCustomProfileSource } from '../resolver/profiles/source.js'
 import { setBuiltinFilter } from '../resolver/profiles/index.js'
 import { registerOverridesNamespace } from '../pe-framework/profiles/storage-v2.js'
 import '../pe-framework/dialect/anima.js'
 import '../pe-framework/dialect/h3.js'
 import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
 import { setPresetRoot } from '../pe-framework/resources/resolve.js'
 import { Config, type Config as ConfigShape } from './config.js'
 
@@ -55,14 +56,15 @@ export function apply(ctx: Context, config: ConfigShape) {
 
   ctx.effect(() => {
     const disposers: (() => void)[] = []
     disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
     disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
     disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
     disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope, overrides })))
     disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
     disposers.push(ctx.tools.register(registerCompileTool(ctx)))
     disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
+    disposers.push(ctx.tools.register(registerCatalogRelationsTool(ctx, config)))
     disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
     return () => { for (const d of disposers) d() }
   }, 'prompt-master.tools')
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/catalog-relations.ts b/plugins/prompt-master/src/tools/catalog-relations.ts
new file mode 100644
index 0000000..2a70ba2
--- /dev/null
+++ b/plugins/prompt-master/src/tools/catalog-relations.ts
@@ -0,0 +1,123 @@
+import { defineTool } from '@deepseek-ai/dsh-tools'
+import type { Context } from '@deepseek-ai/cordis'
+import {
+  submitProposal,
+  listProposals,
+  decideProposal,
+  openOverlayDb,
+  overlayPath,
+  type ProposalInput,
+} from '../pe-framework/anima-knowledge/relations.js'
+import { classifyTag } from '../pe-framework/dialect/anima-catalog.js'
+import type { Config } from '../plugin/config.js'
+
+type LogCtx = { logger?: { info?: (msg: string) => void } }
+const logInfo = (ctx: Context | null, msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
+
+interface RelationsArgs {
+  action?: string
+  // submit
+  source_tag?: string
+  target_tag?: string
+  relation?: string
+  confidence?: number
+  rationale?: string
+  evidence?: string[]
+  model?: string
+  // list
+  status?: string
+  record_id?: string
+  limit?: number
+  // accept / reject
+  proposal_id?: string
+}
+
+/** overlay 计数（status 面）：candidate/accepted/rejected 三档计数 + 路径 */
+function overlayStatusSummary(): { path: string; exists: boolean; counts: Record<'candidate' | 'accepted' | 'rejected', number> } {
+  const counts = { candidate: 0, accepted: 0, rejected: 0 }
+  const rows = listProposals({ status: 'all', limit: 1_000_000 })
+  for (const r of rows) counts[r.status]++
+  const path = overlayPath()
+  let exists = false
+  try {
+    openOverlayDb().close()
+    exists = true
+  } catch {
+    exists = false
+  }
+  return { path, exists, counts }
+}
+
+/** G1 tool wrapper：relation 提交/生命周期（Task 6 relations.ts）暴露为 catalog_relations。
+ *  纯库零日志；本层只打 action 摘要。classify 接线 dialect/anima-catalog.classifyTag（T6 review carry-over）。 */
+export function registerCatalogRelationsTool(ctx: Context, _config: Config) {
+  return defineTool({
+    name: 'catalog_relations',
+    description:
+      'Anima tag 关系提案生命周期：submit（校验链 + overlay 落盘）/ list / accept / reject / status。' +
+      '端点存在性由 tag-catalog 判定（canonical/alias）；cooccurrence 关系拒收（需真实统计源，非 LLM）。',
+    parameters: {
+      action: { type: 'string', description: 'submit | list | accept | reject | status（必填）' },
+      source_tag: { type: 'string', description: 'submit：关系起点 tag' },
+      target_tag: { type: 'string', description: 'submit：关系终点 tag' },
+      relation: { type: 'string', description: "submit：parent | child | related（cooccurrence 拒收）" },
+      confidence: { type: 'number', description: 'submit：0-1，缺省 0.5' },
+      rationale: { type: 'string', description: 'submit：提交理由（缺省 post-authoring relation proposal）' },
+      evidence: { type: 'array', description: 'submit：证据条目（缺省 ["llm-submission"]）' },
+      model: { type: 'string', description: 'submit：提案来源模型标记（缺省 current-llm）' },
+      status: { type: 'string', description: 'list：candidate | accepted | rejected | all（默认 all）' },
+      record_id: { type: 'string', description: 'list：按端点（from 或 to）过滤' },
+      limit: { type: 'integer', description: 'list：返回条数上限（默认 100）' },
+      proposal_id: { type: 'string', description: 'accept / reject：提案 id（rel:…）' },
+    },
+    output: {
+      schema: { type: 'string', description: 'JSON 字符串（action 结果；错误以可读 message 抛出）' },
+      render: (_a, v) => [{ type: 'text', text: v }],
+    },
+    async execute(args: RelationsArgs) {
+      const action = String(args.action ?? '').trim()
+      if (!action) throw new Error('action is required: submit | list | accept | reject | status')
+      switch (action) {
+        case 'submit': {
+          const input: ProposalInput = {
+            source_tag: String(args.source_tag ?? ''),
+            target_tag: String(args.target_tag ?? ''),
+            relation: String(args.relation ?? ''),
+            confidence: args.confidence,
+            rationale: args.rationale,
+            evidence: args.evidence,
+          }
+          const r = submitProposal(input, { classify: classifyTag, model: args.model })
+          if ('issues' in r) throw new Error(`relation submission rejected: ${r.issues.join('; ')}`)
+          logInfo(ctx, `[prompt-master] catalog_relations submit → ${r.proposal_id} ${input.source_tag.trim()} -${input.relation.trim()}-> ${input.target_tag.trim()}`)
+          return JSON.stringify({ ok: true, proposal_id: r.proposal_id, status: r.status })
+        }
+        case 'list': {
+          const status = (args.status ?? 'all') as 'candidate' | 'accepted' | 'rejected' | 'all'
+          const proposals = listProposals({
+            status,
+            recordId: args.record_id === undefined ? undefined : String(args.record_id),
+            limit: args.limit ?? 100,
+          })
+          logInfo(ctx, `[prompt-master] catalog_relations list status=${status} → ${proposals.length}`)
+          return JSON.stringify({ ok: true, status, proposals })
+        }
+        case 'accept':
+        case 'reject': {
+          const proposalId = String(args.proposal_id ?? '').trim()
+          if (!proposalId) throw new Error(`proposal_id is required for action=${action}`)
+          const r = decideProposal(proposalId, action)
+          logInfo(ctx, `[prompt-master] catalog_relations ${action} → ${r.proposal_id} status=${r.status}`)
+          return JSON.stringify({ ok: true, ...r })
+        }
+        case 'status': {
+          const s = overlayStatusSummary()
+          logInfo(ctx, `[prompt-master] catalog_relations status → candidate=${s.counts.candidate} accepted=${s.counts.accepted} rejected=${s.counts.rejected}`)
+          return JSON.stringify({ ok: true, ...s, overlay: s.exists ? 'available' : 'unavailable' })
+        }
+        default:
+          throw new Error(`unknown catalog_relations action: ${action}`)
+      }
+    },
+  })
+}
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
new file mode 100644
index 0000000..4049541
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
@@ -0,0 +1,115 @@
+import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest'
+import { mkdtempSync, rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { searchCatalog, classifyTag, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'
+import { setOverlayPath, openOverlayDb } from '../../../src/pe-framework/anima-knowledge/relations.js'
+
+let tmp: string
+
+beforeEach(() => {
+  tmp = mkdtempSync(join(tmpdir(), 'pm-g7-'))
+  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
+})
+
+afterEach(() => {
+  setOverlayPath('')
+  rmSync(tmp, { recursive: true, force: true })
+})
+
+describe('G7: single-mode query (direct, no cascade)', () => {
+  it("mode 'canonical' skips alias level (wave → miss)", () => {
+    expect(searchCatalog('wave', { mode: 'canonical' })).toEqual([])
+  })
+
+  it("mode 'alias' resolves alias directly", () => {
+    const hits = searchCatalog('wave', { mode: 'alias' })
+    expect(hits.length).toBeGreaterThan(0)
+    expect(hits[0].match_type).toBe('alias')
+    expect(hits[0].prompt_form).toBe('waving')
+  })
+
+  it("mode 'fuzzy' goes straight to fuzzy level", () => {
+    const hits = searchCatalog('silver hair', { mode: 'fuzzy' })
+    expect(hits.length).toBeGreaterThan(0)
+    expect(hits[0].match_type).toBe('fuzzy')
+  })
+
+  it('single modes respect limit', () => {
+    expect(searchCatalog('silver hair', { mode: 'fuzzy', limit: 1 })).toHaveLength(1)
+  })
+})
+
+describe('G7: categories / sources filters', () => {
+  it('categories filter keeps matching category', () => {
+    const hits = searchCatalog('silvery hair', { mode: 'canonical', categories: ['hair'] })
+    expect(hits.length).toBeGreaterThan(0)
+    expect(hits[0].record_id).toBeDefined()
+  })
+
+  it('categories filter drops non-matching category', () => {
+    expect(searchCatalog('silvery hair', { mode: 'canonical', categories: ['pose'] })).toEqual([])
+  })
+
+  it('sources filter accepts the record source', () => {
+    const hits = searchCatalog('silvery hair', {
+      mode: 'canonical',
+      sources: ['gelbooru_canonical:4dd87da139254abc9f18d2da04ee7b6b691d4e63'],
+    })
+    expect(hits.length).toBeGreaterThan(0)
+  })
+
+  it('sources filter drops foreign source', () => {
+    expect(searchCatalog('silvery hair', {
+      mode: 'canonical',
+      sources: ['official_anima_rule:protocol-v1@anima-f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b'],
+    })).toEqual([])
+  })
+})
+
+describe('G7: overlay accepted-alias resolution in cascade', () => {
+  /** 直接在 overlay 里落一条 accepted 提案（绕过验证链——该链在 T6 已测） */
+  function seedAccepted(from: string, to: string, relation: 'parent' | 'child' | 'related' = 'related') {
+    const db = openOverlayDb()
+    try {
+      db.prepare(
+        `INSERT INTO relation_proposals
+         (proposal_id, from_record_id, to_record_id, relation_type, status, confidence, source, rationale, model, evidence, created_at, updated_at)
+         VALUES (?, ?, ?, ?, 'accepted', 0.9, 'llm', 'test seed', 'test', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
+      ).run(`rel:seed-${from}-${to}`, from, to, relation)
+    } finally {
+      db.close()
+    }
+  }
+
+  it('auto cascade appends overlay accepted alias after fuzzy hits (alias 级追加)', () => {
+    const fuzzyCount = searchCatalog('glistening hair', { mode: 'fuzzy', limit: 100000 }).length
+    expect(fuzzyCount).toBeGreaterThan(0)
+    seedAccepted('glistening hair', 'waving')
+    const limit = fuzzyCount + 1 // 留 1 个追加位
+    const hits = searchCatalog('glistening hair', { limit })
+    expect(hits).toHaveLength(limit)
+    expect(hits[fuzzyCount].match_type).toBe('alias')
+    expect(hits[fuzzyCount].prompt_form).toBe('waving')
+  })
+
+  it('overlay alias also appends in exact mode', () => {
+    seedAccepted('glistening hair', 'waving', 'parent')
+    const hits = searchCatalog('glistening hair', { mode: 'exact' })
+    expect(hits[0].match_type).toBe('alias')
+  })
+
+  it('canonical protection: real canonical hit is never downgraded by overlay', () => {
+    seedAccepted('silvery hair', 'waving') // silvery hair 本身就是 canonical
+    const hits = searchCatalog('silvery hair')
+    expect(hits[0].match_type).toBe('canonical')
+    expect(hits[0].prompt_form).toBe('silvery hair')
+  })
+
+  it('overlay alias does not fire when overlay is empty (golden 行为不变)', () => {
+    expect(searchCatalog('zzzzzzzzq')).toEqual([])
+    expect(classifyTag('wave')).toBe('alias')
+  })
+})
+
+afterAll(() => closeCatalog())
diff --git a/plugins/prompt-master/tests/plugin/catalog-relations.test.ts b/plugins/prompt-master/tests/plugin/catalog-relations.test.ts
new file mode 100644
index 0000000..50a0668
--- /dev/null
+++ b/plugins/prompt-master/tests/plugin/catalog-relations.test.ts
@@ -0,0 +1,111 @@
+import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { mkdtempSync, rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { registerCatalogRelationsTool } from '../../src/tools/catalog-relations.js'
+import { stubCtx, runTool } from './helpers.js'
+import { setOverlayPath } from '../../src/pe-framework/anima-knowledge/relations.js'
+import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'
+
+const cfg = { temperature: 0.7 }
+const def = () => registerCatalogRelationsTool(null as never, cfg as never)
+
+let tmp: string
+
+beforeEach(() => {
+  tmp = mkdtempSync(join(tmpdir(), 'pm-reltool-'))
+  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
+})
+
+afterEach(() => {
+  setOverlayPath('')
+  rmSync(tmp, { recursive: true, force: true })
+})
+
+describe('catalog_relations tool', () => {
+  it('submit → list → accept → status round-trip via injected tmp overlay', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
+    // submit：'wave' 是 catalog alias、'waving' 是 canonical → 端点存在
+    const sub = JSON.parse(String(await runTool(ctx, tool, {
+      action: 'submit',
+      source_tag: 'wave',
+      target_tag: 'waving',
+      relation: 'related',
+      rationale: 'wave is a short form of waving',
+      evidence: ['taxonomy'],
+    })))
+    expect(sub.ok).toBe(true)
+    expect(sub.proposal_id).toMatch(/^rel:/)
+    expect(sub.status).toBe('candidate')
+
+    // list 默认 all
+    const listed = JSON.parse(String(await runTool(ctx, tool, { action: 'list' })))
+    expect(listed.proposals).toHaveLength(1)
+    expect(listed.proposals[0].from_record_id).toBe('wave')
+    expect(listed.proposals[0].to_record_id).toBe('waving')
+    expect(listed.proposals[0].status).toBe('candidate')
+
+    // accept
+    const acc = JSON.parse(String(await runTool(ctx, tool, { action: 'accept', proposal_id: sub.proposal_id })))
+    expect(acc.status).toBe('accepted')
+
+    // status：accepted 计数 1
+    const status = JSON.parse(String(await runTool(ctx, tool, { action: 'status' })))
+    expect(status.counts.accepted).toBe(1)
+    expect(status.counts.candidate).toBe(0)
+    expect(status.overlay).toBe('available')
+  })
+
+  it('reject flips candidate → rejected and list status filter works', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
+    const sub = JSON.parse(String(await runTool(ctx, tool, {
+      action: 'submit', source_tag: 'long hair', target_tag: 'waving', relation: 'related',
+    })))
+    const rej = JSON.parse(String(await runTool(ctx, tool, { action: 'reject', proposal_id: sub.proposal_id })))
+    expect(rej.status).toBe('rejected')
+    const listed = JSON.parse(String(await runTool(ctx, tool, { action: 'list', status: 'rejected' })))
+    expect(listed.proposals).toHaveLength(1)
+    expect(JSON.parse(String(await runTool(ctx, tool, { action: 'list', status: 'candidate' }))).proposals).toHaveLength(0)
+  })
+
+  it('unknown endpoint → readable error naming the tag', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
+    await expect(runTool(ctx, tool, {
+      action: 'submit', source_tag: 'zzzznotatag', target_tag: 'waving', relation: 'related',
+    })).rejects.toThrow(/zzzznotatag/)
+  })
+
+  it('cooccurrence → readable rejection (real statistics source, not LLM)', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
+    await expect(runTool(ctx, tool, {
+      action: 'submit', source_tag: 'wave', target_tag: 'waving', relation: 'cooccurrence',
+    })).rejects.toThrow(/cooccurrence/)
+  })
+
+  it('unknown proposal_id on accept → readable error', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
+    await expect(runTool(ctx, tool, { action: 'accept', proposal_id: 'rel:doesnotexist' })).rejects.toThrow(/rel:doesnotexist/)
+  })
+
+  it('missing action / unknown action → readable errors', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
+    await expect(runTool(ctx, tool, {})).rejects.toThrow(/action/)
+    await expect(runTool(ctx, tool, { action: 'explode' })).rejects.toThrow(/explode/)
+  })
+
+  it('status on empty overlay → zero counts, path reported', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogRelationsTool(ctx as never, cfg as never)
+    const status = JSON.parse(String(await runTool(ctx, tool, { action: 'status' })))
+    expect(status.counts).toEqual({ candidate: 0, accepted: 0, rejected: 0 })
+    expect(String(status.path)).toContain('relation-overlay.sqlite')
+  })
+
+  afterEach(() => closeCatalog())
+})
diff --git a/plugins/prompt-master/tests/plugin/registry.test.ts b/plugins/prompt-master/tests/plugin/registry.test.ts
index d9a4dd8..f5cff5e 100644
--- a/plugins/prompt-master/tests/plugin/registry.test.ts
+++ b/plugins/prompt-master/tests/plugin/registry.test.ts
@@ -22,23 +22,23 @@ function stubCtx() {
         expect(schema).toBeTruthy()
         return { get: () => ({ customProfiles: {} }), update: async () => {}, replace: async () => {} }
       },
     },
     effect(cb: any) { cb() },   // cordis 4 同步 effect（Task 2 已证）
   }
   return { ctx, registered }
 }
 
 describe('plugin registration', () => {
-  it('registers exactly the eight tools with native names', () => {
+  it('registers exactly the nine tools with native names', () => {
     const { ctx, registered } = stubCtx()
     apply(ctx, { temperature: 0.7 })
     const names = registered.map((d) => d.name).sort()
-    expect(names).toEqual(['catalog_search', 'minimax_scenario', 'profile_list', 'prompt_audit', 'prompt_author', 'prompt_compile', 'prompt_expand', 'prompt_reverse'])
+    expect(names).toEqual(['catalog_relations', 'catalog_search', 'minimax_scenario', 'profile_list', 'prompt_audit', 'prompt_author', 'prompt_compile', 'prompt_expand', 'prompt_reverse'])
   })
 
   it('all outputs declare a string schema', () => {
     const { ctx, registered } = stubCtx()
     apply(ctx, { temperature: 0.7 })
     for (const d of registered) expect(d.output.schema).toMatchObject({ type: 'string' })
   })
 })
\ No newline at end of file
```
