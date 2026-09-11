/**
 * 质量飞轮 §4.3 候选评测（配对比较）与 diff 报告（离线，人审闸门）。
 *
 * 离线铁律（spec §4.1）：本模块不被运行时管线 import、不注册 agent 工具。
 * evaluateCandidate 通过 runWith 抽象执行器跑 author（incumbent 用 candidateId='incumbent'，
 * 候选用其 id）；测试全 mock，真装配（真跑 author）属未来 CLI 脚本。
 * 人审闸门：候选不自动生效——本模块只产出报告。
 */
import type { EvalCase } from './harness.js'
import { scoreGeneration } from './harness.js'
import type { PersonaCandidate } from './mutate.js'

export interface CandidateReport {
  candidateId: string
  incumbentId: string // 'incumbent'
  perDimension: Record<string, { incumbent: number; candidate: number }> // 维度均分
  improved: string[] // candidate 显著更好的维度 id
  regressed: string[] // candidate 显著更差的维度 id
  pairedDelta: number // candidate 均分 − incumbent 均分（一位小数）
  significant: boolean // |delta| > 2*SE（SE=各 case 差值的标准差/√n；n<5 → 一律 false）
  casesRun: number
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** 样本标准差（n-1）；n<2 → 0。 */
function sampleStd(xs: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const m = mean(xs)
  const ss = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0)
  return Math.sqrt(ss / (n - 1))
}

/** 配对显著性：|mean(diffs)| > 2 * (std(diffs)/√n)；n<5 一律 false。 */
function pairedSignificant(diffs: number[]): boolean {
  const n = diffs.length
  if (n < 5) return false
  const se = sampleStd(diffs) / Math.sqrt(n)
  return Math.abs(mean(diffs)) > 2 * se
}

type RunResult = { judgeScore: number; rulePass: boolean; dimensionScores?: Record<string, number> }

/** 候选 × evalset 全量配对评测：每 case 先 incumbent 后 candidate 各跑一次。 */
export async function evaluateCandidate(input: {
  candidate: PersonaCandidate
  evalset: EvalCase[]
  runWith: (candidateId: string, c: EvalCase) => Promise<RunResult>
}): Promise<CandidateReport> {
  const incCaseScores: number[] = []
  const candCaseScores: number[] = []
  // 维度 → 两配对的逐 case 维度分
  const dimInc = new Map<string, number[]>()
  const dimCand = new Map<string, number[]>()

  for (const c of input.evalset) {
    const inc = await input.runWith('incumbent', c)
    const cand = await input.runWith(input.candidate.id, c)
    incCaseScores.push(scoreGeneration({ judgeScore: inc.judgeScore, rulePass: inc.rulePass }))
    candCaseScores.push(scoreGeneration({ judgeScore: cand.judgeScore, rulePass: cand.rulePass }))
    const dims = new Set([
      ...Object.keys(inc.dimensionScores ?? {}),
      ...Object.keys(cand.dimensionScores ?? {}),
    ])
    for (const d of dims) {
      const iv = inc.dimensionScores?.[d]
      const cv = cand.dimensionScores?.[d]
      if (typeof iv === 'number') {
        if (!dimInc.has(d)) dimInc.set(d, [])
        dimInc.get(d)!.push(iv)
      }
      if (typeof cv === 'number') {
        if (!dimCand.has(d)) dimCand.set(d, [])
        dimCand.get(d)!.push(cv)
      }
    }
  }

  const perDimension: Record<string, { incumbent: number; candidate: number }> = {}
  const improved: string[] = []
  const regressed: string[] = []
  for (const d of new Set([...dimInc.keys(), ...dimCand.keys()])) {
    const incArr = dimInc.get(d) ?? []
    const candArr = dimCand.get(d) ?? []
    const incMean = round1(mean(incArr))
    const candMean = round1(mean(candArr))
    perDimension[d] = { incumbent: incMean, candidate: candMean }
    // 逐维度配对显著性：只对两侧都有分的 case 配对（这里按索引对齐，缺侧跳过）
    const n = Math.min(incArr.length, candArr.length)
    const diffs: number[] = []
    for (let i = 0; i < n; i++) diffs.push(candArr[i] - incArr[i])
    if (pairedSignificant(diffs)) {
      if (mean(diffs) > 0) improved.push(d)
      else regressed.push(d)
    }
  }

  return {
    candidateId: input.candidate.id,
    incumbentId: 'incumbent',
    perDimension,
    improved,
    regressed,
    pairedDelta: round1(mean(candCaseScores) - mean(incCaseScores)),
    significant: pairedSignificant(
      candCaseScores.map((v, i) => v - incCaseScores[i]),
    ),
    casesRun: input.evalset.length,
  }
}

/** 报告必须含：每个候选的 pairedDelta 与 significant、逐维对照表、improved/regressed、
 *  任一候选存在回归维度时开头醒目警告行。 */
export function renderMarkdown(reports: CandidateReport[]): string {
  const hasRegression = reports.some((r) => r.regressed.length > 0)
  const lines: string[] = ['# Persona 候选评测报告', '']
  if (hasRegression) lines.push('⚠️ 存在回归维度', '')

  for (const r of reports) {
    lines.push(
      `## 候选 ${r.candidateId}`,
      '',
      `- 配对均差 pairedDelta：${r.pairedDelta > 0 ? '+' : ''}${r.pairedDelta}（casesRun=${r.casesRun}）`,
      `- 显著性：${r.significant ? '✅ 显著' : '不显著'}`,
      '',
      '| 维度 | incumbent | candidate | Δ |',
      '|---|---|---|---|',
    )
    for (const [d, v] of Object.entries(r.perDimension)) {
      const delta = round1(v.candidate - v.incumbent)
      lines.push(`| ${d} | ${v.incumbent} | ${v.candidate} | ${delta > 0 ? '+' : ''}${delta} |`)
    }
    lines.push('')
    lines.push(`- 改善维度：${r.improved.length ? r.improved.join(', ') : '（无）'}`)
    lines.push(`- 回归维度：${r.regressed.length ? r.regressed.join(', ') : '（无）'}`)
    lines.push('')
  }
  return lines.join('\n')
}
