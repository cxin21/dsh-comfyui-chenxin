/**
 * Task 9: scoring harness 纯函数层（spec §4.2 评分公式 / §4.4 冷启动门槛）。
 * 行为规格 6 条逐条覆盖（brief：每条一个 it；store 用临时文件 dbPath 造数）。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  recordGeneration,
  recordFeedback,
  type GenerationRow,
} from '../../../src/pe-framework/feedback/store.js'
import {
  scoreGeneration,
  loadEvalset,
  coldStartReady,
  type EvalCase,
} from '../../../src/pe-framework/optimize/harness.js'

const dir = mkdtempSync(join(tmpdir(), 'optimize-harness-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function dbPath(name: string): string {
  return join(dir, name + '.sqlite')
}

let seq = 0
function gen(overrides: Partial<GenerationRow> = {}): GenerationRow {
  seq += 1
  return {
    id: `gen_t9_${String(seq).padStart(4, '0')}`,
    created_at: Date.now() + seq,
    target: 'anima',
    judge_mode: 'fast',
    input_digest: 'b'.repeat(64),
    final_output: 'masterpiece, 1girl',
    enrich: 0,
    ...overrides,
  }
}

// ---------- 1. scoreGeneration 三分支 ----------
describe('scoreGeneration', () => {
  it('applies weighted formula with / without humanRating and clamps to [0,100]', () => {
    // 有 human：0.5*judge + 0.3*rule + 0.2*human（human 按 0-100 尺度原样加权）
    const withHuman = scoreGeneration({ judgeScore: 80, rulePass: true, humanRating: 80 })
    expect(withHuman).toBe(Math.round(0.5 * 80 + 0.3 * 100 + 0.2 * 80))

    // 无 human：(0.5*judge + 0.3*rule)/0.8 归一
    const noHuman = scoreGeneration({ judgeScore: 80, rulePass: true })
    expect(noHuman).toBe(Math.round((0.5 * 80 + 0.3 * 100) / 0.8))

    // rule=false 分支与四舍五入
    expect(scoreGeneration({ judgeScore: 60, rulePass: false, humanRating: 50 })).toBe(
      Math.round(0.5 * 60 + 0.3 * 0 + 0.2 * 50),
    )

    // 极值夹取：负数 → 0，>100 → 100（夹取作用于最终结果）
    expect(scoreGeneration({ judgeScore: -20, rulePass: false })).toBe(0)
    expect(scoreGeneration({ judgeScore: 0, rulePass: false, humanRating: 0 })).toBe(0)
    expect(scoreGeneration({ judgeScore: 200, rulePass: true })).toBe(100)
    expect(scoreGeneration({ judgeScore: 200, rulePass: true, humanRating: 100 })).toBe(100)
  })
})

// ---------- 2. loadEvalset L1 ----------
describe('loadEvalset L1', () => {
  it('collects rating>=4 / <=2, skips rating 3 and orphans, filters by target', async () => {
    const p = dbPath('l1')
    const pos1 = gen({ judge_score: 80, judge_verdict: 'pass' })
    const pos2 = gen({ judge_score: 70 })
    const neg = gen({ judge_score: 40, judge_verdict: 'needs_revision' })
    const mid = gen({})
    const other = gen({ target: 'h3' })
    for (const g of [pos1, pos2, neg, mid, other]) recordGeneration(p, g)
    expect(recordFeedback(p, { generation_id: pos1.id, rating: 4 })).toEqual({ ok: true })
    expect(recordFeedback(p, { generation_id: pos2.id, rating: 5 })).toEqual({ ok: true })
    expect(recordFeedback(p, { generation_id: neg.id, rating: 2 })).toEqual({ ok: true })
    expect(recordFeedback(p, { generation_id: mid.id, rating: 3 })).toEqual({ ok: true })
    expect(recordFeedback(p, { generation_id: other.id, rating: 4 })).toEqual({ ok: true })
    // 孤儿行：feedback 存在但 generation 缺失（绕过 recordFeedback 外键检查直插）
    const db = new DatabaseSync(p)
    db.prepare(
      `INSERT INTO feedback (generation_id, rating, created_at) VALUES ('gen_orphan', 4, ${Date.now()})`,
    ).run()
    db.close()

    const cases = await loadEvalset(p, 'anima')
    const l1 = cases.filter((c) => c.tier === 'L1')
    expect(l1).toHaveLength(3)
    const byGen = new Map(l1.map((c) => [c.sourceGenerationId, c]))
    expect(byGen.get(pos1.id)?.humanRating).toBe(4)
    expect(byGen.get(pos2.id)?.humanRating).toBe(5)
    expect(byGen.get(neg.id)?.humanRating).toBe(2)
    expect(byGen.has(mid.id)).toBe(false)
    expect(byGen.has(other.id)).toBe(false)
    expect(byGen.has('gen_orphan')).toBe(false)
    // L1 溯源与 golden digest
    expect(byGen.get(pos1.id)?.target).toBe('anima')
    expect(byGen.get(pos1.id)?.expectedDigest).toBe(pos1.input_digest)
  })
})

// ---------- 3. loadEvalset L2 ----------
describe('loadEvalset L2', () => {
  it('collects needs_revision with repair_rounds>=1 only', async () => {
    const p = dbPath('l2')
    const in1 = gen({ judge_verdict: 'needs_revision', repair_rounds: 1 })
    const in2 = gen({ judge_verdict: 'needs_revision', repair_rounds: 2 })
    const noRepair = gen({ judge_verdict: 'needs_revision', repair_rounds: 0 })
    const passed = gen({ judge_verdict: 'pass', repair_rounds: 1 })
    const other = gen({ target: 'h3', judge_verdict: 'needs_revision', repair_rounds: 1 })
    for (const g of [in1, in2, noRepair, passed, other]) recordGeneration(p, g)

    const cases = await loadEvalset(p, 'anima')
    const l2 = cases.filter((c) => c.tier === 'L2')
    expect(l2.map((c) => c.sourceGenerationId).sort()).toEqual([in1.id, in2.id].sort())
    expect(l2.every((c) => c.target === 'anima')).toBe(true)
  })
})

// ---------- 4. loadEvalset L3 ----------
describe('loadEvalset L3', () => {
  it('scans goldenDir by target filename prefix; missing input → empty string', async () => {
    const goldenDir = join(dir, 'golden-l3')
    mkdirSync(goldenDir, { recursive: true })
    writeFileSync(
      join(goldenDir, 'anima-x.json'),
      JSON.stringify({ name: 'anima-x', input: 'a fluffy cat in the snow', sha256: 'c'.repeat(64) }),
    )
    writeFileSync(join(goldenDir, 'h3-yyy.json'), JSON.stringify({ input: 'h3 thing' }))
    writeFileSync(join(goldenDir, 'unrelated.json'), JSON.stringify({ input: 'nope' }))
    writeFileSync(join(goldenDir, 'anima-noinput.json'), JSON.stringify({ name: 'anima-noinput' }))
    writeFileSync(join(goldenDir, 'anima-readme.md'), 'not json')

    const cases = await loadEvalset(dbPath('l3-empty'), 'anima', goldenDir)
    const l3 = cases.filter((c) => c.tier === 'L3')
    expect(l3.map((c) => c.id).sort()).toEqual(['anima-noinput', 'anima-x'])
    const x = l3.find((c) => c.id === 'anima-x') as EvalCase
    expect(x.input).toBe('a fluffy cat in the snow')
    expect(x.expectedDigest).toBe('c'.repeat(64))
    const noInput = l3.find((c) => c.id === 'anima-noinput') as EvalCase
    expect(noInput.input).toBe('')
  })
})

// ---------- 5. coldStartReady 三态 ----------
describe('coldStartReady', () => {
  it('not ready below thresholds; ready at l1=50 or l1+l2=80', async () => {
    const seed = (p: string, nL1: number, nL2: number) => {
      for (let i = 0; i < nL1; i += 1) {
        const g = gen({ id: `l1_${p.replace(/\W/g, '')}_${i}` })
        recordGeneration(p, g)
        recordFeedback(p, { generation_id: g.id, rating: 4 })
      }
      for (let i = 0; i < nL2; i += 1) {
        recordGeneration(p, gen({ id: `l2_${p.replace(/\W/g, '')}_${i}`, judge_verdict: 'needs_revision', repair_rounds: 1 }))
      }
    }
    const low = dbPath('cold-low')
    seed(low, 30, 10)
    const r1 = await coldStartReady(low, 'anima')
    expect(r1.ready).toBe(false)
    expect(r1.l1).toBe(30)
    expect(r1.l2).toBe(10)
    expect(r1.need).toContain('50')
    expect(r1.need).toContain('80')

    const atL1 = dbPath('cold-l1')
    seed(atL1, 50, 0)
    const r2 = await coldStartReady(atL1, 'anima')
    expect(r2.ready).toBe(true)
    expect(r2.need).toBe('')

    const atSum = dbPath('cold-sum')
    seed(atSum, 30, 50)
    const r3 = await coldStartReady(atSum, 'anima')
    expect(r3.ready).toBe(true)
    expect(r3.need).toBe('')
  })
})

// ---------- 6. 排序与上限 ----------
describe('loadEvalset ordering and caps', () => {
  it('L1 keeps only the newest 200 by created_at desc', async () => {
    const p = dbPath('cap')
    const base = Date.now() - 10_000
    for (let i = 0; i < 250; i += 1) {
      const g = gen({ id: `cap_${String(i).padStart(4, '0')}`, created_at: base + i * 1000 })
      recordGeneration(p, g)
      recordFeedback(p, { generation_id: g.id, rating: 5 })
    }
    const cases = await loadEvalset(p, 'anima')
    const l1 = cases.filter((c) => c.tier === 'L1')
    expect(l1).toHaveLength(200)
    expect(l1[0]?.sourceGenerationId).toBe(`cap_${String(249).padStart(4, '0')}`)
    expect(l1[199]?.sourceGenerationId).toBe(`cap_${String(50).padStart(4, '0')}`)
  })
})
