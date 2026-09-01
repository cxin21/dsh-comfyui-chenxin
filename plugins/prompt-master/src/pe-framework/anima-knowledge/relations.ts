/**
 * G1 relation 验证链 + overlay 生命周期（Task 6，纯库——tool wrapper 在 Task 7）。
 *
 * 源码忠实移植（source of truth）：
 * - skills/anima-prompt-v1/anima_prompt_v1/relation_submission.py（验证链：端点存在、
 *   cooccurrence 拒收、canonical signature 归一化/去重、proposal_id sha256）
 * - skills/anima-prompt-v1/anima_prompt_v1/catalog/relation_overlay.py（overlay schema、
 *   UPSERT 语义、accepted-no-downgrade 保护）
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
import type { MatchKind } from '../dialect/anima-catalog.js'

export const RELATION_TYPES = ['parent', 'child', 'related'] as const
export type RelationType = (typeof RELATION_TYPES)[number]

export interface ProposalRow {
  proposal_id: string
  from_record_id: string
  to_record_id: string
  relation_type: string
  status: 'candidate' | 'accepted' | 'rejected'
  confidence: number
  source: string
  rationale: string
  model: string | null
  evidence: string[]
  created_at: string
  updated_at: string
}

/** relation_overlay.py SCHEMA 逐条移植 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS relation_proposals (
    proposal_id TEXT PRIMARY KEY,
    from_record_id TEXT NOT NULL,
    to_record_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'child', 'related')),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'accepted', 'rejected')),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source TEXT NOT NULL,
    rationale TEXT NOT NULL,
    model TEXT,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (from_record_id, to_record_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_relation_overlay_from ON relation_proposals(from_record_id, status, relation_type);
CREATE INDEX IF NOT EXISTS idx_relation_overlay_to ON relation_proposals(to_record_id, status, relation_type);
`

// ---------- 路径解析（env ANIMA_OVERLAY_PATH 优先，其次 setOverlayPath 注入，最后 preset temp 默认） ----------

let _overlayPathOverride: string | null = process.env.ANIMA_OVERLAY_PATH ?? null

/** cli.py 语义：默认 <preset>/temp/anima-prompt-v1/relation-overlay.sqlite。
 *  由 knowledge 目录推导：resolveKnowledgePath → <root>/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite，
 *  截到 preset 根后拼 temp/。 */
function defaultOverlayPath(): string {
  const kp = resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
  const parts = kp.split(/[\\/]/)
  const knowledgeIdx = parts.lastIndexOf('knowledge')
  const root = knowledgeIdx > 0 ? parts.slice(0, knowledgeIdx - 2).join('/') : dirname(dirname(dirname(kp)))
  return join(root, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite')
}

export function overlayPath(): string {
  return _overlayPathOverride ?? defaultOverlayPath()
}

/** 测试/多环境注入（与 setCatalogPath 同模式；空串 = 清除显式覆盖，回落 env → 默认） */
export function setOverlayPath(path: string): void {
  _overlayPathOverride = path || (process.env.ANIMA_OVERLAY_PATH ?? null)
}

/** 读写模式打开；目录不存在则 mkdir -p（relation_overlay.py _open 语义） */
export function openOverlayDb(): DatabaseSync {
  const path = overlayPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return db
}

// ---------- 验证链（relation_submission.py 移植） ----------

/** relation_submission.py _canonical_signature：child → (to, from, 'parent')；
 *  related → sorted 端点对；parent 原样。用于去重与冲突检测（不用于 proposal_id）。 */
export function canonicalRelationSignature(fromId: string, toId: string, relationType: string): [string, string, string] {
  if (relationType === 'child') return [toId, fromId, 'parent']
  if (relationType === 'related') {
    const pair = [fromId, toId].sort()
    return [pair[0], pair[1], 'related']
  }
  return [fromId, toId, 'parent']
}

/** relation_submission.py L93：'rel:' + sha256(f"{from_id}|{to_id}|{relation_type}").hexdigest()[:20]
 *  注意：源码用原始（strip 后）端点，不是 canonical signature——反向 child/parent 是不同 proposal_id，
 *  但共享 canonical signature（同一 UNIQUE 三元组槽位由 overlay 的 UPSERT 归并）。 */
export function proposalSignature(source: string, target: string, relation: string): string {
  return 'rel:' + createHash('sha256').update(`${source}|${target}|${relation}`).digest('hex').slice(0, 20)
}

export interface ProposalInput {
  source_tag: string
  target_tag: string
  relation: string
  /** 源码要求 confidence ∈ [0,1]；brief 简化面省略 → 缺省 0.5（偏差已记录于 task-6-report） */
  confidence?: number
  rationale?: string
  evidence?: string[]
}

export interface CatalogClassifier {
  classify(tag: string): MatchKind
}

/** 端点存在判定：源码 record_exists=has_record；TS 侧以 classify ∈ {canonical, alias} 等价。 */
function endpointExists(classify: (tag: string) => MatchKind, tag: string): boolean {
  const kind = classify(tag)
  return kind === 'canonical' || kind === 'alias'
}

/** 验证链（RelationValidator.validate 单提案面）：① 端点 canonical/alias ② cooccurrence 拒收
 *  ③ relation_type 白名单 ④ confidence ⑤ rationale/evidence ⑥ canonical signature 去重
 *  ⑦ 同端点对 relation 冲突。pending = 同批已受理提案（提交面内部串接用）。 */
export function validateProposal(
  input: ProposalInput,
  catalog: CatalogClassifier & { pending?: ProposalInput[] },
): { ok: true } | { ok: false; issues: string[] } {
  const fromId = typeof input.source_tag === 'string' ? input.source_tag.trim() : ''
  const toId = typeof input.target_tag === 'string' ? input.target_tag.trim() : ''
  const relation = typeof input.relation === 'string' ? input.relation.trim() : ''
  if (!fromId || !toId) {
    return { ok: false, issues: ['relation_endpoint_required:source_tag/target_tag must be non-empty'] }
  }
  // ① 端点存在（源码先查端点归属，再查 relation 语义）
  const issues: string[] = []
  for (const [label, tag] of [['source', fromId], ['target', toId]] as const) {
    if (!endpointExists(catalog.classify.bind(catalog), tag)) issues.push(`relation_endpoint_unknown:${label}:${tag}`)
  }
  if (issues.length) return { ok: false, issues }
  // ② cooccurrence 拒收（"requires a real statistics source, not an LLM"）
  if (relation === 'cooccurrence') {
    return { ok: false, issues: ['relation_cooccurrence_rejected:cooccurrence requires a real statistics source, not an LLM'] }
  }
  // ③ relation_type 白名单
  if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
    return { ok: false, issues: [`relation_type_unsupported:${relation}`] }
  }
  // ④ confidence
  const confidence = input.confidence === undefined ? 0.5 : Number(input.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, issues: [`relation_confidence_invalid:${String(input.confidence)}`] }
  }
  // ⑤ rationale / evidence
  const rationale = (input.rationale ?? 'post-authoring relation proposal').trim()
  if (!rationale) return { ok: false, issues: ['relation_rationale_required:rationale must be non-empty'] }
  const evidence = (input.evidence ?? ['llm-submission']).map((e) => e.trim()).filter(Boolean)
  if (!evidence.length) return { ok: false, issues: ['relation_evidence_invalid:evidence must contain at least one non-empty item'] }
  // ⑥⑦ 同批去重 / 冲突（canonical signature 语义）
  const pending = catalog.pending ?? []
  const signature = canonicalRelationSignature(fromId, toId, relation)
  const pairKey = [...[fromId, toId].sort()].join('|')
  for (const prior of pending) {
    const pFrom = prior.source_tag.trim()
    const pTo = prior.target_tag.trim()
    const pRel = prior.relation.trim()
    if (canonicalRelationSignature(pFrom, pTo, pRel).join('|') === signature.join('|')) {
      return { ok: false, issues: [`relation_duplicate_proposal:${fromId}|${toId}|${relation}`] }
    }
    const priorPair = [pFrom, pTo].sort().join('|')
    if (priorPair === pairKey && canonicalRelationSignature(pFrom, pTo, pRel)[2] !== signature[2]) {
      return { ok: false, issues: [`relation_conflicting_relation_types:${pairKey}`] }
    }
  }
  return { ok: true }
}

// ---------- 提交 + 生命周期（relation_overlay.py 移植） ----------

function strip(input: ProposalInput): { from: string; to: string; relation: string; confidence: number; rationale: string; evidence: string[] } {
  return {
    from: input.source_tag.trim(),
    to: input.target_tag.trim(),
    relation: input.relation.trim(),
    confidence: input.confidence === undefined ? 0.5 : Number(input.confidence),
    rationale: (input.rationale ?? 'post-authoring relation proposal').trim(),
    evidence: (input.evidence ?? ['llm-submission']).map((e) => e.trim()).filter(Boolean),
  }
}

/** 验证 + 持久化：ok → UPSERT candidate；issues → 不落盘（源码：submission.issues 非空直接返回）。
 *  单提案面每次独立校验，跨调用去重由 overlay 的 UNIQUE + UPSERT 兜底（等价终态）。 */
export function submitProposal(
  input: ProposalInput,
  opts?: { model?: string; classify?: (tag: string) => MatchKind },
): { proposal_id: string; status: 'candidate' } | { ok: false; issues: string[] } {
  // 纯库面：classify 必须显式注入（Task 7 wrapper 接线 dialect/anima-catalog 的 classifyTag）
  const classify: (tag: string) => MatchKind =
    opts?.classify ??
    (() => {
      throw new Error('submitProposal: endpoint classifier required (pass opts.classify in pure-library usage)')
    })()
  const v = validateProposal(input, { classify })
  if (!v.ok) return v
  const p = strip(input)
  const proposalId = proposalSignature(p.from, p.to, p.relation)
  const now = new Date().toISOString()
  const db = openOverlayDb()
  try {
    // relation_overlay.py save() UPSERT：accepted-no-downgrade 保护
    db.prepare(
      `INSERT INTO relation_proposals
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
      proposalId, p.from, p.to, p.relation,
      p.confidence, 'llm', p.rationale, opts?.model ?? 'current-llm',
      JSON.stringify(p.evidence), now, now,
    )
  } finally {
    db.close()
  }
  return { proposal_id: proposalId, status: 'candidate' }
}

/** relation.list 语义：status 过滤（默认 all，对齐 CLI --status 默认），confidence DESC, proposal_id 排序 */
export function listProposals(opts?: {
  status?: 'candidate' | 'accepted' | 'rejected' | 'all'
  recordId?: string
  limit?: number
}): ProposalRow[] {
  const status = opts?.status ?? 'all'
  if (!['candidate', 'accepted', 'rejected', 'all'].includes(status)) {
    throw new Error(`invalid relation status: ${status}`)
  }
  const limit = opts?.limit ?? 100
  if (limit < 1) return []
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (status !== 'all') {
    clauses.push('status=?')
    params.push(status)
  }
  if (opts?.recordId !== undefined) {
    clauses.push('(from_record_id=? OR to_record_id=?)')
    params.push(opts.recordId, opts.recordId)
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
  const db = openOverlayDb()
  try {
    const rows = db
      .prepare(
        `SELECT proposal_id, from_record_id, to_record_id, relation_type, status, confidence,
                source, rationale, model, evidence, created_at, updated_at
         FROM relation_proposals${where} ORDER BY confidence DESC, proposal_id LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      proposal_id: String(r.proposal_id),
      from_record_id: String(r.from_record_id),
      to_record_id: String(r.to_record_id),
      relation_type: String(r.relation_type),
      status: String(r.status) as ProposalRow['status'],
      confidence: Number(r.confidence),
      source: String(r.source),
      rationale: String(r.rationale),
      model: r.model === null || r.model === undefined ? null : String(r.model),
      evidence: JSON.parse(String(r.evidence)) as string[],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    }))
  } finally {
    db.close()
  }
}

/** relation.accept / relation.reject（set_status 语义：rowcount≠1 → unknown proposal 错误） */
export function decideProposal(
  proposalId: string,
  decision: 'accept' | 'reject',
): { proposal_id: string; status: string } {
  const status = decision === 'accept' ? 'accepted' : 'rejected'
  const db = openOverlayDb()
  try {
    const cursor = db
      .prepare('UPDATE relation_proposals SET status=?, updated_at=? WHERE proposal_id=?')
      .run(status, new Date().toISOString(), proposalId)
    if (cursor.changes !== 1) throw new Error(`unknown relation proposal: ${proposalId}`)
  } finally {
    db.close()
  }
  return { proposal_id: proposalId, status }
}
