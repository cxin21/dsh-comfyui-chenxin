import { describe, expect, it, vi } from 'vitest'
import {
  evaluateCandidate,
  renderMarkdown,
  type CandidateReport,
} from '../../../src/pe-framework/optimize/report.js'
import type { EvalCase } from '../../../src/pe-framework/optimize/harness.js'
import type { PersonaCandidate } from '../../../src/pe-framework/optimize/mutate.js'

const CANDIDATE: PersonaCandidate = {
  id: 'cand_123_abc',
  diff: '+强调材质',
  rationale: 'r',
  targetsFailures: [],
}

function makeCases(n: number): EvalCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `case-${i}`,
    tier: 'L1' as const,
    input: `意图 ${i}`,
    target: 'anima' as const,
  }))
}

type RunResult = { judgeScore: number; rulePass: boolean; dimensionScores?: Record<string, number> }

/** runWith mock：按 caseId → { incumbent, candidate } 两份结果查表。 */
function tableRunWith(table: Record<string, { incumbent: RunResult; candidate: RunResult }>) {
  const calls: Array<{ candidateId: string; caseId: string }> = []
  const runWith = vi.fn(async (candidateId: string, c: EvalCase): Promise<RunResult> => {
    calls.push({ candidateId, caseId: c.id })
    return table[c.id][candidateId === 'incumbent' ? 'incumbent' : 'candidate']
  })
  return { runWith, calls }
}

describe('evaluateCandidate', () => {
  it('incumbent 与 candidate 各跑全量 evalset；perDimension 均分正确', async () => {
    const cases = makeCases(3)
    const { runWith, calls } = tableRunWith({
      'case-0': {
        incumbent: { judgeScore: 60, rulePass: true, dimensionScores: { quality: 60 } },
        candidate: { judgeScore: 70, rulePass: true, dimensionScores: { quality: 70 } },
      },
      'case-1': {
        incumbent: { judgeScore: 60, rulePass: true, dimensionScores: { quality: 60 } },
        candidate: { judgeScore: 80, rulePass: true, dimensionScores: { quality: 80 } },
      },
      'case-2': {
        incumbent: { judgeScore: 60, rulePass: true, dimensionScores: { quality: 60 } },
        candidate: { judgeScore: 90, rulePass: true, dimensionScores: { quality: 90 } },
      },
    })
    const report = await evaluateCandidate({ candidate: CANDIDATE, evalset: cases, runWith })
    // 3 case × 2 侧 = 6 次调用；每 case 先 incumbent 后 candidate
    expect(calls).toHaveLength(6)
    expect(calls.map((c) => c.candidateId)).toEqual([
      'incumbent', 'cand_123_abc',
      'incumbent', 'cand_123_abc',
      'incumbent', 'cand_123_abc',
    ])
    expect(report.perDimension['quality']).toEqual({ incumbent: 60, candidate: 80 })
  })

  it('配对显著性：全维 +10（n=5）→ significant:true、improved 含该维；±2 波动组 → significant:false', async () => {
    const cases = makeCases(5)
    const strong = tableRunWith(
      Object.fromEntries(
        cases.map((c) => [
          c.id,
          {
            incumbent: { judgeScore: 60, rulePass: true, dimensionScores: { quality: 60 } },
            candidate: { judgeScore: 72, rulePass: true, dimensionScores: { quality: 72 } },
          },
        ]),
      ),
    )
    const strongReport = await evaluateCandidate({ candidate: CANDIDATE, evalset: cases, runWith: strong.runWith })
    expect(strongReport.significant).toBe(true)
    expect(strongReport.improved).toContain('quality')
    expect(strongReport.regressed).toEqual([])

    const diffs = [2, -2, 2, -2, 2]
    const noisy = tableRunWith(
      Object.fromEntries(
        cases.map((c, i) => [
          c.id,
          {
            incumbent: { judgeScore: 60, rulePass: true, dimensionScores: { quality: 60 } },
            candidate: { judgeScore: 60 + diffs[i], rulePass: true, dimensionScores: { quality: 60 + diffs[i] } },
          },
        ]),
      ),
    )
    const noisyReport = await evaluateCandidate({ candidate: CANDIDATE, evalset: cases, runWith: noisy.runWith })
    expect(noisyReport.significant).toBe(false)
    expect(noisyReport.improved).toEqual([])
  })

  it('casesRun 与 pairedDelta（一位小数）正确', async () => {
    const cases = makeCases(5)
    // judge +12 → case 分 75 vs (36+30)/0.8=82.5→scoreGeneration 四舍五入 83，恒定差 → pairedDelta 8.0
    const { runWith } = tableRunWith(
      Object.fromEntries(
        cases.map((c) => [
          c.id,
          {
            incumbent: { judgeScore: 60, rulePass: true },
            candidate: { judgeScore: 72, rulePass: true },
          },
        ]),
      ),
    )
    const report = await evaluateCandidate({ candidate: CANDIDATE, evalset: cases, runWith })
    expect(report.casesRun).toBe(5)
    expect(report.incumbentId).toBe('incumbent')
    expect(report.candidateId).toBe('cand_123_abc')
    expect(report.pairedDelta).toBeCloseTo(8, 5)
  })
})

describe('renderMarkdown', () => {
  const dims = { quality: { incumbent: 60, candidate: 72 } }

  it('有回归维度 → 开头醒目警告行；含逐维表格行与 significant 标记', () => {
    const report: CandidateReport = {
      candidateId: 'cand_x',
      incumbentId: 'incumbent',
      perDimension: { ...dims, budget: { incumbent: 80, candidate: 60 } },
      improved: ['quality'],
      regressed: ['budget'],
      pairedDelta: 3.2,
      significant: true,
      casesRun: 10,
    }
    const md = renderMarkdown([report])
    expect(md).toContain('⚠️ 存在回归维度')
    expect(md.indexOf('⚠️ 存在回归维度')).toBeLessThan(md.indexOf('## '))
    expect(md).toContain('quality')
    expect(md).toContain('budget')
    expect(md).toContain('60')
    expect(md).toContain('72')
    expect(md).toContain('3.2')
    expect(md).toContain('✅ 显著')
    expect(md).toContain('quality')
  })

  it('无回归 → 不含警告行；不显著时标记不显著', () => {
    const report: CandidateReport = {
      candidateId: 'cand_y',
      incumbentId: 'incumbent',
      perDimension: dims,
      improved: [],
      regressed: [],
      pairedDelta: 0.5,
      significant: false,
      casesRun: 5,
    }
    const md = renderMarkdown([report])
    expect(md).not.toContain('⚠️ 存在回归维度')
    expect(md).toContain('0.5')
    expect(md).toContain('不显著')
  })
})
