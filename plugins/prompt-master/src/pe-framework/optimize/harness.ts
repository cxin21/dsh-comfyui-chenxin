/**
 * 质量飞轮 §4.2-§4.4 scoring harness（离线纯函数层，M3 只建 harness 不跑迭代）。
 *
 * 离线铁律（spec §4.1）：本模块不被运行时管线 import、不注册 agent 工具——
 * 只被 Task 10 的离线迭代循环与手动回归使用。
 *
 * 组成：
 * - scoreGeneration：评分公式 0.5*judge + 0.3*rule + 0.2*human（无 human 归一 /0.8）
 * - loadEvalset：评测集三层加载（L1 人工反馈 / L2 debate 修复案例 / L3 golden 指针）
 * - coldStartReady：冷启动门槛（L1>=50 或 L1+L2>=80，spec §4.4）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getGeneration, listFeedback, listGenerations } from '../feedback/store.js'

export type EvalTier = 'L1' | 'L2' | 'L3'

export interface EvalCase {
  id: string
  tier: EvalTier
  input: string // 原始创作意图（重放 author 用）；store 只存 digest，L1/L2 恒为 ''
  target: 'anima' | 'h3'
  humanRating?: number // L1：1-5
  expectedDigest?: string // L3：golden 指针的 digest（可空）；L1/L2 取 input_digest
  sourceGenerationId?: string // L1/L2 溯源
  expected?: { findingsMustClose?: string[] } // L2：debate 中被 blocker 拦下后应关闭的要点
}

export interface ScoreInput {
  judgeScore: number
  rulePass: boolean
  humanRating?: number
}

// ---------- 评分公式（§4.2） ----------

/**
 * 0.5*judge + 0.3*rule + 0.2*human；rule 布尔转 100/0；无 human 时
 * (0.5*judge + 0.3*rule)/0.8 归一（权重归还前两项）。结果夹取 [0,100] 四舍五入整数。
 * humanRating 按 0-100 尺度原样加权（1-5 分制由调用方归一后传入）。
 */
export function scoreGeneration(m: ScoreInput): number {
  const ruleScore = m.rulePass ? 100 : 0
  const raw =
    m.humanRating === undefined
      ? (0.5 * m.judgeScore + 0.3 * ruleScore) / 0.8
      : 0.5 * m.judgeScore + 0.3 * ruleScore + 0.2 * m.humanRating
  return Math.round(Math.min(100, Math.max(0, raw)))
}

// ---------- 评测集三层加载（§4.2） ----------

const L1_CAP = 200
const L2_CAP = 100
const FEEDBACK_FETCH = 1000

/** L1：人工反馈反查——rating>=4（正例）与 <=2（负例）；孤儿行（无 generation）跳过。 */
function loadL1(dbPath: string, target: 'anima' | 'h3'): EvalCase[] {
  const rows = [
    ...listFeedback(dbPath, { target, min_rating: 4, limit: FEEDBACK_FETCH }),
    ...listFeedback(dbPath, { target, max_rating: 2, limit: FEEDBACK_FETCH }),
  ]
  // 同一 generation 多条反馈：取最新一条（UPSERT 语义下的最新人工判断）
  const byGen = new Map<string, { rating: number; feedbackAt: number }>()
  for (const r of rows) {
    const prev = byGen.get(r.generation_id)
    if (!prev || r.created_at > prev.feedbackAt) {
      byGen.set(r.generation_id, { rating: r.rating, feedbackAt: r.created_at })
    }
  }
  const collected: Array<{ c: EvalCase; createdAt: number }> = []
  for (const [gid, f] of byGen) {
    const g = getGeneration(dbPath, gid)
    if (!g) continue // 孤儿行：无 input 可重放，跳过
    collected.push({
      createdAt: g.created_at,
      c: {
        id: `l1-${gid}`,
        tier: 'L1',
        input: '', // store 隐私边界只存 digest，无原始 input；Task 10 重放时由调用方补
        target,
        humanRating: f.rating,
        sourceGenerationId: gid,
        expectedDigest: g.input_digest,
      },
    })
  }
  return collected
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, L1_CAP)
    .map((x) => x.c)
}

/** 从 debate_json 提取 blocker findings 的要点 id（应关闭清单），脏 JSON 静默跳过。 */
function blockerFindingIds(debateJson: string | undefined): string[] | undefined {
  if (!debateJson) return undefined
  try {
    const parsed: unknown = JSON.parse(debateJson)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const findings = (parsed as { findings?: unknown }).findings
    if (!Array.isArray(findings)) return undefined
    const ids = findings
      .filter(
        (f): f is { severity: string; id: string } =>
          f !== null &&
          typeof f === 'object' &&
          (f as { severity?: unknown }).severity === 'blocker' &&
          typeof (f as { id?: unknown }).id === 'string',
      )
      .map((f) => f.id)
    return ids.length ? ids : undefined
  } catch {
    return undefined
  }
}

/** L2：debate 中被 blocker 拦下并修复成功的案例——needs_revision 且 repair_rounds>=1。
 *  generations 表只记最终出稿成功的记录（recordGeneration 在出稿后写入），无需再过滤。 */
function loadL2(dbPath: string, target: 'anima' | 'h3'): EvalCase[] {
  const rows = listGenerations(dbPath, {
    target,
    judge_verdict: 'needs_revision',
    min_repair_rounds: 1,
    limit: L2_CAP,
  })
  return rows.map((g) => {
    const mustClose = blockerFindingIds(g.debate_json)
    return {
      id: `l2-${g.id}`,
      tier: 'L2' as const,
      input: '',
      target,
      sourceGenerationId: g.id,
      expectedDigest: g.input_digest,
      ...(mustClose ? { expected: { findingsMustClose: mustClose } } : {}),
    }
  })
}

/** L3：goldenDir 下 *author* 相关 fixture 文件名扫描（前缀 `<target>-` 的 .json）。
 *  只做 readdir + 文件名过滤 + 读 input/sha256 字段；fixture 无 input 概念时
 *  input='' 占位（调用方跳过重放）。脏 JSON 按无字段处理。 */
function loadL3(goldenDir: string, target: 'anima' | 'h3'): EvalCase[] {
  if (!existsSync(goldenDir)) return []
  const prefix = target + '-'
  const files = readdirSync(goldenDir)
    .filter((f) => f.endsWith('.json') && f.startsWith(prefix))
    .sort()
  return files.map((f) => {
    const id = f.replace(/\.json$/, '')
    let input = ''
    let expectedDigest: string | undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        if (typeof obj.input === 'string') input = obj.input
        if (typeof obj.sha256 === 'string') expectedDigest = obj.sha256
      }
    } catch {
      // 脏 JSON：按无 input / 无 digest 处理，不让单文件毁掉整层
    }
    return { id, tier: 'L3' as const, input, target, expectedDigest }
  })
}

/** 三层合并：L1 前 200、L2 前 100、L3 全量（层内按 created_at 降序；L3 按文件名稳定排序）。 */
export async function loadEvalset(
  dbPath: string,
  target: 'anima' | 'h3',
  goldenDir?: string,
): Promise<EvalCase[]> {
  return [...loadL1(dbPath, target), ...loadL2(dbPath, target), ...loadL3(goldenDir ?? '', target)]
}

// ---------- 冷启动门槛（§4.4） ----------

/** L1>=50 条（或 L1+L2>=80 条）才启动自动迭代；此前只建 harness。 */
export async function coldStartReady(
  dbPath: string,
  target: 'anima' | 'h3',
): Promise<{ ready: boolean; l1: number; l2: number; need: string }> {
  const cases = await loadEvalset(dbPath, target)
  const l1 = cases.filter((c) => c.tier === 'L1').length
  const l2 = cases.filter((c) => c.tier === 'L2').length
  const ready = l1 >= 50 || l1 + l2 >= 80
  const need = ready
    ? ''
    : `冷启动未达标：当前 L1 人工反馈 ${l1} 条（门槛 50）、L1+L2 合计 ${l1 + l2} 条（门槛 80），满足任一门槛即可启动自动迭代`
  return { ready, l1, l2, need }
}
