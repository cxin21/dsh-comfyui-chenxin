/**
 * 二期 §10.3-A9 迭代循环驱动器：把 harness→mutate→report 三环节串成可执行编排。
 *
 * 离线铁律（spec §4.1）：只产报告，不改任何 persona；本模块不被运行时管线
 * import、不注册 agent 工具。失败允许抛（离线 CLI 语义），已落盘报告不删除。
 *
 * 分层：
 * - runIterations：纯编排（loadEvalset → proposeMutation → evaluateCandidate →
 *   renderMarkdown 落盘）。mock 模式内置固定评分/变异（零 LLM）；
 *   live 模式经 LoopDeps 注入 provider / runWith（生产装配 = createSubagentCriticProvider
 *   同款 subagent provider + runStage 真管线，由宿主侧装配后传入），未注入即抛。
 * - runOptimizeLoop：冷启动闸门（coldStartReady）+ 未达标只产冷启动报告；
 *   --force 语义在 CLI 层（直接调 runIterations 跳过门槛）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coldStartReady, loadEvalset, type EvalCase } from './harness.js'
import { proposeMutation, type PersonaCandidate } from './mutate.js'
import { evaluateCandidate, renderMarkdown, type CandidateReport } from './report.js'
import type { CriticProvider } from '../eval/critic.js'

export interface LoopOptions {
  target: 'anima' | 'h3'
  dbPath: string // feedback db
  personaFile: string // 当前 persona 文本文件路径（读入作 incumbent）
  limit?: number // 评测集条数上限，缺省 20
  mode: 'mock' | 'live' // mock=固定评分/变异；live=真调 author 管线
  outDir: string // 报告落盘目录
}

export interface LoopResult {
  ready: boolean // coldStartReady 结果；false 时仅产冷启动报告
  evalsetSize: number
  candidateId?: string
  reportPath?: string // markdown 报告落盘路径
}

/** live 模式装配缝：宿主侧（有 agent 上下文时）注入，测试注入 mock。 */
export interface LoopDeps {
  provider?: CriticProvider
  runWith?: (
    candidateId: string,
    c: EvalCase,
  ) => Promise<{ judgeScore: number; rulePass: boolean; dimensionScores?: Record<string, number> }>
}

const DEFAULT_LIMIT = 20

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

function writeReport(outDir: string, target: string, markdown: string): string {
  mkdirSync(outDir, { recursive: true })
  const ts = timestamp()
  let path = join(outDir, `${target}-${ts}.md`)
  // 同秒多次产出时加随机后缀，避免覆盖既有报告（已产出报告不删除）
  if (existsSync(path)) path = join(outDir, `${target}-${ts}-${Math.random().toString(36).slice(2, 6)}.md`)
  writeFileSync(path, markdown, 'utf8')
  return path
}

/** 冷启动缺口报告（纯文案，落盘走 writeReport 同名模式）。 */
export function renderColdStartReport(need: string, l1: number, l2: number): string {
  return [
    '# 冷启动报告（未达迭代门槛）',
    '',
    need,
    '',
    `- L1 人工反馈：${l1} 条`,
    `- L2 debate 修复案例：${l2} 条`,
    '',
    '冷启动门槛（spec §4.4）：L1>=50 或 L1+L2>=80。达标前只建 harness，不跑自动迭代。',
    '人审闸门不变：自动迭代只产报告，不改任何 persona。',
    '',
  ].join('\n')
}

/** mock 固定变异（brief 行为规格 2）：零 LLM 的确定性候选。 */
function mockCandidate(): PersonaCandidate {
  const rand = Math.random().toString(36).slice(2, 10)
  return {
    id: `cand_${Date.now()}_${rand}`,
    diff: 'mock diff',
    rationale: 'mock',
    targetsFailures: ['mock'],
  }
}

/** mock 固定评分（brief 行为规格 2）：incumbent=70 / candidate=82，规则全过。 */
function mockRunWith(candidateId: string) {
  return async () => ({
    judgeScore: candidateId === 'incumbent' ? 70 : 82,
    rulePass: true,
  })
}

/** 纯迭代编排：评测集 → 变异候选 → 配对评测 → 报告落盘。无冷启动闸门（CLI --force 直达）。 */
export async function runIterations(opts: LoopOptions, deps: LoopDeps = {}): Promise<LoopResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const currentPersona = readFileSync(opts.personaFile, 'utf8')

  const all = await loadEvalset(opts.dbPath, opts.target)
  const evalset = all.slice(0, limit)

  let candidate: PersonaCandidate
  let report: CandidateReport

  if (opts.mode === 'mock') {
    candidate = mockCandidate()
    report = await evaluateCandidate({ candidate, evalset, runWith: mockRunWith(candidate.id) })
  } else {
    // live：provider 走 createSubagentCriticProvider 同款 subagent 装配（宿主注入）；
    // runWith 调 runStage 真管线（按 case.input 走 author 管线取 judge 分与规则通过）。
    // 离线 CLI 进程没有 agent 上下文，装配必须由宿主侧完成后经 deps 注入。
    if (!deps.provider || !deps.runWith) {
      throw new Error(
        'live 模式需要注入 provider 与 runWith（agent 上下文装配：createSubagentCriticProvider + runStage 管线）；离线 CLI 不支持 live',
      )
    }
    const negatives = evalset.filter((c) => c.humanRating !== undefined && c.humanRating <= 2)
    candidate = await proposeMutation({
      negativeCases: negatives,
      debates: [],
      currentPersona,
      provider: deps.provider,
    })
    report = await evaluateCandidate({ candidate, evalset, runWith: deps.runWith })
  }

  // 人审闸门：报告必须让审阅者看到改了什么——评测表后附变异 diff/rationale 全文
  const markdown = [
    renderMarkdown([report]),
    '## 变异候选明细',
    '',
    `- 候选 id：${candidate.id}`,
    `- 针对失败模式：${candidate.targetsFailures.join(', ') || '（无）'}`,
    '',
    '### rationale',
    '',
    candidate.rationale,
    '',
    '### diff（仅提案，未生效——人审通过前不改任何 persona）',
    '',
    '```diff',
    candidate.diff,
    '```',
    '',
  ].join('\n')
  const reportPath = writeReport(opts.outDir, opts.target, markdown)
  return { ready: true, evalsetSize: all.length, candidateId: candidate.id, reportPath }
}

/** 冷启动闸门 + 迭代编排：未达标只产冷启动报告（不跑迭代）。 */
export async function runOptimizeLoop(opts: LoopOptions, deps: LoopDeps = {}): Promise<LoopResult> {
  const gate = await coldStartReady(opts.dbPath, opts.target)
  if (!gate.ready) {
    const reportPath = writeReport(
      opts.outDir,
      opts.target,
      renderColdStartReport(gate.need, gate.l1, gate.l2),
    )
    return { ready: false, evalsetSize: gate.l1 + gate.l2, reportPath }
  }
  return runIterations(opts, deps)
}
