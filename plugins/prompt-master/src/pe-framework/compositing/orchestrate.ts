/**
 * compositing 编排器（spec §2/§8，2026-09-15 管线重设计）：
 * S1 产物（语义蓝图 v0）→ S2 扩写 → S2.5 检索包 → S3 成文 → S4 双轨审核 → S5 窄修复（≤2）。
 * 依赖全部注入（enrich/writer runner、critic、search、vectorSim）——本模块零 host 依赖、可全 mock 测试。
 * 失败语义：writer 失败/耗尽 → deterministicCompose 回退（D7 fail-open，永不空手出稿）；
 * judge 故障 → skipped 降级（审计门独立成立）；blueprint/扩写产物对修复轮冻结（D4）。
 */
import { createHash } from 'node:crypto'
import { runSemanticEnrich } from './enrich.js'
import { buildWriterPrompt, parseWriterOutput, type WriterOutput } from './writer.js'
import { auditCompositing, type CompositingGate } from './audit.js'
import { assemblePositive, assembleNegative, deterministicCompose } from './compose.js'
import { buildRetrievalPack, type CatalogSearchFn, type RetrievalPack } from '../dialect/retrieval-pack.js'
import { buildCompositingJudgePrompt, COMPOSITING_RUBRIC_IDS } from '../eval/rubrics/compositing.js'
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'
import type { Rating } from '../types.js'

export interface CompositingJudgeResult {
  verdict: 'pass' | 'needs_revision'
  score: number
  findings: Array<{ severity: string; dimension: string; problem: string; requiredFix: string }>
  debate: Array<{ round: number; reviewer: { findings: unknown[]; score: number } }>
}

export interface CompositingDeps {
  /** S2 扩写 runner（pm-enrich 子代理）；缺省 → enrich_skipped 降级 */
  enrichRunner?: (taskText: string) => Promise<string>
  /** S3 成文 runner（pm-writer 子代理）；缺省 → 立即回退 deterministicCompose */
  writerRunner?: (taskText: string) => Promise<string>
  /** S4 评审（pm-critic CriticProvider）；缺省（judge_mode=off 或 judge 故障注入失败）→ 仅审计门 */
  critic?: (req: { persona: string; schema: string; user: string }) => Promise<string>
  /** S2.5 catalog 级联检索 */
  search: CatalogSearchFn
  /** audit P4b：检索前批量预热语义查询向量（catalog 层做同步命中过滤）；缺省 → 各查询单条嵌入 */
  retrievalPrewarm?: (queries: string[]) => Promise<void>
  /** bge-base-en-v1.5 相似度注入点（NL 句 × tag）；缺省 → 审计仅词面 + overlap_vector_unavailable */
  vectorSim?: (a: string, b: string) => number | undefined
  /** audit P1：审计前预热向量缓存（嵌入异步而审计同步，故拆两半）；缺省/故障 → sim 对未缓存对 undefined */
  vectorPrewarm?: (nl: string, tags: string[]) => Promise<void>
}

export type CompositingQuality = 'passed' | 'degraded' | 'fallback'

export interface CompositingOutcome {
  ok: boolean
  /** audit P3：质量三态——调用方读此一键即知产品质量带，无需解析 advisories。ok 语义不变（D7） */
  quality: CompositingQuality
  positive: string
  negative: string
  gates: CompositingGate[]
  advisories: string[]
  corrections: number
  fallbackUsed: boolean
  unresolvedCount: number
  v1: SemanticBlueprint
  judge?: CompositingJudgeResult
  judgeFeedback: string[]
  trace: Array<{ name: 'semantic_enrich' | 'retrieval_pack' | 'writer_loop'; ms: number }>
}

export interface CompositingOpts {
  maxCorrections?: number
  /** 透传 auditCompositing（测试 fixture tag 数常小于预算下限；生产缺省 20） */
  minTags?: number
}

const normJsonLoose = (raw: string): string => {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw
}

async function runJudge(
  critic: NonNullable<CompositingDeps['critic']>,
  out: WriterOutput,
  v1: SemanticBlueprint,
  pack: RetrievalPack,
  previousFindings: string[],
): Promise<{ judge?: CompositingJudgeResult; judgeFeedback: string[]; advisories: string[] }> {
  const prompt = buildCompositingJudgePrompt(out, v1, pack, { previousFindings })
  let raw: string
  try {
    raw = await critic(prompt)
  } catch (e) {
    return { judgeFeedback: [], advisories: [`judge_skipped:critic_error:${(e as Error).message.slice(0, 120)}`] }
  }
  try {
    const parsed = JSON.parse(normJsonLoose(raw)) as Record<string, unknown>
    const verdict = parsed.verdict
    if (verdict !== 'pass' && verdict !== 'needs_revision') throw new Error('invalid verdict')
    const scores = parsed.dimensionScores as Record<string, unknown> | undefined
    if (!scores || !COMPOSITING_RUBRIC_IDS.every((id) => typeof scores[id] === 'number')) {
      throw new Error('invalid_dimensions')
    }
    const score = Math.round(
      COMPOSITING_RUBRIC_IDS.reduce((sum, id) => sum + (scores[id] as number), 0) / COMPOSITING_RUBRIC_IDS.length,
    )
    const rawFindings = Array.isArray(parsed.findings) ? (parsed.findings as Record<string, unknown>[]) : []
    const findings = rawFindings
      .filter((f) => typeof f.requiredFix === 'string' && (f.severity === 'major' || f.severity === 'minor' || f.severity === 'blocker'))
      .map((f) => ({
        severity: String(f.severity),
        dimension: String(f.dimension ?? ''),
        problem: String(f.problem ?? ''),
        requiredFix: String(f.requiredFix),
      }))
    const judge: CompositingJudgeResult = {
      verdict,
      score,
      findings,
      debate: [{ round: 1, reviewer: { findings: rawFindings, score } }],
    }
    const judgeFeedback = findings
      .filter((f) => f.severity === 'major' || f.severity === 'blocker')
      .map((f) => `[${f.severity}] ${f.requiredFix}`)
    return { judge, judgeFeedback, advisories: [] }
  } catch (e) {
    return { judgeFeedback: [], advisories: [`judge_skipped:${(e as Error).message.slice(0, 80)}`] }
  }
}

export async function orchestrateCompositing(
  v0: SemanticBlueprint,
  rating: Rating,
  deps: CompositingDeps,
  opts: CompositingOpts = {},
): Promise<CompositingOutcome> {
  const advisories: string[] = []
  const trace: Array<{ name: 'semantic_enrich' | 'retrieval_pack' | 'writer_loop'; ms: number }> = []
  const maxCorrections = opts.maxCorrections ?? 2

  // audit P1：审计前预热 nl_tag_overlap 向量缓存（嵌入异步、审计同步，接缝拆两半）。
  // 故障静默——未缓存对 sim=undefined，audit 自然落入词面路径。
  const prewarmOverlap = async (o: WriterOutput): Promise<void> => {
    if (!deps.vectorPrewarm) return
    try {
      await deps.vectorPrewarm(o.nl, o.tags.map((t) => t.text))
    } catch {
      /* prewarm 故障不阻塞审计 */
    }
  }

  // S2 扩写
  const tEnrich = performance.now()
  const enriched = await runSemanticEnrich(v0, { runner: deps.enrichRunner })
  advisories.push(...enriched.advisories)
  const v1 = enriched.v1
  trace.push({ name: 'semantic_enrich', ms: performance.now() - tEnrich })

  // S2.5 检索包（唯一 catalog 消费点）
  const tPack = performance.now()
  const pack = await buildRetrievalPack(v1, deps.search, {}, deps.retrievalPrewarm)
  trace.push({ name: 'retrieval_pack', ms: performance.now() - tPack })
  if (pack.evidence.length === 0 && pack.unresolved.length > 0) advisories.push('evidence_partial')
  if (pack.truncated.length > 0) advisories.push(`evidence_truncated:${pack.truncated.length}`)
  advisories.push(...(pack.advisories ?? []))

  const v1Hash = createHash('sha256').update(JSON.stringify(v1)).digest('hex')
  let corrections = 0
  let feedback: string | undefined
  let writerOut: WriterOutput | undefined
  let gates: CompositingGate[] = []
  let judge: CompositingJudgeResult | undefined
  let judgeFeedback: string[] = []
  let fallbackUsed = false
  let lastJudgeFindings: string[] = []
  const t0 = performance.now()

  while (true) {
    // S3 成文
    let raw: string | undefined
    if (deps.writerRunner) {
      try {
        raw = await deps.writerRunner(
          buildWriterPrompt(v1, pack, {
            feedback,
            frozenHash: corrections > 0 ? v1Hash : undefined,
          }),
        )
      } catch (e) {
        advisories.push(`writer_failed:${(e as Error).message.slice(0, 120)}`)
      }
    } else if (corrections === 0) {
      advisories.push('writer_fallback_used:no_runner')
    }

    let parsedOk = false
    if (raw !== undefined) {
      try {
        writerOut = parseWriterOutput(raw)
        parsedOk = true
      } catch (e) {
        advisories.push(`writer_parse_failed:${(e as Error).message.slice(0, 120)}`)
      }
    }
    if (!parsedOk) {
      // D7 fail-open：确定性回退出稿，闭环终止
      writerOut = deterministicCompose(v1, pack)
      fallbackUsed = true
      advisories.push('writer_fallback_used')
      await prewarmOverlap(writerOut)
      gates = auditCompositing(writerOut as WriterOutput, pack, v1, { vectorSim: deps.vectorSim, rating, ...(opts.minTags !== undefined ? { minTags: opts.minTags } : {}) })
      break
    }

    // S4 审计
    await prewarmOverlap(writerOut as WriterOutput)
    gates = auditCompositing(writerOut as WriterOutput, pack, v1, { vectorSim: deps.vectorSim, rating, ...(opts.minTags !== undefined ? { minTags: opts.minTags } : {}) })
    const critical = gates.filter((g) => g.severity === 'critical')

    // S4 judge（规则 critical 时跳审——沿 legacy rule_critical 语义）
    if (critical.length === 0 && deps.critic) {
      const j = await runJudge(deps.critic, writerOut as WriterOutput, v1, pack, lastJudgeFindings)
      advisories.push(...j.advisories)
      judge = j.judge
      judgeFeedback = j.judgeFeedback
      // audit P4a：本轮 major/blocker findings 传下轮 judge（去重指令由 prompt 携带）
      lastJudgeFindings = (j.judge?.findings ?? [])
        .filter((f) => f.severity === 'major' || f.severity === 'blocker')
        .map((f) => f.requiredFix)
    }

    const judgeFailed = judge?.verdict === 'needs_revision'
    if (critical.length === 0 && !judgeFailed) break
    if (corrections >= maxCorrections) {
      advisories.push('loop_exhausted:true')
      break
    }

    // S5 窄修复：feedback 只投 writer（蓝图/扩写冻结，D4）
    corrections++
    feedback = JSON.stringify({
      violations: gates
        .filter((g) => g.severity === 'critical' || g.severity === 'important')
        .map((g) => ({ rule: g.rule, evidence: g.detail, required_fix: g.detail })),
      judge_feedback: judgeFeedback,
      frozen: { blueprint_v1_hash: v1Hash },
    })
  }
  trace.push({ name: 'writer_loop', ms: performance.now() - t0 })

  // D7 fail-open（spec §7「任何情况下不空手出稿」）：耗尽/失败后仍含 critical →
  // 确定性回退出稿（真实会话 gen_1789521620450 实证：耗尽后 ok=false 且 result 被丢，违反 D7）
  const hasCritical = gates.some((g) => g.severity === 'critical')
  if (!fallbackUsed && hasCritical) {
    writerOut = deterministicCompose(v1, pack)
    fallbackUsed = true
    advisories.push('writer_fallback_used')
    await prewarmOverlap(writerOut)
    gates = auditCompositing(writerOut, pack, v1, { vectorSim: deps.vectorSim, rating, ...(opts.minTags !== undefined ? { minTags: opts.minTags } : {}) })
  }

  // ok 语义（legacy P3 对齐）：确定性审计全过 → ok=true（judge needs_revision 耗尽走 loop_exhausted
  // advisory，不丢 result）；回退通道 fail-open 恒 ok=true（产品已出，故事在 advisories/gates 里）
  const finalWriterOut = writerOut as WriterOutput // 循环不变式：break 前必已赋值（解析失败/耗尽走 fallback 分支）
  const ok = fallbackUsed ? true : gates.every((g) => g.severity !== 'critical')
  const positive = assemblePositive(finalWriterOut, rating)
  const negative = assembleNegative(finalWriterOut)

  return {
    ok,
    quality: fallbackUsed ? 'fallback' : corrections > 0 ? 'degraded' : 'passed',
    positive,
    negative,
    gates,
    advisories,
    corrections,
    fallbackUsed,
    unresolvedCount: pack.unresolved.length,
    v1,
    ...(judge !== undefined ? { judge } : {}),
    judgeFeedback,
    trace,
  }
}
