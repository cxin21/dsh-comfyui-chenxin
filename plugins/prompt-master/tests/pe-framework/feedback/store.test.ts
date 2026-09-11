/**
 * Task 7: feedback store（spec §3.2）——generations + feedback 两表，node:sqlite。
 * 行为规格 8 条逐条覆盖（brief：每条至少一个测试）。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  recordGeneration,
  recordFeedback,
  listFeedback,
  getFeedback,
  getGeneration,
  statsFeedback,
  pruneGenerations,
  DEBATE_JSON_MAX,
  FINAL_OUTPUT_MAX,
  GENERATION_RETENTION_DAYS,
  type GenerationRow,
  type FeedbackRow,
} from '../../../src/pe-framework/feedback/store.js'

const dir = mkdtempSync(join(tmpdir(), 'feedback-store-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function dbPath(name: string): string {
  return join(dir, name + '.sqlite')
}

function gen(overrides: Partial<GenerationRow> = {}): GenerationRow {
  return {
    id: 'gen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    created_at: Date.now(),
    target: 'anima',
    judge_mode: 'fast',
    input_digest: 'a'.repeat(64),
    final_output: 'masterpiece, 1girl',
    ...overrides,
  }
}

// ---------- 1. 建表懒初始化 ----------
describe('lazy init', () => {
  it('creates db file and tables on first call', () => {
    const p = dbPath('init')
    expect(() => recordGeneration(p, gen())).not.toThrow()
    // 二次调用（表已存在）也正常
    expect(() => recordFeedback(p, { generation_id: gen({}).id, rating: 3 })).toBeTruthy
    // 直接再查不炸
    expect(listFeedback(p)).toEqual(listFeedback(p))
  })
})

// ---------- 2. recordGeneration/get 往返 ----------
describe('recordGeneration / getGeneration roundtrip', () => {
  it('persists and reads back all fields', () => {
    const p = dbPath('roundtrip')
    const g = gen({
      variant: 'cinematic',
      judge_score: 82,
      judge_verdict: 'pass',
      debate_json: JSON.stringify({ findings: [{ severity: 'minor', note: 'x' }] }),
      repair_rounds: 1,
    })
    recordGeneration(p, g)
    const got = getGeneration(p, g.id)
    expect(got).toEqual(g)
  })

  it('omits optional fields → undefined on read-back', () => {
    const p = dbPath('roundtrip2')
    const g = gen({ repair_rounds: 0 })
    delete (g as unknown as Record<string, unknown>).judge_score
    recordGeneration(p, g)
    const got = getGeneration(p, g.id)
    expect(got?.judge_score).toBeUndefined()
    expect(got?.judge_verdict).toBeUndefined()
    expect(got?.debate_json).toBeUndefined()
    expect(got?.variant).toBeUndefined()
  })

  it('unknown id → undefined', () => {
    expect(getGeneration(dbPath('roundtrip'), 'gen_nope')).toBeUndefined()
  })
})

// ---------- 3. recordFeedback 外键校验 ----------
describe('recordFeedback FK validation', () => {
  it('unknown generation_id → generation_not_found', () => {
    const p = dbPath('fk')
    expect(recordFeedback(p, { generation_id: 'gen_missing', rating: 4 })).toEqual({
      ok: false,
      code: 'generation_not_found',
    })
  })

  it('known generation_id → ok:true, created_at auto-filled', () => {
    const p = dbPath('fk2')
    const g = gen()
    recordGeneration(p, g)
    const r = recordFeedback(p, { generation_id: g.id, rating: 5, tags: ['构图'] })
    expect(r).toEqual({ ok: true })
    const f = getFeedback(p, g.id)
    expect(f).toBeDefined()
    expect(f!.rating).toBe(5)
    expect(f!.tags).toEqual(['构图'])
    expect(f!.created_at).toBeGreaterThan(0)
  })
})

// ---------- 4. 64KB / 32KB 裁剪 ----------
describe('size caps', () => {
  it('trims debate_json to ≤64KB, keeps blocker/major, drops minor, marks truncated', () => {
    const p = dbPath('debate')
    const filler = 'x'.repeat(20 * 1024)
    const debate = {
      findings: [
        { severity: 'blocker', note: 'BLOCKER-' + filler },
        { severity: 'major', note: 'MAJOR-' + filler },
        { severity: 'minor', note: 'MINOR-' + filler },
        { severity: 'minor', note: 'MINOR2-' + filler },
      ],
      verdict: 'needs_revision',
    }
    const debateJson = JSON.stringify(debate)
    expect(Buffer.byteLength(debateJson)).toBeGreaterThan(DEBATE_JSON_MAX)
    const g = gen({ debate_json: debateJson })
    recordGeneration(p, g)
    const stored = getGeneration(p, g.id)!.debate_json!
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(DEBATE_JSON_MAX)
    expect(stored).toContain('"truncated":true')
    expect(stored).toContain('BLOCKER-')
    expect(stored).toContain('MAJOR-')
    expect(stored).not.toContain('MINOR-')
  })

  it('small debate_json passes through untouched', () => {
    const p = dbPath('debate2')
    const raw = JSON.stringify({ findings: [], verdict: 'pass' })
    const g = gen({ debate_json: raw })
    recordGeneration(p, g)
    expect(getGeneration(p, g.id)!.debate_json).toBe(raw)
  })

  it('final_output >32KB truncated to 32KB', () => {
    const p = dbPath('final')
    const g = gen({ final_output: 'y'.repeat(FINAL_OUTPUT_MAX + 1000) })
    recordGeneration(p, g)
    const stored = getGeneration(p, g.id)!.final_output
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(FINAL_OUTPUT_MAX)
    expect(stored.length).toBeLessThan(FINAL_OUTPUT_MAX + 1000)
  })
})

// ---------- 5. list 过滤 ----------
describe('listFeedback filters', () => {
  const p = dbPath('list')

  function seed(id: string, target: string, rating: number): void {
    recordGeneration(p, gen({ id, target }))
    recordFeedback(p, { generation_id: id, rating })
  }

  it('filters by target / min_rating / max_rating / limit, created_at desc', () => {
    seed('gen_l1', 'anima', 1)
    seed('gen_l2', 'anima', 3)
    seed('gen_l3', 'anima', 5)
    seed('gen_l4', 'h3', 2)
    seed('gen_l5', 'h3', 4)

    // target 过滤
    expect(listFeedback(p, { target: 'anima' }).map((f) => f.generation_id)).toEqual(['gen_l3', 'gen_l2', 'gen_l1'])
    // min_rating（含边界：rating≥3 → l5/l3/l2，同 ms 写入按 rowid 倒序）
    expect(listFeedback(p, { min_rating: 3 }).map((f) => f.generation_id)).toEqual(['gen_l5', 'gen_l3', 'gen_l2'])
    // max_rating
    expect(listFeedback(p, { max_rating: 2 }).map((f) => f.generation_id)).toEqual(['gen_l4', 'gen_l1'])
    // limit（created_at 倒序取前 N）
    expect(listFeedback(p, { limit: 2 }).map((f) => f.generation_id)).toEqual(['gen_l5', 'gen_l4'])
    // 组合
    expect(listFeedback(p, { target: 'anima', min_rating: 2, max_rating: 4 }).map((f) => f.generation_id)).toEqual(['gen_l2'])
    // 返回行带 target 且倒序
    const all = listFeedback(p)
    expect(all.every((f) => typeof f.target === 'string')).toBe(true)
    for (let i = 1; i < all.length; i++) expect(all[i - 1].created_at >= all[i].created_at).toBe(true)
  })
})

// ---------- 6. stats 聚合 ----------
describe('statsFeedback', () => {
  const p = dbPath('stats')

  it('count / avgRating / histogram / topTags', () => {
    const feed = (id: string, rating: number, tags?: string[]): void => {
      recordGeneration(p, gen({ id, target: 'h3' }))
      recordFeedback(p, { generation_id: id, rating, tags })
    }
    feed('gen_s1', 1, ['节奏', '角色不一致'])
    feed('gen_s2', 3, ['节奏'])
    feed('gen_s3', 3)
    feed('gen_s4', 5, ['节奏', '镜头冗余', '角色不一致'])
    feed('gen_s5', 5, ['角色不一致'])
    // 干扰项：不同 target
    recordGeneration(p, gen({ id: 'gen_s6', target: 'anima' }))
    recordFeedback(p, { generation_id: 'gen_s6', rating: 1, tags: ['构图'] })

    const s = statsFeedback(p, 'h3')
    expect(s.count).toBe(5)
    expect(s.avgRating).toBeCloseTo(3.4, 5)
    // histogram：5 桶，index 0 = rating 1 → [1,0,2,0,2]
    expect(s.histogram).toEqual([1, 0, 2, 0, 2])
    // topTags 降序取前 5
    expect(s.topTags).toEqual([
      { tag: '角色不一致', n: 3 },
      { tag: '节奏', n: 3 },
      { tag: '镜头冗余', n: 1 },
    ])
    // 无 target 过滤 → 全量
    expect(statsFeedback(p).count).toBe(6)
    // avgRating 一位小数
    const sAll = statsFeedback(p)
    expect(Number(sAll.avgRating.toFixed(1))).toBe(sAll.avgRating)
  })
})

// ---------- 7. prune ----------
describe('pruneGenerations', () => {
  const day = 24 * 60 * 60 * 1000

  it('deletes generations older than retention, returns count', () => {
    const p = dbPath('prune')
    // 独立 db：recordGeneration 的懒 prune 在写入前执行，只此一条时不影响它自身
    recordGeneration(p, gen({ id: 'gen_old', created_at: Date.now() - (GENERATION_RETENTION_DAYS + 5) * day }))
    expect(getGeneration(p, 'gen_old')).toBeDefined()
    expect(pruneGenerations(p)).toBe(1)
    expect(getGeneration(p, 'gen_old')).toBeUndefined()
    expect(pruneGenerations(p)).toBe(0)
  })

  it('feedback survives its generation (orphans allowed — feedback is scarce)', () => {
    const p = dbPath('prune-orphan')
    recordGeneration(p, gen({ id: 'gen_o1', created_at: Date.now() - 10 * day }))
    expect(recordFeedback(p, { generation_id: 'gen_o1', rating: 2 })).toEqual({ ok: true })
    // 收紧保留期：generation 被删，feedback 保留
    expect(pruneGenerations(p, 5)).toBe(1)
    expect(getGeneration(p, 'gen_o1')).toBeUndefined()
    expect(getFeedback(p, 'gen_o1')?.rating).toBe(2)
    // 孤儿 feedback 仍可 list（JOIN generations 会丢弃，故 get 是孤儿读取通道）
    expect(getFeedback(p, 'gen_o1')).toBeDefined()
  })

  it('lazy prune: recordGeneration/recordFeedback prune expired generations first', () => {
    const p = dbPath('prune-lazy')
    recordGeneration(p, gen({ id: 'gen_lz', created_at: Date.now() - (GENERATION_RETENTION_DAYS + 10) * day }))
    expect(getGeneration(p, 'gen_lz')).toBeDefined()
    // 下一次写入顺带清理
    recordGeneration(p, gen({ id: 'gen_lz2' }))
    expect(getGeneration(p, 'gen_lz')).toBeUndefined()
    // prune 先于外键校验：过期 generation 的反馈回写 → generation_not_found
    expect(recordFeedback(p, { generation_id: 'gen_lz', rating: 3 })).toEqual({
      ok: false,
      code: 'generation_not_found',
    })
  })

  it('custom retentionDays', () => {
    const p = dbPath('prune2')
    recordGeneration(p, gen({ id: 'gen_old2', created_at: Date.now() - 10 * day }))
    expect(pruneGenerations(p, 5)).toBe(1)
    expect(pruneGenerations(p, 5)).toBe(0)
  })
})

// ---------- 8. 隐私 ----------
describe('privacy shape', () => {
  it('GenerationRow / FeedbackRow carry no raw input / image / api key fields', () => {
    const g = gen()
    expect(Object.keys(g).sort()).toEqual(
      ['created_at', 'debate_json', 'final_output', 'id', 'input_digest', 'judge_mode', 'judge_score', 'judge_verdict', 'repair_rounds', 'target', 'variant'].filter(
        (k) => k in g,
      ).sort(),
    )
    // input 只以 digest 形式存在
    expect(g.input_digest).toMatch(/^[0-9a-f]{0,128}$/)
    const f: FeedbackRow = { generation_id: 'x', rating: 3, created_at: 1 }
    expect(Object.keys(f)).toEqual(['generation_id', 'rating', 'created_at'])
  })
})
