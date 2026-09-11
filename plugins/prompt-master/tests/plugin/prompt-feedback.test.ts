/**
 * Task 8: prompt_feedback 工具（spec §3.3）——store → agent 工具暴露。
 * 契约（控制器裁定）：
 * - record = UPSERT（同 generation_id 新评覆盖旧评，补评历史不保留）
 * - list = LEFT JOIN 变体：孤儿 feedback（generation 已 prune）仍可见，标 orphaned:true；
 *   非 orphan 行附 judge_score（评委分 vs 人工分联查通道）
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../../src/plugin/index.js'
import { feedbackEnvelope } from '../../src/tools/prompt-feedback.js'
import { recordGeneration, pruneGenerations } from '../../src/pe-framework/feedback/store.js'
import type { GenerationRow } from '../../src/pe-framework/feedback/store.js'

const dir = mkdtempSync(join(tmpdir(), 'feedback-tool-'))

function dbPath(name: string): string {
  return join(dir, `${name}.sqlite`)
}

let seq = 0
function seedGeneration(p: string, target: string, judgeScore?: number): string {
  seq += 1
  const id = `gen_${Date.now()}_${seq}`
  const row: GenerationRow = {
    id,
    created_at: Date.now(),
    target,
    judge_mode: 'off',
    input_digest: `digest_${seq}`,
    final_output: `output ${seq}`,
    enrich: 0,
    ...(judgeScore !== undefined ? { judge_score: judgeScore } : {}),
  }
  recordGeneration(p, row)
  return id
}

function call(p: string, args: Record<string, unknown>): any {
  return JSON.parse(feedbackEnvelope({ ...(args as { action: 'record' }), }, p))
}

describe('prompt_feedback tool (spec §3.3)', () => {
  it('record 合法 → ok:true；重复 record 同 generation → UPSERT（get 只见最新 rating）', () => {
    const p = dbPath('upsert')
    const gid = seedGeneration(p, 'anima')
    const r1 = call(p, { action: 'record', generation_id: gid, rating: 4 })
    expect(r1.ok).toBe(true)
    expect(r1.generation_id).toBe(gid)
    const r2 = call(p, { action: 'record', generation_id: gid, rating: 2, tags: ['构图'] })
    expect(r2.ok).toBe(true)
    const got = call(p, { action: 'get', generation_id: gid })
    expect(got.ok).toBe(true)
    expect(got.feedback.rating).toBe(2)
    expect(got.feedback.tags).toEqual(['构图'])
  })

  it('record 不存在 generation → generation_not_found；rating=6 → invalid_params', () => {
    const p = dbPath('errors')
    const r1 = call(p, { action: 'record', generation_id: 'gen_missing_1', rating: 3 })
    expect(r1.ok).toBe(false)
    expect(r1.errors[0].code).toBe('generation_not_found')
    const gid = seedGeneration(p, 'h3')
    const r2 = call(p, { action: 'record', generation_id: gid, rating: 6 })
    expect(r2.ok).toBe(false)
    expect(r2.errors[0].code).toBe('invalid_params')
    const r3 = call(p, { action: 'record', generation_id: gid, rating: 2.5 })
    expect(r3.ok).toBe(false)
    expect(r3.errors[0].code).toBe('invalid_params')
  })

  it('list：过滤（target/min_rating）+ judge_score 暴露 + 孤儿行 orphaned 标记', () => {
    const p = dbPath('list')
    const a = seedGeneration(p, 'anima', 80)
    const b = seedGeneration(p, 'h3')
    expect(call(p, { action: 'record', generation_id: a, rating: 2 }).ok).toBe(true)
    expect(call(p, { action: 'record', generation_id: b, rating: 4 }).ok).toBe(true)

    const all = call(p, { action: 'list' })
    expect(all.ok).toBe(true)
    expect(all.count).toBe(2)
    const rowA = all.feedback.find((f: any) => f.generation_id === a)
    const rowB = all.feedback.find((f: any) => f.generation_id === b)
    expect(rowA.target).toBe('anima')
    expect(rowA.judge_score).toBe(80)
    expect(rowB.judge_score).toBeUndefined()
    expect(rowA.orphaned).toBe(false)

    const h3 = call(p, { action: 'list', target: 'h3' })
    expect(h3.count).toBe(1)
    expect(h3.feedback[0].generation_id).toBe(b)
    const minR = call(p, { action: 'list', min_rating: 3 })
    expect(minR.count).toBe(1)
    expect(minR.feedback[0].generation_id).toBe(b)

    // prune 后 generation 消失，feedback 仍可见 → orphaned:true，target 缺失
    pruneGenerations(p, 0)
    const after = call(p, { action: 'list' })
    expect(after.count).toBe(2)
    for (const row of after.feedback) {
      expect(row.orphaned).toBe(true)
      expect(row.target).toBeUndefined()
    }
  })

  it('get：命中返回单条；未命中 → not_found', () => {
    const p = dbPath('get')
    const gid = seedGeneration(p, 'anima')
    call(p, { action: 'record', generation_id: gid, rating: 5, notes: '很好' })
    const hit = call(p, { action: 'get', generation_id: gid })
    expect(hit.ok).toBe(true)
    expect(hit.feedback.rating).toBe(5)
    expect(hit.feedback.notes).toBe('很好')
    const miss = call(p, { action: 'get', generation_id: 'gen_nope_2' })
    expect(miss.ok).toBe(false)
    expect(miss.errors[0].code).toBe('not_found')
  })

  it('stats：聚合透传（count/avgRating/histogram/topTags）+ target 过滤', () => {
    const p = dbPath('stats')
    const a = seedGeneration(p, 'anima')
    const b = seedGeneration(p, 'h3')
    call(p, { action: 'record', generation_id: a, rating: 1, tags: ['构图', '肢体'] })
    call(p, { action: 'record', generation_id: b, rating: 5, tags: ['构图'] })
    const all = call(p, { action: 'stats' })
    expect(all.ok).toBe(true)
    expect(all.stats.count).toBe(2)
    expect(all.stats.avgRating).toBe(3)
    expect(all.stats.histogram).toEqual([1, 0, 0, 0, 1])
    expect(all.stats.topTags[0]).toEqual({ tag: '构图', n: 2 })
    const animaOnly = call(p, { action: 'stats', target: 'anima' })
    expect(animaOnly.stats.count).toBe(1)
    expect(animaOnly.stats.avgRating).toBe(1)
  })

  it('未知 action → invalid_params', () => {
    const p = dbPath('action')
    const r = call(p, { action: 'delete', generation_id: 'x' })
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('invalid_params')
  })

  it('工具注册冒烟：prompt_feedback 在 plugin 工具清单中', () => {
    const registered: Array<{ name: string }> = []
    const ctx: any = {
      tools: { register(def: any) { registered.push({ name: def.name }); return () => {} } },
      llm: { stream: async function* () {} },
      subagents: {
        start: async () => ({ id: 'stub', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }),
      },
      agent: { options: {} },
      settings: {
        register(_ns: string, _schema: unknown) {
          return { get: () => ({ customProfiles: {} }), update: async () => {}, replace: async () => {} }
        },
      },
      effect(cb: any) { cb() },
    }
    apply(ctx, { temperature: 0.7 })
    expect(registered.map((d) => d.name)).toContain('prompt_feedback')
  })
})
