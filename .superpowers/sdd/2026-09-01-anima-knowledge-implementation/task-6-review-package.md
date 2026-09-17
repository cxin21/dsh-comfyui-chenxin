# Review package - 72a6916..96bb73a

## Commits
``````

## Stat
``` .../src/pe-framework/anima-knowledge/relations.ts  | 311 +++++++++++++++++++++
 .../pe-framework/anima-knowledge/relations.test.ts | 166 +++++++++++
 2 files changed, 477 insertions(+)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts
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
```
