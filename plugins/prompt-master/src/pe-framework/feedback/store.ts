/**
 * 质量飞轮 §3.2 存储层：generations + feedback 两表（node:sqlite DatabaseSync）。
 *
 * 连接模式对齐 `anima-knowledge/relations.ts`：每次操作 open/close，目录 mkdir -p，
 * 错误向上抛（Task 8 工具层负责转 envelope），零日志。
 *
 * 隐私边界（spec §3.2）：不落图片、不落 API key；input 只存 sha256 digest。
 * 大小与保留：debate_json ≤64KB（裁 minor findings 保 blocker/major，置 truncated:true），
 * final_output ≤32KB；generations 保留 90 天（写入时懒 prune），feedback 永久（孤儿允许）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface GenerationRow {
  id: string // gen_<ts>_<rand>（T6 已产）
  created_at: number // epoch ms
  target: string // 'anima' | 'h3'
  variant?: string
  judge_mode: string // 'off' | 'fast' | 'strict'
  input_digest: string // sha256 hex，不存原始 input
  final_output: string
  judge_score?: number
  judge_verdict?: string // 'pass' | 'needs_revision'；skipped 不存 verdict
  debate_json?: string
  repair_rounds?: number
}

export interface FeedbackRow {
  generation_id: string
  rating: number // 1-5
  tags?: string[] // 负反馈词表
  notes?: string
  actual_output_path?: string
  created_at: number
}

export const DEBATE_JSON_MAX = 64 * 1024
export const FINAL_OUTPUT_MAX = 32 * 1024
export const GENERATION_RETENTION_DAYS = 90

const SCHEMA = `
CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    target TEXT NOT NULL,
    variant TEXT,
    judge_mode TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    final_output TEXT NOT NULL,
    judge_score REAL,
    judge_verdict TEXT,
    debate_json TEXT,
    repair_rounds INTEGER
);
CREATE INDEX IF NOT EXISTS idx_generations_created ON generations(created_at);
CREATE TABLE IF NOT EXISTS feedback (
    generation_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    tags_json TEXT,
    notes TEXT,
    actual_output_path TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (generation_id, created_at)
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
`

/** 读写模式打开（relations.ts openOverlayDb 同款：mkdir -p + 建 schema，调用方负责 close） */
function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  return db
}

// ---------- 大小裁剪（写入前） ----------

function truncateUtf8(text: string, maxBytes: number): string {
  // 按字节截断，不劈开多字节字符
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  return buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')
}

/** debate_json 超长裁剪：保 blocker/major findings 全文，裁 minor，置 truncated:true。
 *  非 JSON / 仍超长 → 硬截断（不静默超限）。 */
export function trimDebateJson(raw: string, max: number = DEBATE_JSON_MAX): string {
  if (Buffer.byteLength(raw, 'utf8') <= max) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)) {
      const obj = parsed as { findings: Array<{ severity?: string }>; truncated?: boolean }
      const keep = obj.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major')
      const trimmed = JSON.stringify({ ...obj, findings: keep, truncated: true })
      return truncateUtf8(trimmed, max)
    }
  } catch {
    // 非 JSON：fall through 硬截断
  }
  return truncateUtf8(raw, max)
}

// ---------- 写入 ----------

export function recordGeneration(dbPath: string, g: GenerationRow): void {
  pruneGenerations(dbPath)
  const db = openDb(dbPath)
  try {
    db.prepare(
      `INSERT INTO generations
       (id, created_at, target, variant, judge_mode, input_digest, final_output,
        judge_score, judge_verdict, debate_json, repair_rounds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      g.id,
      g.created_at,
      g.target,
      g.variant ?? null,
      g.judge_mode,
      g.input_digest,
      truncateUtf8(g.final_output, FINAL_OUTPUT_MAX),
      g.judge_score ?? null,
      g.judge_verdict ?? null,
      g.debate_json === undefined ? null : trimDebateJson(g.debate_json),
      g.repair_rounds ?? null,
    )
  } finally {
    db.close()
  }
}

export function recordFeedback(
  dbPath: string,
  f: Omit<FeedbackRow, 'created_at'>,
): { ok: true } | { ok: false; code: 'generation_not_found' } {
  pruneGenerations(dbPath)
  const db = openDb(dbPath)
  try {
    const exists = db.prepare('SELECT 1 FROM generations WHERE id = ?').get(f.generation_id)
    if (!exists) return { ok: false, code: 'generation_not_found' }
    db.prepare(
      `INSERT INTO feedback (generation_id, rating, tags_json, notes, actual_output_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      f.generation_id,
      f.rating,
      f.tags === undefined ? null : JSON.stringify(f.tags),
      f.notes ?? null,
      f.actual_output_path ?? null,
      Date.now(),
    )
  } finally {
    db.close()
  }
  return { ok: true }
}

// ---------- 读取 ----------

function rowToGeneration(r: Record<string, unknown>): GenerationRow {
  const g: GenerationRow = {
    id: String(r.id),
    created_at: Number(r.created_at),
    target: String(r.target),
    judge_mode: String(r.judge_mode),
    input_digest: String(r.input_digest),
    final_output: String(r.final_output),
  }
  if (r.variant !== null && r.variant !== undefined) g.variant = String(r.variant)
  if (r.judge_score !== null && r.judge_score !== undefined) g.judge_score = Number(r.judge_score)
  if (r.judge_verdict !== null && r.judge_verdict !== undefined) g.judge_verdict = String(r.judge_verdict)
  if (r.debate_json !== null && r.debate_json !== undefined) g.debate_json = String(r.debate_json)
  if (r.repair_rounds !== null && r.repair_rounds !== undefined) g.repair_rounds = Number(r.repair_rounds)
  return g
}

function rowToFeedback(r: Record<string, unknown>): FeedbackRow {
  const f: FeedbackRow = {
    generation_id: String(r.generation_id),
    rating: Number(r.rating),
    created_at: Number(r.created_at),
  }
  if (r.tags_json !== null && r.tags_json !== undefined) f.tags = JSON.parse(String(r.tags_json)) as string[]
  if (r.notes !== null && r.notes !== undefined) f.notes = String(r.notes)
  if (r.actual_output_path !== null && r.actual_output_path !== undefined) {
    f.actual_output_path = String(r.actual_output_path)
  }
  return f
}

export function getGeneration(dbPath: string, id: string): GenerationRow | undefined {
  const db = openDb(dbPath)
  try {
    const r = db.prepare('SELECT * FROM generations WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? rowToGeneration(r) : undefined
  } finally {
    db.close()
  }
}

export function getFeedback(dbPath: string, generationId: string): FeedbackRow | undefined {
  const db = openDb(dbPath)
  try {
    const r = db
      .prepare('SELECT * FROM feedback WHERE generation_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(generationId) as Record<string, unknown> | undefined
    return r ? rowToFeedback(r) : undefined
  } finally {
    db.close()
  }
}

export function listFeedback(
  dbPath: string,
  q?: { target?: string; min_rating?: number; max_rating?: number; limit?: number },
): Array<FeedbackRow & { target: string }> {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (q?.target !== undefined) {
    clauses.push('g.target = ?')
    params.push(q.target)
  }
  if (q?.min_rating !== undefined) {
    clauses.push('f.rating >= ?')
    params.push(q.min_rating)
  }
  if (q?.max_rating !== undefined) {
    clauses.push('f.rating <= ?')
    params.push(q.max_rating)
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
  const limit = q?.limit ?? 100
  if (limit < 1) return []
  const db = openDb(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT f.generation_id, f.rating, f.tags_json, f.notes, f.actual_output_path, f.created_at, g.target
         FROM feedback f JOIN generations g ON g.id = f.generation_id${where}
         ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({ ...rowToFeedback(r), target: String(r.target) }))
  } finally {
    db.close()
  }
}

export function statsFeedback(
  dbPath: string,
  target?: string,
): { count: number; avgRating: number; histogram: number[]; topTags: Array<{ tag: string; n: number }> } {
  const db = openDb(dbPath)
  try {
    const clause = target !== undefined ? ' JOIN generations g ON g.id = f.generation_id WHERE g.target = ?' : ''
    const params: (string | number)[] = target !== undefined ? [target] : []
    const agg = db
      .prepare(`SELECT COUNT(*) AS count, AVG(f.rating) AS avg FROM feedback f${clause}`)
      .get(...params) as Record<string, unknown>
    const histRows = db
      .prepare(`SELECT f.rating AS rating, COUNT(*) AS n FROM feedback f${clause} GROUP BY f.rating`)
      .all(...params) as Array<Record<string, unknown>>
    const tagRows = db
      .prepare(`SELECT f.tags_json AS tags_json FROM feedback f${clause.replace('WHERE', 'WHERE f.tags_json IS NOT NULL AND')}`)
      .all(...params) as Array<Record<string, unknown>>
    return {
      count: Number(agg.count),
      avgRating: agg.avg === null ? 0 : Math.round(Number(agg.avg) * 10) / 10,
      histogram: histRows.reduce<number[]>((h, r) => {
        const rating = Number(r.rating)
        if (rating >= 1 && rating <= 5) h[rating - 1] = Number(r.n)
        return h
      }, [0, 0, 0, 0, 0]),
      topTags: countTags(tagRows.map((r) => String(r.tags_json))),
    }
  } finally {
    db.close()
  }
}

/** tags_json 值 → 出现次数降序前 5（并列时按 tag 字典序稳定排序） */
function countTags(tagsJson: string[]): Array<{ tag: string; n: number }> {
  const counts = new Map<string, number>()
  for (const raw of tagsJson) {
    try {
      const tags = JSON.parse(raw) as unknown
      if (!Array.isArray(tags)) continue
      for (const t of tags) {
        if (typeof t !== 'string' || !t) continue
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    } catch {
      // 脏行跳过，不让单行毁掉聚合
    }
  }
  return [...counts.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => (b.n - a.n) || a.tag.localeCompare(b.tag))
    .slice(0, 5)
}

// ---------- 保留策略 ----------

/** 删 90 天（默认）前的 generations；feedback 永久保留（孤儿允许，反馈是稀缺数据）。返回删除行数。 */
export function pruneGenerations(dbPath: string, retentionDays: number = GENERATION_RETENTION_DAYS): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const db = openDb(dbPath)
  try {
    const cursor = db.prepare('DELETE FROM generations WHERE created_at < ?').run(cutoff)
    return Number(cursor.changes)
  } finally {
    db.close()
  }
}
