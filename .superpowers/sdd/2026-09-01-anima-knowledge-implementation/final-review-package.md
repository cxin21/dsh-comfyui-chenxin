# Review package - 0fff169..89641cd542ed18a86a8887974e9d9d78d90cf268

## Commits
``````

## Stat
``` .../src/pe-framework/anima-knowledge/browse.ts     |  52 ++++
 .../src/pe-framework/anima-knowledge/relations.ts  | 311 +++++++++++++++++++++
 .../src/pe-framework/anima-knowledge/verify.ts     |  81 ++++++
 .../src/pe-framework/dialect/anima-catalog.ts      | 144 +++++++++-
 .../src/pe-framework/dialect/anima.ts              |  79 +++++-
 .../src/pe-framework/render/envelope.ts            |   4 +-
 plugins/prompt-master/src/plugin/index.ts          |   2 +
 .../prompt-master/src/tools/catalog-relations.ts   | 123 ++++++++
 plugins/prompt-master/src/tools/catalog-search.ts  |  13 +-
 plugins/prompt-master/src/tools/prompt-compile.ts  |  12 +-
 .../anima-knowledge/browse-verify.test.ts          | 154 ++++++++++
 .../pe-framework/anima-knowledge/relations.test.ts | 166 +++++++++++
 .../dialect/anima-catalog-refresh.test.ts          |  82 ++++++
 .../pe-framework/dialect/anima-catalog.test.ts     | 125 +++++++++
 .../tests/pe-framework/pipeline/runStage.test.ts   |   8 +
 .../tests/plugin/catalog-relations.test.ts         | 111 ++++++++
 .../tests/plugin/catalog-search.test.ts            |  17 ++
 .../tests/plugin/compile-anima.test.ts             |  42 +++
 .../prompt-master/tests/plugin/registry.test.ts    |   4 +-
 19 files changed, 1495 insertions(+), 35 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/browse.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/browse.ts
new file mode 100644
index 0000000..0467c5a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/anima-knowledge/browse.ts
@@ -0,0 +1,52 @@
+/**
+ * anima-knowledge/browse.ts — G3 目录浏览/统计（无查询词扫描面）。
+ * 数据通道：anima-catalog 的 queryCatalogInternal（option a）——共享句柄缓存、
+ * mtime 重开与 manifest 对账，本模块不自行打开 DatabaseSync。
+ */
+import { queryCatalogInternal } from '../dialect/anima-catalog.js'
+import type { CatalogHit } from '../dialect/anima-catalog.js'
+
+export interface BrowseOptions {
+  category?: string
+  source?: string
+  limit?: number
+}
+
+const DEFAULT_LIMIT = 20
+
+/** 无查询词扫描：records 按 usage_count 降序，可选 category / source（sources.name）过滤 */
+export function browseCatalog(opts?: BrowseOptions): CatalogHit[] {
+  const limit = opts?.limit === undefined ? DEFAULT_LIMIT : opts.limit
+  if (limit < 1) return []
+  const category = opts?.category?.trim() || null
+  const source = opts?.source?.trim() || null
+  const rows = queryCatalogInternal(
+    `SELECT r.record_id, r.prompt_form, r.usage_count, r.canonical_name AS matched_name
+     FROM records r
+     WHERE (? IS NULL OR r.category = ?)
+       AND (? IS NULL OR EXISTS (
+         SELECT 1 FROM json_each(r.source_ids) je JOIN sources s ON s.source_id = je.value WHERE s.name = ?))
+     ORDER BY r.usage_count DESC, r.record_id
+     LIMIT ?`,
+    [category, category, source, source, limit],
+  ) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
+  return rows.map((r) => ({
+    match_type: 'canonical',
+    prompt_form: r.prompt_form,
+    record_id: r.record_id,
+    usage_count: r.usage_count,
+    raw: r.matched_name,
+  }))
+}
+
+export interface CatalogStats {
+  records: number
+  names: number
+  ftsRows: number
+}
+
+/** 三计数：records / names / catalog_fts 行数（1.37M / 1.39M / =names 量级） */
+export function catalogStats(): CatalogStats {
+  const count = (table: string): number => (queryCatalogInternal(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n
+  return { records: count('records'), names: count('names'), ftsRows: count('catalog_fts') }
+}
diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts
new file mode 100644
index 0000000..5f58430
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts
@@ -0,0 +1,311 @@
+/**
+ * G1 relation 验证链 + overlay 生命周期（Task 6，纯库——tool wrapper 在 Task 7）。
+ *
+ * 源码忠实移植（source of truth）：
+ * - skills/anima-prompt-v1/anima_prompt_v1/relation_submission.py（验证链：端点存在、
+ *   cooccurrence 拒收、canonical signature 归一化/去重、proposal_id sha256）
+ * - skills/anima-prompt-v1/anima_prompt_v1/catalog/relation_overlay.py（overlay schema、
+ *   UPSERT 语义、accepted-no-downgrade 保护）
+ * - cli.py relation.* actions（默认路径 <preset>/temp/anima-prompt-v1/relation-overlay.sqlite）
+ *
+ * node:sqlite DatabaseSync 读写模式；每次操作开/关连接（对齐源码 closing(connection)）。
+ * 零日志。
+ */
+import { DatabaseSync } from 'node:sqlite'
+import { mkdirSync } from 'node:fs'
+import { dirname, join } from 'node:path'
+import { createHash } from 'node:crypto'
+import { resolveKnowledgePath } from '../resources/resolve.js'
+import type { MatchKind } from '../dialect/anima-catalog.js'
+
+export const RELATION_TYPES = ['parent', 'child', 'related'] as const
+export type RelationType = (typeof RELATION_TYPES)[number]
+
+export interface ProposalRow {
+  proposal_id: string
+  from_record_id: string
+  to_record_id: string
+  relation_type: string
+  status: 'candidate' | 'accepted' | 'rejected'
+  confidence: number
+  source: string
+  rationale: string
+  model: string | null
+  evidence: string[]
+  created_at: string
+  updated_at: string
+}
+
+/** relation_overlay.py SCHEMA 逐条移植 */
+const SCHEMA = `
+CREATE TABLE IF NOT EXISTS relation_proposals (
+    proposal_id TEXT PRIMARY KEY,
+    from_record_id TEXT NOT NULL,
+    to_record_id TEXT NOT NULL,
+    relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'child', 'related')),
+    status TEXT NOT NULL CHECK (status IN ('candidate', 'accepted', 'rejected')),
+    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
+    source TEXT NOT NULL,
+    rationale TEXT NOT NULL,
+    model TEXT,
+    evidence TEXT NOT NULL,
+    created_at TEXT NOT NULL,
+    updated_at TEXT NOT NULL,
+    UNIQUE (from_record_id, to_record_id, relation_type)
+);
+CREATE INDEX IF NOT EXISTS idx_relation_overlay_from ON relation_proposals(from_record_id, status, relation_type);
+CREATE INDEX IF NOT EXISTS idx_relation_overlay_to ON relation_proposals(to_record_id, status, relation_type);
+`
+
+// ---------- 路径解析（env ANIMA_OVERLAY_PATH 优先，其次 setOverlayPath 注入，最后 preset temp 默认） ----------
+
+let _overlayPathOverride: string | null = process.env.ANIMA_OVERLAY_PATH ?? null
+
+/** cli.py 语义：默认 <preset>/temp/anima-prompt-v1/relation-overlay.sqlite。
+ *  由 knowledge 目录推导：resolveKnowledgePath → <root>/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite，
+ *  截到 preset 根后拼 temp/。 */
+function defaultOverlayPath(): string {
+  const kp = resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
+  const parts = kp.split(/[\\/]/)
+  const knowledgeIdx = parts.lastIndexOf('knowledge')
+  const root = knowledgeIdx > 0 ? parts.slice(0, knowledgeIdx - 2).join('/') : dirname(dirname(dirname(kp)))
+  return join(root, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite')
+}
+
+export function overlayPath(): string {
+  return _overlayPathOverride ?? defaultOverlayPath()
+}
+
+/** 测试/多环境注入（与 setCatalogPath 同模式；空串 = 清除显式覆盖，回落 env → 默认） */
+export function setOverlayPath(path: string): void {
+  _overlayPathOverride = path || (process.env.ANIMA_OVERLAY_PATH ?? null)
+}
+
+/** 读写模式打开；目录不存在则 mkdir -p（relation_overlay.py _open 语义） */
+export function openOverlayDb(): DatabaseSync {
+  const path = overlayPath()
+  mkdirSync(dirname(path), { recursive: true })
+  const db = new DatabaseSync(path)
+  db.exec(SCHEMA)
+  return db
+}
+
+// ---------- 验证链（relation_submission.py 移植） ----------
+
+/** relation_submission.py _canonical_signature：child → (to, from, 'parent')；
+ *  related → sorted 端点对；parent 原样。用于去重与冲突检测（不用于 proposal_id）。 */
+export function canonicalRelationSignature(fromId: string, toId: string, relationType: string): [string, string, string] {
+  if (relationType === 'child') return [toId, fromId, 'parent']
+  if (relationType === 'related') {
+    const pair = [fromId, toId].sort()
+    return [pair[0], pair[1], 'related']
+  }
+  return [fromId, toId, 'parent']
+}
+
+/** relation_submission.py L93：'rel:' + sha256(f"{from_id}|{to_id}|{relation_type}").hexdigest()[:20]
+ *  注意：源码用原始（strip 后）端点，不是 canonical signature——反向 child/parent 是不同 proposal_id，
+ *  但共享 canonical signature（同一 UNIQUE 三元组槽位由 overlay 的 UPSERT 归并）。 */
+export function proposalSignature(source: string, target: string, relation: string): string {
+  return 'rel:' + createHash('sha256').update(`${source}|${target}|${relation}`).digest('hex').slice(0, 20)
+}
+
+export interface ProposalInput {
+  source_tag: string
+  target_tag: string
+  relation: string
+  /** 源码要求 confidence ∈ [0,1]；brief 简化面省略 → 缺省 0.5（偏差已记录于 task-6-report） */
+  confidence?: number
+  rationale?: string
+  evidence?: string[]
+}
+
+export interface CatalogClassifier {
+  classify(tag: string): MatchKind
+}
+
+/** 端点存在判定：源码 record_exists=has_record；TS 侧以 classify ∈ {canonical, alias} 等价。 */
+function endpointExists(classify: (tag: string) => MatchKind, tag: string): boolean {
+  const kind = classify(tag)
+  return kind === 'canonical' || kind === 'alias'
+}
+
+/** 验证链（RelationValidator.validate 单提案面）：① 端点 canonical/alias ② cooccurrence 拒收
+ *  ③ relation_type 白名单 ④ confidence ⑤ rationale/evidence ⑥ canonical signature 去重
+ *  ⑦ 同端点对 relation 冲突。pending = 同批已受理提案（提交面内部串接用）。 */
+export function validateProposal(
+  input: ProposalInput,
+  catalog: CatalogClassifier & { pending?: ProposalInput[] },
+): { ok: true } | { ok: false; issues: string[] } {
+  const fromId = typeof input.source_tag === 'string' ? input.source_tag.trim() : ''
+  const toId = typeof input.target_tag === 'string' ? input.target_tag.trim() : ''
+  const relation = typeof input.relation === 'string' ? input.relation.trim() : ''
+  if (!fromId || !toId) {
+    return { ok: false, issues: ['relation_endpoint_required:source_tag/target_tag must be non-empty'] }
+  }
+  // ① 端点存在（源码先查端点归属，再查 relation 语义）
+  const issues: string[] = []
+  for (const [label, tag] of [['source', fromId], ['target', toId]] as const) {
+    if (!endpointExists(catalog.classify.bind(catalog), tag)) issues.push(`relation_endpoint_unknown:${label}:${tag}`)
+  }
+  if (issues.length) return { ok: false, issues }
+  // ② cooccurrence 拒收（"requires a real statistics source, not an LLM"）
+  if (relation === 'cooccurrence') {
+    return { ok: false, issues: ['relation_cooccurrence_rejected:cooccurrence requires a real statistics source, not an LLM'] }
+  }
+  // ③ relation_type 白名单
+  if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
+    return { ok: false, issues: [`relation_type_unsupported:${relation}`] }
+  }
+  // ④ confidence
+  const confidence = input.confidence === undefined ? 0.5 : Number(input.confidence)
+  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
+    return { ok: false, issues: [`relation_confidence_invalid:${String(input.confidence)}`] }
+  }
+  // ⑤ rationale / evidence
+  const rationale = (input.rationale ?? 'post-authoring relation proposal').trim()
+  if (!rationale) return { ok: false, issues: ['relation_rationale_required:rationale must be non-empty'] }
+  const evidence = (input.evidence ?? ['llm-submission']).map((e) => e.trim()).filter(Boolean)
+  if (!evidence.length) return { ok: false, issues: ['relation_evidence_invalid:evidence must contain at least one non-empty item'] }
+  // ⑥⑦ 同批去重 / 冲突（canonical signature 语义）
+  const pending = catalog.pending ?? []
+  const signature = canonicalRelationSignature(fromId, toId, relation)
+  const pairKey = [...[fromId, toId].sort()].join('|')
+  for (const prior of pending) {
+    const pFrom = prior.source_tag.trim()
+    const pTo = prior.target_tag.trim()
+    const pRel = prior.relation.trim()
+    if (canonicalRelationSignature(pFrom, pTo, pRel).join('|') === signature.join('|')) {
+      return { ok: false, issues: [`relation_duplicate_proposal:${fromId}|${toId}|${relation}`] }
+    }
+    const priorPair = [pFrom, pTo].sort().join('|')
+    if (priorPair === pairKey && canonicalRelationSignature(pFrom, pTo, pRel)[2] !== signature[2]) {
+      return { ok: false, issues: [`relation_conflicting_relation_types:${pairKey}`] }
+    }
+  }
+  return { ok: true }
+}
+
+// ---------- 提交 + 生命周期（relation_overlay.py 移植） ----------
+
+function strip(input: ProposalInput): { from: string; to: string; relation: string; confidence: number; rationale: string; evidence: string[] } {
+  return {
+    from: input.source_tag.trim(),
+    to: input.target_tag.trim(),
+    relation: input.relation.trim(),
+    confidence: input.confidence === undefined ? 0.5 : Number(input.confidence),
+    rationale: (input.rationale ?? 'post-authoring relation proposal').trim(),
+    evidence: (input.evidence ?? ['llm-submission']).map((e) => e.trim()).filter(Boolean),
+  }
+}
+
+/** 验证 + 持久化：ok → UPSERT candidate；issues → 不落盘（源码：submission.issues 非空直接返回）。
+ *  单提案面每次独立校验，跨调用去重由 overlay 的 UNIQUE + UPSERT 兜底（等价终态）。 */
+export function submitProposal(
+  input: ProposalInput,
+  opts?: { model?: string; classify?: (tag: string) => MatchKind },
+): { proposal_id: string; status: 'candidate' } | { ok: false; issues: string[] } {
+  // 纯库面：classify 必须显式注入（Task 7 wrapper 接线 dialect/anima-catalog 的 classifyTag）
+  const classify: (tag: string) => MatchKind =
+    opts?.classify ??
+    (() => {
+      throw new Error('submitProposal: endpoint classifier required (pass opts.classify in pure-library usage)')
+    })()
+  const v = validateProposal(input, { classify })
+  if (!v.ok) return v
+  const p = strip(input)
+  const proposalId = proposalSignature(p.from, p.to, p.relation)
+  const now = new Date().toISOString()
+  const db = openOverlayDb()
+  try {
+    // relation_overlay.py save() UPSERT：accepted-no-downgrade 保护
+    db.prepare(
+      `INSERT INTO relation_proposals
+       (proposal_id, from_record_id, to_record_id, relation_type, status,
+        confidence, source, rationale, model, evidence, created_at, updated_at)
+       VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)
+       ON CONFLICT(from_record_id, to_record_id, relation_type) DO UPDATE SET
+         proposal_id=excluded.proposal_id,
+         status=CASE WHEN relation_proposals.status='accepted' THEN 'accepted' ELSE excluded.status END,
+         confidence=excluded.confidence, source=excluded.source,
+         rationale=excluded.rationale, model=excluded.model,
+         evidence=excluded.evidence, updated_at=excluded.updated_at`,
+    ).run(
+      proposalId, p.from, p.to, p.relation,
+      p.confidence, 'llm', p.rationale, opts?.model ?? 'current-llm',
+      JSON.stringify(p.evidence), now, now,
+    )
+  } finally {
+    db.close()
+  }
+  return { proposal_id: proposalId, status: 'candidate' }
+}
+
+/** relation.list 语义：status 过滤（默认 all，对齐 CLI --status 默认），confidence DESC, proposal_id 排序 */
+export function listProposals(opts?: {
+  status?: 'candidate' | 'accepted' | 'rejected' | 'all'
+  recordId?: string
+  limit?: number
+}): ProposalRow[] {
+  const status = opts?.status ?? 'all'
+  if (!['candidate', 'accepted', 'rejected', 'all'].includes(status)) {
+    throw new Error(`invalid relation status: ${status}`)
+  }
+  const limit = opts?.limit ?? 100
+  if (limit < 1) return []
+  const clauses: string[] = []
+  const params: (string | number)[] = []
+  if (status !== 'all') {
+    clauses.push('status=?')
+    params.push(status)
+  }
+  if (opts?.recordId !== undefined) {
+    clauses.push('(from_record_id=? OR to_record_id=?)')
+    params.push(opts.recordId, opts.recordId)
+  }
+  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
+  const db = openOverlayDb()
+  try {
+    const rows = db
+      .prepare(
+        `SELECT proposal_id, from_record_id, to_record_id, relation_type, status, confidence,
+                source, rationale, model, evidence, created_at, updated_at
+         FROM relation_proposals${where} ORDER BY confidence DESC, proposal_id LIMIT ?`,
+      )
+      .all(...params, limit) as Array<Record<string, unknown>>
+    return rows.map((r) => ({
+      proposal_id: String(r.proposal_id),
+      from_record_id: String(r.from_record_id),
+      to_record_id: String(r.to_record_id),
+      relation_type: String(r.relation_type),
+      status: String(r.status) as ProposalRow['status'],
+      confidence: Number(r.confidence),
+      source: String(r.source),
+      rationale: String(r.rationale),
+      model: r.model === null || r.model === undefined ? null : String(r.model),
+      evidence: JSON.parse(String(r.evidence)) as string[],
+      created_at: String(r.created_at),
+      updated_at: String(r.updated_at),
+    }))
+  } finally {
+    db.close()
+  }
+}
+
+/** relation.accept / relation.reject（set_status 语义：rowcount≠1 → unknown proposal 错误） */
+export function decideProposal(
+  proposalId: string,
+  decision: 'accept' | 'reject',
+): { proposal_id: string; status: string } {
+  const status = decision === 'accept' ? 'accepted' : 'rejected'
+  const db = openOverlayDb()
+  try {
+    const cursor = db
+      .prepare('UPDATE relation_proposals SET status=?, updated_at=? WHERE proposal_id=?')
+      .run(status, new Date().toISOString(), proposalId)
+    if (cursor.changes !== 1) throw new Error(`unknown relation proposal: ${proposalId}`)
+  } finally {
+    db.close()
+  }
+  return { proposal_id: proposalId, status }
+}
diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/verify.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/verify.ts
new file mode 100644
index 0000000..bdb2966
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/anima-knowledge/verify.ts
@@ -0,0 +1,81 @@
+/**
+ * anima-knowledge/verify.ts — G3 目录健康深检（四项）：
+ * ① checksum（manifest 对账，复用 resources/manifest 的 assertAnimaCatalog）
+ * ② FTS 行数 == names 行数（计数平价）
+ * ③ 4 表存在（records/names/catalog_fts/sources）
+ * ④ schema 对齐（关键列存在性；表缺失时由 ③ 报错，此处只对存在的表做列对齐）
+ * 每项独立 try/catch：单项失败不阻断其余检查（deep-check 契约）。
+ */
+import { queryCatalogInternal, catalogMeta } from '../dialect/anima-catalog.js'
+import { assertAnimaCatalog } from '../resources/manifest.js'
+
+export interface VerifyCheck {
+  name: string
+  ok: boolean
+  detail?: string
+}
+
+export interface VerifyResult {
+  ok: boolean
+  checks: VerifyCheck[]
+}
+
+export const EXPECTED_TABLES = ['records', 'names', 'catalog_fts', 'sources'] as const
+
+/** 与 catalog/storage.py SCHEMA 对齐的关键列（存在性子集检查，非全列强校验） */
+const REQUIRED_COLUMNS: Record<string, string[]> = {
+  records: ['record_id', 'canonical_name', 'prompt_form', 'category', 'usage_count', 'source_ids'],
+  names: ['name_id', 'record_id', 'value', 'normalized_value', 'name_type'],
+  sources: ['source_id', 'name'],
+  catalog_fts: ['name_id', 'record_id', 'value', 'normalized_value'],
+}
+
+function runCheck(name: string, fn: () => string | undefined): VerifyCheck {
+  try {
+    const detail = fn()
+    return detail === undefined ? { name, ok: true } : { name, ok: true, detail }
+  } catch (e) {
+    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) }
+  }
+}
+
+function countOf(table: string): number {
+  return (queryCatalogInternal(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n
+}
+
+export function verifyCatalog(): VerifyResult {
+  const checks: VerifyCheck[] = [
+    runCheck('checksum', () => {
+      const r = assertAnimaCatalog()
+      if (!r.ok) throw new Error(r.reason)
+      return 'manifest sha256 matches file'
+    }),
+    runCheck('ftsParity', () => {
+      const fts = countOf('catalog_fts')
+      const names = countOf('names')
+      if (fts !== names) throw new Error(`fts/names count mismatch (fts=${fts} names=${names})`)
+      return `fts=${fts} == names=${names}`
+    }),
+    runCheck('tables', () => {
+      const present = new Set(catalogMeta().tables)
+      const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
+      if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`)
+      return `${EXPECTED_TABLES.length} tables present`
+    }),
+    runCheck('schema', () => {
+      const present = new Set(catalogMeta().tables)
+      const problems: string[] = []
+      for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
+        if (!present.has(table)) continue // 表缺失已由 tables 检查报告
+        const actual = new Set(
+          (queryCatalogInternal(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
+        )
+        const missingCols = required.filter((c) => !actual.has(c))
+        if (missingCols.length) problems.push(`${table}: missing ${missingCols.join(', ')}`)
+      }
+      if (problems.length) throw new Error(`schema misaligned — ${problems.join('; ')}`)
+      return 'required columns aligned'
+    }),
+  ]
+  return { ok: checks.every((c) => c.ok), checks }
+}
diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index 64e97df..23c977e 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -1,131 +1,241 @@
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
+  /** G7：source 白名单（names.source_id 精确匹配 ∪ records.source_ids 包含匹配）。
+   *  overlay accepted 别名命中同样受 categories/sources 过滤（目标端解析走 records JOIN）。 */
+  sources?: string[]
 }
 
 export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'
 
 const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
 const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })
 
 let _db: DatabaseSync | null = null
 /** 惰性解析（MF-1）：路径在 db() 打开时才解析，保证 setPresetRoot(config.presetRoot) 先于路径求值；
  *  模块求值期不再触碰文件系统（resolveKnowledgePath fallback 失败的 throw 不再发生在 import 时）。 */
 let _dbPathOverride: string | null = process.env.ANIMA_CATALOG_PATH ?? null
 let _manifestChecked = false
+/** G4（Task 1）：句柄缓存 mtime 与 manifest 对账结果（mtime 变化 → close+reopen + 重新对账） */
+let _lastMtimeMs = 0
+let _dbGeneration = 0
+let _manifestChecks = 0
+let _lastManifest: { ok: boolean; reason?: string } | undefined
+
+/** 最近一次 manifest 对账结果；undefined = 本进程尚未对账过 */
+export function lastManifestCheck(): { ok: boolean; reason?: string } | undefined {
+  return _lastManifest
+}
+
+/** 测试专用探针（brief 允许的降级断言方式）：mock statSync+node:sqlite 组合过于脆弱，
+ *  改为直接暴露句柄存在性 / 缓存 mtime / 重开代数 / 对账次数，供 mtime→reopen 断言。 */
+export function _testOnlyState(): { dbOpen: boolean; mtimeMs: number; dbGeneration: number; manifestChecks: number } {
+  return { dbOpen: _db !== null, mtimeMs: _lastMtimeMs, dbGeneration: _dbGeneration, manifestChecks: _manifestChecks }
+}
 
 /** manifest 对账只跑一次；失败 console.warn 但不硬崩（资源层无 ctx.logger，spec §4.2）。
  *  在首次 db() 调用时执行（MF-1：从模块求值期移入惰性路径，先于任何 db 打开）：783MiB catalog 的
- *  sha256 在全量测试并行 IO 下会超过 vitest 单测 5s 超时，once-flag 保证每个进程只对账一次。 */
+ *  sha256 在全量测试并行 IO 下会超过 vitest 单测 5s 超时，once-flag 保证每个进程只对账一次。
+ *  G4：句柄因 mtime 变化被重开时 once-flag 复位 → 对账重跑，结果记入 lastManifestCheck()。 */
 function verifyManifestOnce(): void {
   if (_manifestChecked) return
   _manifestChecked = true
+  _manifestChecks++
   const r = assertAnimaCatalog()
+  _lastManifest = r.ok ? { ok: true } : { ok: false, reason: r.reason }
   if (!r.ok) console.warn(`[prompt-master] ${r.reason}：资产与 golden 基线不同，请 re-run fidelity capture`)
 }
 
 export function catalogPath(): string {
   return _dbPathOverride ?? defaultCatalogPath()
 }
 
 export function setCatalogPath(path: string): void {
   if (_db) { _db.close(); _db = null }
   // 空串 = 清除显式覆盖，回落到 env 优先级（level 0），再回落 defaultCatalogPath()
   _dbPathOverride = path || (process.env.ANIMA_CATALOG_PATH ?? null)
 }
 
 function db(): DatabaseSync {
+  const path = catalogPath()
+  let mtime = 0
+  try { mtime = statSync(path).mtimeMs } catch { /* 打开前缺失由 DatabaseSync 抛出 */ }
+  // G4：catalog 被 skill 重建（mtime 变化）→ 关闭陈旧句柄，重开并重新对账，无需进程重启
+  if (_db && mtime !== _lastMtimeMs) {
+    _db.close()
+    _db = null
+    _manifestChecked = false // 重新对账
+  }
   if (!_db) {
     verifyManifestOnce()
-    _db = new DatabaseSync(catalogPath(), { readOnly: true })
+    _db = new DatabaseSync(path, { readOnly: true })
+    _lastMtimeMs = mtime
+    _dbGeneration++
   }
   return _db
 }
 
 /** facets.normalize 移植：lowercase、underscores→spaces、collapse whitespace、strip */
 export function normalizeTag(value: string): string {
   return value.trim().toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean).join(' ')
 }
 
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
+ *  canonical 保护：本函数只在 catalog 级联零命中时执行，真实 canonical/alias 命中永不降级。
+ *  G7：categories/sources 过滤透传到目标端 exactQuery 解析（overlay 命中走 records JOIN，真实过滤而非豁免）。 */
+function overlayAliasHits(normalized: string, limit: number, categories?: string[], sources?: string[]): CatalogHit[] {
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
+      const resolved = exactQuery(target, 'canonical', limit - hits.length, categories, sources).length
+        ? exactQuery(target, 'canonical', limit - hits.length, categories, sources)
+        : exactQuery(target, 'alias', limit - hits.length, categories, sources)
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
+  const overlay = overlayAliasHits(normalized, limit - cascadeHits.length, opts?.categories, opts?.sources)
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
@@ -158,19 +268,25 @@ export function catalogMeta(): { file: string; sizeBytes: number; tables: string
   let sizeBytes = 0
   const path = catalogPath()
   try {
     sizeBytes = statSync(path).size
   } catch {
     /* path may be a file: URI fallback */
   }
   return { file: path, sizeBytes, tables, fts }
 }
 
+/** G3（Task 2）anima-knowledge browse/stats/verify 的最小内部 SQL 通道（brief option a）：
+ *  复用句柄缓存 + mtime 重开 + manifest 对账，不导出 _db 本体。只读 SELECT 用。 */
+export function queryCatalogInternal(sql: string, params: readonly (string | number | null)[] = []): unknown[] {
+  return db().prepare(sql).all(...params)
+}
+
 /** 便捷 close（测试隔离用） */
 export function closeCatalog(): void {
   if (_db) { _db.close(); _db = null }
 }
 
 /** 预设 knowledge 目录推导（供 config 接线） */
 export function knowledgeDir(): string {
   return dirname(defaultCatalogPath())
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima.ts b/plugins/prompt-master/src/pe-framework/dialect/anima.ts
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
diff --git a/plugins/prompt-master/src/pe-framework/render/envelope.ts b/plugins/prompt-master/src/pe-framework/render/envelope.ts
index 1f790ea..2f3175f 100644
--- a/plugins/prompt-master/src/pe-framework/render/envelope.ts
+++ b/plugins/prompt-master/src/pe-framework/render/envelope.ts
@@ -18,27 +18,29 @@ export interface EnvelopeObservability {
   corrections?: number
   loopExhausted?: boolean
   joyExtraFiltered?: boolean
   sanitizeChanged?: boolean
   continueRounds?: number
   continueWarnings?: string[]
   /** 各管线阶段耗时（ms）；内核 trace 摘要，供 GUI/模型可见性 */
   traceStages?: Array<{ name: string; ms: number }>
 }
 
-export function assembleEnvelope(stage: StageResult, trail?: string[], observability?: EnvelopeObservability): string {
+export function assembleEnvelope(stage: StageResult, trail?: string[], observability?: EnvelopeObservability, dialectTopLevel?: Record<string, unknown>): string {
   const audit = {
     passed: stage.ok,
     gates: stage.gates,
     ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
   }
   const envelope: Record<string, unknown> = {
     ok: stage.ok,
     ...(stage.ok ? { result: stage.result } : {}),
     audit,
     assumptions: stage.assumptions,
     advisories: [...stage.advisories, ...(trail ?? [])],
     target_slot_hint: stage.targetSlotHint,
     ...(observability !== undefined ? { observability } : {}),
+    // G2：方言顶层投影（如 anima phase_status）最后合并——方言键不被基础键覆盖，h3 不传则无变化
+    ...(dialectTopLevel ?? {}),
   }
   return serializeReport(envelope as unknown as AuditReport)
 }
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
diff --git a/plugins/prompt-master/src/tools/catalog-search.ts b/plugins/prompt-master/src/tools/catalog-search.ts
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
diff --git a/plugins/prompt-master/src/tools/prompt-compile.ts b/plugins/prompt-master/src/tools/prompt-compile.ts
index 0052f0f..71a70b6 100644
--- a/plugins/prompt-master/src/tools/prompt-compile.ts
+++ b/plugins/prompt-master/src/tools/prompt-compile.ts
@@ -17,38 +17,44 @@ export interface CompileArgs {
   form_fields?: Record<string, unknown>
   output_lang?: string
   audit_only?: boolean
   slots?: Record<string, unknown>
   variant?: string
 }
 
 /** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文）。
  *  MF-3：result 省略仅限 audit_only——非 audit_only 即使 ok=false（critical 闸门）也保留 result
  *  （对齐旧 compile 行为：ok:true + audit.passed:false 可见编译产物；确定性编译无「修复重试」路径）。 */
-function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean }): string {
-  const env = JSON.parse(assembleEnvelope(stage)) as Record<string, unknown>
+function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean; dialectTopLevel?: Record<string, unknown> }): string {
+  const env = JSON.parse(assembleEnvelope(stage, undefined, undefined, opts?.dialectTopLevel)) as Record<string, unknown>
   if (opts?.omitResult) delete env.result
   else if (env.result === undefined) env.result = stage.result
   return serializeReport(env as never)
 }
 
 const VARIANT_SET = ['base', 'aesthetic', 'turbo']
 
 /** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置）。onStage：成功前打点钩子（日志摘要，不打正文） */
 export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean, onStage?: (stage: StageResult) => void): string {
   if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
   if (variant !== undefined && !VARIANT_SET.includes(variant)) {
     throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
   }
   const stage = runStage({ target: 'anima', slots, variant, auditOnly: auditOnly === true })
   onStage?.(stage)
-  return stageToEnvelope(stage, { omitResult: auditOnly === true })
+  return stageToEnvelope(stage, {
+    omitResult: auditOnly === true,
+    // G2：anima 四阶段状态投影到 Envelope 顶层（SKILL.md 343-356 要求原样上报）；audit_only 时 result 被 omit，顶层投影仍可见
+    dialectTopLevel: typeof stage.result === 'object' && stage.result !== null && 'phase_status' in stage.result
+      ? { phase_status: (stage.result as { phase_status: unknown }).phase_status }
+      : undefined,
+  })
 }
 
 export function registerCompileTool(ctx?: Context) {
   type LogCtx = { logger?: { info?: (msg: string) => void } }
   const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
   return defineTool({
     name: 'prompt_compile',
     description:
       '确定性编译+审计：target=h3（场景/shots → official dialect 文本+审计）或 target=anima（slots → positive/negative+审计；无 budget）。h3 budget counter=estimate（T12 前）。',
     parameters: {
diff --git a/plugins/prompt-master/tests/pe-framework/anima-knowledge/browse-verify.test.ts b/plugins/prompt-master/tests/pe-framework/anima-knowledge/browse-verify.test.ts
new file mode 100644
index 0000000..8dec6ff
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/anima-knowledge/browse-verify.test.ts
@@ -0,0 +1,154 @@
+import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
+import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { createHash } from 'node:crypto'
+import { DatabaseSync } from 'node:sqlite'
+import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
+import { setCatalogPath, closeCatalog, queryCatalogInternal } from '../../../src/pe-framework/dialect/anima-catalog.js'
+import { browseCatalog, catalogStats } from '../../../src/pe-framework/anima-knowledge/browse.js'
+import { verifyCatalog } from '../../../src/pe-framework/anima-knowledge/verify.js'
+
+describe('catalog browse/stats/verify — real catalog (read-only)', () => {
+  it('browseCatalog limit=3 → 3 hits with record_id/prompt_form/usage_count', () => {
+    const hits = browseCatalog({ limit: 3 })
+    expect(hits).toHaveLength(3)
+    for (const h of hits) {
+      expect(h.match_type).toBe('canonical')
+      expect(typeof h.record_id).toBe('string')
+      expect(typeof h.prompt_form).toBe('string')
+      expect(typeof h.usage_count).toBe('number')
+    }
+  })
+
+  it('browseCatalog default limit=20', () => {
+    expect(browseCatalog()).toHaveLength(20)
+  })
+
+  it('browseCatalog category filter → exactly the category rows (cross-checked via SQL)', () => {
+    const top = queryCatalogInternal(
+      'SELECT category, COUNT(*) AS n FROM records GROUP BY category ORDER BY COUNT(*) DESC LIMIT 1',
+    )[0] as { category: string; n: number }
+    expect(top.n).toBeGreaterThan(0)
+    const hits = browseCatalog({ category: top.category, limit: 500 })
+    expect(hits.length).toBe(Math.min(top.n, 500))
+  })
+
+  it('browseCatalog source filter → non-empty hits from that source', () => {
+    const src = queryCatalogInternal(
+      `SELECT s.name FROM sources s JOIN json_each((SELECT source_ids FROM records LIMIT 1)) je ON je.value = s.source_id LIMIT 1`,
+    )[0] as { name: string }
+    expect(src?.name).toBeTruthy()
+    const hits = browseCatalog({ source: src.name, limit: 5 })
+    expect(hits.length).toBeGreaterThan(0)
+    expect(hits.length).toBeLessThanOrEqual(5)
+  })
+
+  it('catalogStats → three counts > 0, records at 1M+ scale, ftsRows === names', () => {
+    const s = catalogStats()
+    expect(s.records).toBeGreaterThan(1_000_000)
+    expect(s.names).toBeGreaterThan(1_000_000)
+    expect(s.ftsRows).toBe(s.names)
+  })
+
+  it('verifyCatalog → ok:true with four passing checks', () => {
+    const r = verifyCatalog()
+    expect(r.checks.map((c) => c.name)).toEqual(['checksum', 'ftsParity', 'tables', 'schema'])
+    expect(r.checks.every((c) => c.ok)).toBe(true)
+    expect(r.ok).toBe(true)
+  })
+})
+
+// ---- tmp 小库失败分支（fixture 模式对齐 tests/pe-framework/resources/manifest.test.ts）----
+
+let tmp: string
+
+function buildFixtureCatalog(dbPath: string, opts: { withFts?: boolean; ftsRows?: number; nameRows?: number }): void {
+  const db = new DatabaseSync(dbPath)
+  db.exec(`
+    CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL);
+    CREATE TABLE records (record_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, prompt_form TEXT NOT NULL, category TEXT NOT NULL, usage_count INTEGER NOT NULL, source_ids TEXT NOT NULL);
+    CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, name_type TEXT NOT NULL);
+  `)
+  db.prepare("INSERT INTO sources VALUES ('src-1', 'danbooru')").run()
+  db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)").run('rec-1', 'smile', 'smile', 'general', 10, '["src-1"]')
+  const insName = db.prepare("INSERT INTO names VALUES (?, 'rec-1', ?, ?, 'canonical')")
+  insName.run('nm-1', 'smile', 'smile')
+  const extra = opts.nameRows ?? 0
+  for (let i = 0; i < extra; i++) insName.run(`nm-x${i}`, `name ${i}`, `name ${i}`)
+  const nameIds = ['nm-1', ...Array.from({ length: extra }, (_, i) => `nm-x${i}`)]
+  if (opts.withFts !== false) {
+    db.exec(`CREATE VIRTUAL TABLE catalog_fts USING fts5(name_id UNINDEXED, record_id UNINDEXED, value, normalized_value)`)
+    const insFts = db.prepare('INSERT INTO catalog_fts (name_id, record_id, value, normalized_value) VALUES (?, ?, ?, ?)')
+    const rows = opts.ftsRows ?? nameIds.length
+    for (let i = 0; i < rows; i++) insFts.run(nameIds[i] ?? `nm-ghost-${i}`, 'rec-1', 'v', 'v')
+  }
+  db.close()
+}
+
+function writeTmpFixture(opts: { withFts?: boolean; ftsRows?: number; nameRows?: number; withManifest?: boolean }): string {
+  const knowledge = join(tmp, 'skills', 'anima-prompt-v1', 'knowledge')
+  mkdirSync(knowledge, { recursive: true })
+  const dbPath = join(knowledge, 'tag-catalog.sqlite')
+  buildFixtureCatalog(dbPath, opts)
+  if (opts.withManifest !== false) {
+    writeFileSync(
+      join(knowledge, 'manifest.json'),
+      JSON.stringify({ content_filters: false, output: { path: 'tag-catalog.sqlite', checksum: createHash('sha256').update(readFileSync(dbPath)).digest('hex') } }),
+    )
+  }
+  return dbPath
+}
+
+describe('catalog verify — tmp fixture failure branches', () => {
+  let warnSpy: ReturnType<typeof vi.spyOn>
+
+  beforeEach(() => {
+    tmp = mkdtempSync(join(tmpdir(), 'pm-browse-verify-'))
+    setPresetRoot(tmp)
+    closeCatalog()
+    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
+  })
+  afterEach(() => {
+    setCatalogPath('')
+    closeCatalog()
+    setPresetRoot(undefined)
+    warnSpy.mockRestore()
+    rmSync(tmp, { recursive: true, force: true })
+  })
+
+  it('missing catalog_fts table → ftsParity + tables checks fail, ok:false', () => {
+    setCatalogPath(writeTmpFixture({ withFts: false }))
+    const r = verifyCatalog()
+    expect(r.ok).toBe(false)
+    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]))
+    expect(byName.tables?.ok).toBe(false)
+    expect(byName.tables?.detail).toContain('catalog_fts')
+    expect(byName.ftsParity?.ok).toBe(false)
+    expect(byName.checksum?.ok).toBe(true)
+  })
+
+  it('FTS row count != names count → ftsParity fails with detail', () => {
+    setCatalogPath(writeTmpFixture({ withFts: true, ftsRows: 1, nameRows: 2 }))
+    const r = verifyCatalog()
+    const parity = r.checks.find((c) => c.name === 'ftsParity')
+    expect(parity?.ok).toBe(false)
+    expect(parity?.detail).toMatch(/fts=1/)
+    expect(r.ok).toBe(false)
+  })
+
+  it('well-formed tmp catalog + matching manifest → all four checks pass', () => {
+    setCatalogPath(writeTmpFixture({ withFts: true }))
+    const r = verifyCatalog()
+    expect(r.checks.every((c) => c.ok)).toBe(true)
+    expect(r.ok).toBe(true)
+  })
+
+  it('browse/stats work against tmp fixture', () => {
+    setCatalogPath(writeTmpFixture({ withFts: true }))
+    expect(browseCatalog({ limit: 1 })).toHaveLength(1)
+    expect(browseCatalog({ source: 'danbooru', limit: 5 })).toHaveLength(1)
+    expect(browseCatalog({ category: 'nonexistent', limit: 5 })).toHaveLength(0)
+    expect(catalogStats()).toEqual({ records: 1, names: 1, ftsRows: 1 })
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts b/plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts
new file mode 100644
index 0000000..a463d9a
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts
@@ -0,0 +1,166 @@
+import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { mkdtempSync, rmSync, existsSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { createHash } from 'node:crypto'
+import {
+  proposalSignature,
+  canonicalRelationSignature,
+  validateProposal,
+  submitProposal,
+  listProposals,
+  decideProposal,
+  setOverlayPath,
+} from '../../../src/pe-framework/anima-knowledge/relations.js'
+import type { MatchKind } from '../../../src/pe-framework/dialect/anima-catalog.js'
+
+let tmp: string
+
+/** classify stub：只有显式给出的 tag 视为 canonical，其余 miss */
+function classifyOf(known: string[]) {
+  return (tag: string): MatchKind => (known.includes(tag) ? 'canonical' : 'miss')
+}
+
+beforeEach(() => {
+  tmp = mkdtempSync(join(tmpdir(), 'pm-overlay-'))
+  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
+})
+afterEach(() => {
+  setOverlayPath('')
+  rmSync(tmp, { recursive: true, force: true })
+})
+
+describe('relation validation chain', () => {
+  it('proposal_id deterministic (same input → same sha256 signature)', () => {
+    const s1 = proposalSignature('a', 'b', 'parent')
+    const s2 = proposalSignature('a', 'b', 'parent')
+    expect(s1).toBe(s2)
+    // 源码语义：'rel:' + sha256(f"{from_id}|{to_id}|{relation_type}").hexdigest()[:20]（原始端点，strip 后）
+    expect(s1).toBe('rel:' + createHash('sha256').update('a|b|parent').digest('hex').slice(0, 20))
+  })
+
+  it('signature normalization: child a→b == parent b→a；child a→b ≠ child b→a；parent 反向是不同提案', () => {
+    // _canonical_signature：child → (to, from, 'parent')；related → sorted pair；parent 原样
+    expect(canonicalRelationSignature('a', 'b', 'child')).toEqual(canonicalRelationSignature('b', 'a', 'parent'))
+    expect(canonicalRelationSignature('a', 'b', 'child')).not.toEqual(canonicalRelationSignature('b', 'a', 'child'))
+    expect(canonicalRelationSignature('a', 'b', 'related')).toEqual(canonicalRelationSignature('b', 'a', 'related'))
+    expect(canonicalRelationSignature('a', 'b', 'parent')).not.toEqual(canonicalRelationSignature('b', 'a', 'parent'))
+    // proposal_id 用原始端点（relation_submission.py L93）：反向 pair 是不同 proposal_id
+    expect(proposalSignature('a', 'b', 'parent')).not.toBe(proposalSignature('b', 'a', 'parent'))
+  })
+
+  it('endpoint missing → issues contains endpoint marker', () => {
+    const r = validateProposal({ source_tag: 'hair', target_tag: 'unknown_tag', relation: 'parent' }, { classify: classifyOf(['hair']) })
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.issues.some((i) => i.includes('unknown_tag'))).toBe(true)
+  })
+
+  it('cooccurrence rejected (requires real statistics source, not LLM)', () => {
+    const r = validateProposal({ source_tag: 'a', target_tag: 'b', relation: 'cooccurrence' }, { classify: classifyOf(['a', 'b']) })
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.issues.some((i) => i.includes('cooccurrence'))).toBe(true)
+  })
+
+  it('unsupported relation type → issue', () => {
+    const r = validateProposal({ source_tag: 'a', target_tag: 'b', relation: 'sibling' }, { classify: classifyOf(['a', 'b']) })
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.issues.some((i) => i.includes('relation_type'))).toBe(true)
+  })
+
+  it('same submission: duplicate canonical signature and conflicting relation types flagged', () => {
+    // child a→b 与 parent b→a 归一化后同签名 → duplicate
+    const dup = validateProposal(
+      { source_tag: 'a', target_tag: 'b', relation: 'child' },
+      { classify: classifyOf(['a', 'b']), pending: [{ source_tag: 'b', target_tag: 'a', relation: 'parent' }] },
+    )
+    expect(dup.ok).toBe(false)
+    // 同端点不同 relation（归一化后）→ conflicting
+    const conflict = validateProposal(
+      { source_tag: 'a', target_tag: 'b', relation: 'related' },
+      { classify: classifyOf(['a', 'b']), pending: [{ source_tag: 'a', target_tag: 'b', relation: 'parent' }] },
+    )
+    expect(conflict.ok).toBe(false)
+  })
+
+  it('valid proposal → ok:true', () => {
+    const r = validateProposal(
+      { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child' },
+      { classify: classifyOf(['blue_hair', 'hair']) },
+    )
+    expect(r).toEqual({ ok: true })
+  })
+})
+
+describe('overlay lifecycle (tmp db)', () => {
+  const known = ['blue_hair', 'hair', 'long_hair']
+  const classify = classifyOf(known)
+
+  it('submit → candidate; list shows it; accept → accepted; list filter by status', () => {
+    const r = submitProposal(
+      { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child', rationale: 'blue hair is a kind of hair', evidence: ['taxonomy'] },
+      { classify },
+    )
+    if (!('proposal_id' in r)) throw new Error(`submit failed: ${JSON.stringify(r)}`)
+    expect(r.status).toBe('candidate')
+    // 目录不存在 → mkdir -p（db 已落盘）
+    expect(existsSync(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))).toBe(true)
+
+    const candidates = listProposals({ status: 'candidate' })
+    expect(candidates).toHaveLength(1)
+    expect(candidates[0].from_record_id).toBe('blue_hair')
+    expect(candidates[0].to_record_id).toBe('hair')
+    expect(candidates[0].relation_type).toBe('child')
+
+    const acc = decideProposal(r.proposal_id, 'accept')
+    expect(acc).toEqual({ proposal_id: r.proposal_id, status: 'accepted' })
+    expect(listProposals({ status: 'candidate' })).toHaveLength(0)
+    expect(listProposals({ status: 'accepted' })).toHaveLength(1)
+    expect(listProposals({ status: 'all' })).toHaveLength(1)
+  })
+
+  it('reject → rejected', () => {
+    const r = submitProposal(
+      { source_tag: 'long_hair', target_tag: 'hair', relation: 'child', rationale: 'taxonomy', evidence: ['e1'] },
+      { classify },
+    )
+    if (!('proposal_id' in r)) throw new Error('submit failed')
+    expect(decideProposal(r.proposal_id, 'reject')).toEqual({ proposal_id: r.proposal_id, status: 'rejected' })
+    expect(listProposals({ status: 'rejected' })).toHaveLength(1)
+  })
+
+  it('unknown proposal_id on decide → throws', () => {
+    expect(() => decideProposal('rel:nonexistent00000000', 'accept')).toThrow(/unknown relation proposal/)
+  })
+
+  it('duplicate signature → same proposal_id (idempotent upsert)', () => {
+    const input = { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child', rationale: 'taxonomy', evidence: ['e1'] }
+    const r1 = submitProposal(input, { classify })
+    const r2 = submitProposal(input, { classify })
+    if (!('proposal_id' in r1) || !('proposal_id' in r2)) throw new Error('submit failed')
+    expect(r2.proposal_id).toBe(r1.proposal_id)
+    expect(listProposals({ status: 'all' })).toHaveLength(1)
+  })
+
+  it('accepted-no-downgrade: resubmit after accept keeps accepted status', () => {
+    const input = { source_tag: 'blue_hair', target_tag: 'hair', relation: 'child', rationale: 'taxonomy', evidence: ['e1'] }
+    const r1 = submitProposal(input, { classify })
+    if (!('proposal_id' in r1)) throw new Error('submit failed')
+    decideProposal(r1.proposal_id, 'accept')
+    const r2 = submitProposal(input, { classify })
+    if (!('proposal_id' in r2)) throw new Error('submit failed')
+    // UPSERT：status=CASE WHEN accepted THEN accepted ELSE excluded.status END；proposal_id 相同
+    expect(r2.proposal_id).toBe(r1.proposal_id)
+    const rows = listProposals({ status: 'all' })
+    expect(rows).toHaveLength(1)
+    expect(rows[0].status).toBe('accepted')
+  })
+
+  it('submit with endpoint missing → ok:false, nothing persisted', () => {
+    const r = submitProposal(
+      { source_tag: 'blue_hair', target_tag: 'ghost_tag', relation: 'child' },
+      { classify },
+    )
+    expect(r).toEqual({ ok: false, issues: [expect.stringContaining('ghost_tag')] })
+    expect(listProposals({ status: 'all' })).toHaveLength(0)
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts
new file mode 100644
index 0000000..d65a78c
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts
@@ -0,0 +1,82 @@
+import { describe, expect, it, afterEach } from 'vitest'
+import { mkdtempSync, writeFileSync, utimesSync, rmSync, statSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { DatabaseSync } from 'node:sqlite'
+import { setCatalogPath, closeCatalog, classifyTag, lastManifestCheck, _testOnlyState } from '../../../src/pe-framework/dialect/anima-catalog.js'
+
+/**
+ * G4 catalog handle refresh（Task 1）：
+ * - lastManifestCheck() 形状：undefined = 未对账过；{ok} = 对账结果可查询。
+ * - mtime 变化 → 关闭旧句柄 + 重新打开 + manifest 重新对账。
+ *
+ * mtime→reopen 的断言方式：mock statSync + node:sqlite 组合过于脆弱（vi.mock('node:fs')
+ * 会波及 fixture 构建本身），按 brief 允许的降级方案改用内部探针 `_testOnlyState()`
+ * （返回 {dbOpen, mtimeMs, dbGeneration, manifestChecks}）做确定性断言：
+ * dbGeneration 递增 = 句柄重开；manifestChecks 递增 = 重新对账。
+ */
+
+let tmpDir: string | null = null
+
+/** 最小可查询 catalog fixture：names/records/catalog_fts 缺失没关系，classifyTag 走到 db() 打开即可 */
+function makeTinyCatalog(): string {
+  tmpDir = mkdtempSync(join(tmpdir(), 'anima-catalog-refresh-'))
+  const dbPath = join(tmpDir, 'tag-catalog.sqlite')
+  const w = new DatabaseSync(dbPath)
+  w.exec('CREATE TABLE records (record_id TEXT PRIMARY KEY, prompt_form TEXT, usage_count INTEGER)')
+  w.exec("CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT, value TEXT, normalized_value TEXT, name_type TEXT)")
+  w.prepare('INSERT INTO records VALUES (?,?,?)').run('r1', '1girl', 100)
+  w.prepare('INSERT INTO names VALUES (?,?,?,?,?)').run('n1', 'r1', '1girl', '1girl', 'canonical')
+  w.close()
+  return dbPath
+}
+
+describe('G4 catalog refresh (mtime → close+reopen + manifest re-check)', () => {
+  afterEach(() => {
+    closeCatalog()
+    setCatalogPath('') // 回落默认（真实库），不污染其他测试文件的同进程状态
+    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null }
+  })
+
+  it('mtime change → reopens handle and re-checks manifest (probe assertion)', () => {
+    const dbPath = makeTinyCatalog()
+    setCatalogPath(dbPath)
+
+    expect(lastManifestCheck()).toBeUndefined() // 未对账过
+
+    classifyTag('1girl') // 首开 + 对账
+    const s1 = _testOnlyState()
+    expect(s1.dbOpen).toBe(true)
+    expect(s1.dbGeneration).toBe(1)
+    expect(s1.manifestChecks).toBe(1)
+    expect(s1.mtimeMs).toBeCloseTo(statSync(dbPath).mtimeMs, 0)
+    expect(lastManifestCheck()).toBeDefined()
+
+    // 模拟 catalog 重建：同一路径 mtime 变化
+    const future = new Date(Date.now() + 60_000)
+    utimesSync(dbPath, future, future)
+
+    classifyTag('1girl') // 应触发 close + reopen + 重新对账
+    const s2 = _testOnlyState()
+    expect(s2.dbOpen).toBe(true)
+    expect(s2.dbGeneration).toBe(2) // 句柄被重开
+    expect(s2.manifestChecks).toBe(2) // manifest 重新对账
+    expect(s2.mtimeMs).toBeCloseTo(future.getTime(), 0) // 缓存 mtime 已更新
+    expect(lastManifestCheck()).toBeDefined()
+
+    // mtime 未再变 → 不重开（幂等复用）
+    classifyTag('1girl')
+    const s3 = _testOnlyState()
+    expect(s3.dbGeneration).toBe(2)
+    expect(s3.manifestChecks).toBe(2)
+  })
+
+  it('lastManifestCheck shape on real catalog', () => {
+    setCatalogPath('') // 回落默认（真实库）
+    classifyTag('1girl') // 触发首开 + 对账
+    const s = lastManifestCheck()
+    expect(s).toBeDefined()
+    expect(typeof s!.ok).toBe('boolean')
+    if (!s!.ok) expect(typeof s!.reason).toBe('string')
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
new file mode 100644
index 0000000..fdb30fe
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog.test.ts
@@ -0,0 +1,125 @@
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
+})
+
+afterAll(() => closeCatalog())
diff --git a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
index 70f219c..156530d 100644
--- a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
@@ -65,19 +65,27 @@ describe('assembleEnvelope', () => {
     expect(s.result).toEqual({ x: 1 })
     expect(s.audit.passed).toBe(true)
     // Task 4 定案：audit 收敛为 {passed, gates, budget?}——assumptions/advisories 不再入 audit 对象
     expect(Object.keys(s.audit).sort()).toEqual(['gates', 'passed'])
     // MF-2：内核计算的 assumptions 必须到达 Envelope（顶层，与 advisories 并列）
     expect(s.assumptions).toEqual(['assumed:1'])
     expect(s.target_slot_hint).toBe('t2i.prompt')
     expect(s.advisories).toEqual(['a', 'trail'])
   })
 
+  it('dialectTopLevel keys merge into envelope top level', () => {
+    const s = JSON.parse(assembleEnvelope(
+      { ok: true, result: { x: 1 }, gates: [], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
+      [], undefined, { phase_status: { policy: 'PASS' } },
+    ))
+    expect(s.phase_status).toEqual({ policy: 'PASS' })
+  })
+
   it('omits result when ok=false (audit_only semantics)', () => {
     const s = JSON.parse(assembleEnvelope(
       { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
     ))
     expect(s.ok).toBe(false)
     expect(s.result).toBeUndefined()
     expect(s.audit.passed).toBe(false)
   })
 })
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
diff --git a/plugins/prompt-master/tests/plugin/compile-anima.test.ts b/plugins/prompt-master/tests/plugin/compile-anima.test.ts
index 5262c50..0e7fa2d 100644
--- a/plugins/prompt-master/tests/plugin/compile-anima.test.ts
+++ b/plugins/prompt-master/tests/plugin/compile-anima.test.ts
@@ -72,12 +72,54 @@ describe('prompt_compile (target=anima)', () => {
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
+  it('G2: phase_status projected at envelope top level', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
+      target: 'anima', slots: { count_gender: ['1girl'] },
+    })))
+    expect(raw.phase_status).toEqual({ policy: 'PASS', grounding: 'PASS', composition: 'PASS', inspection: 'PASS' })
+  })
+
+  it('G2: h3 envelope has no top-level phase_status', async () => {
+    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
+      target: 'h3', shots: { duration_seconds: 5, shots: [{ what: '女孩走进便利店', dialogue: ['你好'] }] },
+    })))
+    expect('phase_status' in raw).toBe(false)
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
