/**
 * prompt_feedback 工具（spec §3.3，质量飞轮 §2 人工反馈通道）。
 *
 * 把 Task 7 store（src/pe-framework/feedback/store.ts）暴露为 agent 工具：
 * - record：UPSERT 语义（控制器裁定：同 generation_id 新评覆盖旧评——先删旧行再插，
 *   补评历史不保留）。懒 prune 先于 FK 校验：过期 generation（>90 天）补反馈会返回
 *   generation_not_found。
 * - list：LEFT JOIN 变体——孤儿 feedback（generation 已 prune）仍可见，标 orphaned:true；
 *   非 orphan 行附 judge_score（「评委分 vs 人工分」联查通道，校准数据源）。
 * - get / stats：透传 store。
 * - store 抛出的 DB 异常 → envelope internal_error（不静默）。
 *
 * 纯函数 feedbackEnvelope(content, dbPath) 返回 Envelope JSON 字符串（校验错误直接
 * 返回 ok:false envelope；DB 异常向上抛，由 execute 捕获转 internal_error）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve as pathResolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  getGeneration,
  getFeedback,
  recordFeedback,
  statsFeedback,
  pruneGenerations,
} from '../pe-framework/feedback/store.js'
import { getPresetRoot } from '../pe-framework/resources/resolve.js'
import type { Config } from '../plugin/config.js'

type LogCtx = { logger?: { info?: (msg: string) => void } }
const logInfo = (ctx: Context | null, msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)

export interface FeedbackContent {
  action: 'record' | 'list' | 'get' | 'stats'
  // record
  generation_id?: string
  rating?: number
  tags?: string[]
  notes?: string
  actual_output_path?: string
  // list
  target?: string
  min_rating?: number
  max_rating?: number
  limit?: number
}

// ---------- dbPath 解析（测试注入 + 生产默认 <presetRoot>/temp/runtime/feedback.sqlite） ----------

let _dbPathOverride: string | null = null

/** 测试/特殊部署注入 db 路径；传 null 恢复默认解析 */
export function setFeedbackDbPath(p: string | null): void {
  _dbPathOverride = p
}

function fallbackPresetRoot(): string | undefined {
  try {
    const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
    const parts = here.split(/[\\/]/)
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') {
        return parts.slice(0, i).join(sep)
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function defaultFeedbackDbPath(): string {
  const root = getPresetRoot()?.replace(/[\\/]+$/, '')
    ?? process.env.DSH_COMFYUI_PRESET_ROOT?.replace(/[\\/]+$/, '')
    ?? fallbackPresetRoot()
  if (!root) throw new Error('prompt_feedback: presetRoot not configured; cannot resolve feedback db path')
  return join(root, 'temp', 'runtime', 'feedback.sqlite')
}

function resolveDbPath(): string {
  return _dbPathOverride ? pathResolve(_dbPathOverride) : defaultFeedbackDbPath()
}

// ---------- envelope 辅助 ----------

function okEnv(extra: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...extra })
}

function errEnv(code: string, message: string): string {
  return JSON.stringify({ ok: false, errors: [{ code, message }] })
}

function invalid(message: string): string {
  return errEnv('invalid_params', message)
}

function isRating(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5
}

// ---------- list：LEFT JOIN 变体（孤儿可见 + judge_score 联查） ----------

export interface FeedbackWideRow {
  generation_id: string
  rating: number
  created_at: number
  tags?: string[]
  notes?: string
  actual_output_path?: string
  /** 仅非 orphan 行携带 */
  target?: string
  /** 仅非 orphan 且 generation 存过 judge_score 时携带 */
  judge_score?: number
  orphaned: boolean
}

function listFeedbackWide(dbPath: string, q?: FeedbackContent): FeedbackWideRow[] {
  // 懒 prune 兼当 schema 初始化（store.openDb 建 SCHEMA；空库返回空列表）
  pruneGenerations(dbPath)
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
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT f.generation_id, f.rating, f.tags_json, f.notes, f.actual_output_path, f.created_at,
                g.target, g.judge_score
         FROM feedback f LEFT JOIN generations g ON g.id = f.generation_id${where}
         ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>
    return rows.map((r) => {
      const row: FeedbackWideRow = {
        generation_id: String(r.generation_id),
        rating: Number(r.rating),
        created_at: Number(r.created_at),
        orphaned: r.target === null || r.target === undefined,
      }
      if (r.tags_json !== null && r.tags_json !== undefined) row.tags = JSON.parse(String(r.tags_json)) as string[]
      if (r.notes !== null && r.notes !== undefined) row.notes = String(r.notes)
      if (r.actual_output_path !== null && r.actual_output_path !== undefined) {
        row.actual_output_path = String(r.actual_output_path)
      }
      if (!row.orphaned) {
        row.target = String(r.target)
        if (r.judge_score !== null && r.judge_score !== undefined) row.judge_score = Number(r.judge_score)
      }
      return row
    })
  } finally {
    db.close()
  }
}

/** UPSERT 前置：删同 generation_id 的旧行（补评历史不保留） */
function deleteFeedbackRows(dbPath: string, generationId: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('DELETE FROM feedback WHERE generation_id = ?').run(generationId)
  } finally {
    db.close()
  }
}

// ---------- 纯函数 envelope ----------

/**
 * 按 action 分发 store 调用 → Envelope JSON 字符串。
 * 参数校验失败返回 ok:false code=invalid_params；generation 不存在 → generation_not_found /
 * not_found；DB 异常向上抛（execute 转 internal_error）。
 */
export function feedbackEnvelope(content: FeedbackContent, dbPath: string): string {
  const action = content.action
  if (action !== 'record' && action !== 'list' && action !== 'get' && action !== 'stats') {
    return invalid(`未知 action: ${String(action)}（可选 record | list | get | stats）`)
  }

  if (action === 'record') {
    if (typeof content.generation_id !== 'string' || !content.generation_id.trim()) {
      return invalid('record 需要 generation_id（prompt_author 成功 envelope 顶层携带）')
    }
    if (!isRating(content.rating)) return invalid('record 需要 rating 为 1-5 整数')
    if (content.tags !== undefined && (!Array.isArray(content.tags) || content.tags.some((t) => typeof t !== 'string'))) {
      return invalid('tags 必须是 string[]（负反馈词表）')
    }
    const gid = content.generation_id
    // 懒 prune 先于 FK 校验（getGeneration 打开时顺带建 schema）
    const gen = getGeneration(dbPath, gid)
    if (!gen) {
      return errEnv('generation_not_found', `generation ${gid} 不存在（可能已过 90 天保留期被 prune，或 generation_id 拼错）`)
    }
    const existing = getFeedback(dbPath, gid)
    if (existing) deleteFeedbackRows(dbPath, gid) // UPSERT：新评覆盖旧评
    const r = recordFeedback(dbPath, {
      generation_id: gid,
      rating: content.rating,
      ...(content.tags !== undefined ? { tags: content.tags } : {}),
      ...(content.notes !== undefined ? { notes: content.notes } : {}),
      ...(content.actual_output_path !== undefined ? { actual_output_path: content.actual_output_path } : {}),
    })
    if (!r.ok) return errEnv('generation_not_found', `generation ${gid} 不存在（可能已过 90 天保留期被 prune）`)
    return okEnv({ action, generation_id: gid, rating: content.rating, updated: existing !== undefined })
  }

  if (action === 'list') {
    for (const [k, v] of [['min_rating', content.min_rating], ['max_rating', content.max_rating]] as const) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5)) {
        return invalid(`${k} 必须是 1-5 整数`)
      }
    }
    if (content.limit !== undefined && (typeof content.limit !== 'number' || !Number.isInteger(content.limit) || content.limit < 1)) {
      return invalid('limit 必须是正整数')
    }
    const feedback = listFeedbackWide(dbPath, content)
    return okEnv({ action, count: feedback.length, feedback })
  }

  if (action === 'get') {
    if (typeof content.generation_id !== 'string' || !content.generation_id.trim()) {
      return invalid('get 需要 generation_id')
    }
    const f = getFeedback(dbPath, content.generation_id)
    if (!f) return errEnv('not_found', `generation ${content.generation_id} 没有反馈记录`)
    return okEnv({ action, generation_id: content.generation_id, feedback: f })
  }

  // stats
  if (content.target !== undefined && typeof content.target !== 'string') return invalid('target 必须是 string')
  const stats = statsFeedback(dbPath, content.target)
  return okEnv({ action, stats })
}

// ---------- 工具注册 ----------

export function registerFeedbackTool(ctx: Context, _config: Config) {
  return defineTool({
    name: 'prompt_feedback',
    description:
      '人工反馈通道（质量飞轮 §3）：对 prompt_author 产出（envelope 顶层 generation_id）评分 1-5 并附负反馈词表。' +
      'action=record {generation_id, rating(1-5整数), tags?, notes?, actual_output_path?}；' +
      'action=list {target?, min_rating?, max_rating?, limit?}——非孤儿行附 target/judge_score（评委分联查），孤儿行（generation 已过期清理）标 orphaned:true；' +
      'action=get {generation_id}；action=stats {target?} → 均分/分布/高频负反馈 tag。' +
      'record 为 UPSERT：同 generation_id 再次评分覆盖旧评（补评历史不保留）；' +
      '生成记录保留 90 天（懒清理），过期 generation 补反馈会返回 generation_not_found。',
    parameters: {
      action: { type: 'string', description: 'record | list | get | stats' },
      generation_id: { type: 'string', description: 'record/get 必填：prompt_author envelope 的 generation_id' },
      rating: { type: 'number', description: 'record 必填：1-5 整数（5 最好）' },
      tags: { type: 'array', description: 'record 可选：负反馈词表（anima：构图/肢体/风格偏差…；h3：角色不一致/镜头冗余/节奏…）' },
      notes: { type: 'string', description: 'record 可选：自由文本备注' },
      actual_output_path: { type: 'string', description: 'record 可选：实际出图/出视频路径' },
      target: { type: 'string', description: 'list/stats 可选：anima | h3' },
      min_rating: { type: 'number', description: 'list 可选：rating 下界（含）' },
      max_rating: { type: 'number', description: 'list 可选：rating 上界（含）' },
      limit: { type: 'number', description: 'list 可选：返回条数上限（默认 100）' },
    },
    output: {
      schema: { type: 'string', description: 'Envelope JSON 字符串 {ok, action?, feedback?/stats?/generation_id?/rating?/count?, errors?}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: Record<string, unknown>) {
      const dbPath = resolveDbPath()
      try {
        const out = feedbackEnvelope(
          {
            action: args.action as FeedbackContent['action'],
            generation_id: typeof args.generation_id === 'string' ? args.generation_id : undefined,
            rating: typeof args.rating === 'number' ? args.rating : undefined,
            tags: Array.isArray(args.tags) ? (args.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
            notes: typeof args.notes === 'string' ? args.notes : undefined,
            actual_output_path: typeof args.actual_output_path === 'string' ? args.actual_output_path : undefined,
            target: typeof args.target === 'string' ? args.target : undefined,
            min_rating: typeof args.min_rating === 'number' ? args.min_rating : undefined,
            max_rating: typeof args.max_rating === 'number' ? args.max_rating : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          },
          dbPath,
        )
        logInfo(ctx, `[prompt-master] prompt_feedback action=${String(args.action)} db=${dbPath}`)
        return out
      } catch (e) {
        // DB 异常不静默：转 envelope internal_error（反馈是增强层，不阻塞主链路）
        const message = e instanceof Error ? e.message : String(e)
        logInfo(ctx, `[prompt-master] prompt_feedback failed internal_error ${message}`)
        return errEnv('internal_error', message)
      }
    },
  })
}
