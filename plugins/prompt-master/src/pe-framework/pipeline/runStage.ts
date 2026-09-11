import { getDialect } from '../dialect/registry.js'
import type { AuditGate, Budget } from '../types.js'
import { targetSlotHint } from '../render/envelope.js'
import type { CriticFinding, CriticOutcome } from '../eval/critic.js'
import { judgeReview } from '../eval/critic.js'
import { createEvidenceBridge } from '../eval/evidence.js'
import type { DebateRound, PipelineInput, PipelineTrace, StageResult, CriticRebuttal } from './types.js'

/**
 * 唯一管线内核：按注册表调度，零目标业务分支、零日志。
 * normalize error / auditOnly 不兼容 → throw（可读错误）；方言未注册 → 失败 StageResult。
 *
 * Task 5（spec §2.3/§2.4/§2.5）：judge 缺省 'off'——off / 无 rubric 方言 / 未注册 target
 * 保持同步返回且逐字段与旧版本一致（provider 零调用）；judge=fast/strict 时异步追加评审阶段。
 */

/** judge=off / 无 rubric 时同步返回 StageResult（旧签名兼容：既有调用方零改动） */
export function runStage(input: Omit<PipelineInput, 'judge'> & { judge?: 'off' | undefined }): StageResult
/** judge=fast/strict 时返回 Promise<StageResult>（Task 6 消费） */
export function runStage(input: Omit<PipelineInput, 'judge'> & { judge?: 'fast' | 'strict' }): Promise<StageResult>
export function runStage(input: PipelineInput): StageResult | Promise<StageResult> {
  const d = getDialect(input.target)
  if (!d) {
    const gate: AuditGate = {
      rule: 'dialect_not_available',
      target: input.target,
      severity: 'critical',
      detail: `方言 ${input.target} 未注册（请以 registerDialect 装配）`,
      source: 'pipeline/runStage',
    }
    return {
      ok: false,
      result: {},
      gates: [gate],
      advisories: [],
      assumptions: [],
      targetSlotHint: targetSlotHint(input.target),
    }
  }

  const t0 = performance.now()
  const auditOnly = input.auditOnly === true
  if (auditOnly && !d.auditOnlyOk) {
    throw new Error(`target ${input.target} 不支持 auditOnly`)
  }

  const normalized = d.normalize(
    { target: input.target, slots: input.slots, variant: input.variant, shots: input.shots, stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields, auditOnly },
    { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields },
  )
  const tSchema = performance.now()
  if (normalized.error !== undefined) throw new Error(normalized.error)
  const slots = normalized.value
  // normalize 单点推断的 stage（h3: references/full_reference → ref2va）优先于显式输入（Task 6：工具侧 inferH3Stage 已删）
  const stage = normalized.stage ?? input.stage

  const compiled = d.compile(slots as never, { variant: input.variant, stage })
  const tDialect = performance.now()

  const audit = d.audit(compiled as never, { stage, references: normalized.references, shots: normalized.value ?? input.shots, variant: input.variant })
  const tAudit = performance.now()

  const budgetRaw = d.budget?.(compiled as never, { stage, references: normalized.references })
  const tBudget = performance.now()

  const ok = audit.gates.every((g) => g.severity !== 'critical')
  const result: Record<string, unknown> = auditOnly ? {} : (compiled as Record<string, unknown>)

  const renderMs = 0
  const stages: PipelineTrace['stages'] = [
    { name: 'schema', ms: tSchema - t0 },
    { name: 'dialect', ms: tDialect - tSchema },
    { name: 'audit', ms: tAudit - tDialect },
    ...(budgetRaw !== undefined ? [{ name: 'budget' as const, ms: tBudget - tAudit }] : []),
    { name: 'render', ms: renderMs },
  ]
  const trace: PipelineTrace = { stages }

  const base: StageResult = {
    ok,
    result,
    gates: audit.gates,
    advisories: [],
    assumptions: audit.assumptions ?? [],
    ...(budgetRaw !== undefined ? { budget: budgetRaw as Budget } : {}),
    targetSlotHint: d.targetSlotHint,
    trace,
  }

  const judgeMode = input.judge ?? 'off'
  const rubric = d.rubric
  if (judgeMode === 'off' || !rubric) return base
  return runJudgeStage(input, judgeMode, base, { d, compiled, normalized, stage, auditOnly })
}

/* ── Task 5：评审阶段（spec §2.3 fast / §2.4 strict / §2.5 降级铁律） ── */

type DialectLike = NonNullable<ReturnType<typeof getDialect>>

function reviewerOf(outcome: Extract<CriticOutcome, { verdict: string }>): DebateRound['reviewer'] {
  return { findings: outcome.findings as CriticFinding[], score: outcome.score }
}

/** rebuttals 从修正稿解析：优先 rev.rebuttals，其次 revisionNote 内嵌 JSON，缺失 → 空数组 */
function parseRebuttals(rev: { compiled: unknown; changes: string[]; revisionNote: string }): CriticRebuttal[] {
  const isRebuttal = (v: unknown): v is CriticRebuttal => {
    const o = v as Record<string, unknown> | null
    return typeof o === 'object' && o !== null
      && typeof o['finding_id'] === 'string' && o['finding_id'].length > 0
      && typeof o['rebuttal'] === 'string' && o['rebuttal'].length > 0
      && typeof o['evidence'] === 'string' && o['evidence'].length > 0
  }
  const pick = (v: unknown): CriticRebuttal[] => (Array.isArray(v) ? v.filter(isRebuttal) : [])
  const direct = pick((rev as { rebuttals?: unknown }).rebuttals)
  if (direct.length > 0) return direct
  try {
    return pick((JSON.parse(rev.revisionNote) as { rebuttals?: unknown })?.rebuttals)
  } catch {
    return []
  }
}

async function runJudgeStage(
  input: PipelineInput,
  judgeMode: 'fast' | 'strict',
  base: StageResult,
  ctx: { d: DialectLike; compiled: unknown; normalized: ReturnType<DialectLike['normalize']>; stage?: string; auditOnly: boolean },
): Promise<StageResult> {
  const { d, compiled, normalized, stage, auditOnly } = ctx
  const rubric = d.rubric!
  const tJudge0 = performance.now()
  const advisories = [...base.advisories]

  // 证据工具部分缺省（含整个 evidenceDeps 未传）→ advisory（bridge 自动剔除不可用键）
  if (!input.evidenceDeps || rubric.evidenceTools.some((t) => typeof input.evidenceDeps![t] !== 'function')) {
    advisories.push('evidence_partial')
  }
  const bridge = createEvidenceBridge({
    target: input.target as 'anima' | 'h3',
    available: rubric.evidenceTools,
    deps: input.evidenceDeps ?? {},
  })

  const auditCtx = { stage, references: normalized.references, shots: normalized.value ?? input.shots, variant: input.variant }
  let gates = base.gates
  let compiledCur = compiled
  let resultCur = base.result
  let assumptions = base.assumptions
  let budget = base.budget

  const finish = (judge: CriticOutcome, debate: DebateRound[], judgeFeedback?: string[]): StageResult => {
    const ok = gates.every((g) => g.severity !== 'critical')
    return {
      ok,
      result: resultCur,
      gates,
      advisories,
      assumptions,
      ...(budget !== undefined ? { budget } : {}),
      targetSlotHint: base.targetSlotHint,
      trace: { stages: [...(base.trace?.stages ?? []), { name: 'judge' as const, ms: performance.now() - tJudge0 }] },
      judge,
      ...(debate.length > 0 ? { debate } : {}),
      ...(judgeFeedback !== undefined ? { judgeFeedback } : {}),
    }
  }

  // 分支6补充：规则审计 critical → 跳过评审（管线层不得先调 provider），交现有修正闭环
  if (gates.some((g) => g.severity === 'critical')) {
    return finish({ skipped: true, reason: 'rule_critical' }, [])
  }

  const provider = input.criticProvider
    ?? (async () => { throw new Error('criticProvider 未注入') })
  const review = (opts: { compiled: unknown; ruleGates: typeof gates; firstFindings?: CriticFinding[]; revisionNote?: string; revision?: boolean }) =>
    judgeReview({
      target: input.target as 'anima' | 'h3',
      rubric,
      bridge,
      originalIntent: input.originalIntent ?? '',
      provider,
      stage: opts.revision === true ? 'revision' : 'first',
      ...opts,
    })

  const debate: DebateRound[] = []

  /** A1（spec §10.1-A1 规格5）：评审回查未验证 → evidence_unverified advisory 透传（不重复 push） */
  const noteUnverified = (o: CriticOutcome): void => {
    if (!('skipped' in o) && o.evidenceUnverified === true && !advisories.includes('evidence_unverified')) {
      advisories.push('evidence_unverified')
    }
  }

  // 首评
  let outcome: CriticOutcome = await review({ compiled: compiledCur, ruleGates: gates })
  if ('skipped' in outcome) {
    // 分支4：任何评审故障 → skipped + advisory，照常出稿（spec §2.5）
    advisories.push('judge_skipped')
    return finish(outcome, [])
  }
  debate.push({ round: 1, reviewer: reviewerOf(outcome) })
  noteUnverified(outcome)

  const revisionProvider = judgeMode === 'strict' ? input.revisionProvider : undefined

  // 分支5/6：strict 且首评 needs_revision → 一轮修正稿 + revision 复审（深层循环属调用方现有闭环）
  if (outcome.verdict === 'needs_revision') {
    // strict 缺修正稿生产者 → 退化为 fast；仅在实际需要修正时标注（首评 pass 不追加噪音）
    if (judgeMode === 'strict' && !revisionProvider) advisories.push('strict_degraded')
  }
  if (outcome.verdict === 'needs_revision' && revisionProvider) {
    const firstFindings = outcome.findings as CriticFinding[]
    const rev = await revisionProvider(compiledCur, firstFindings)
    compiledCur = rev.compiled
    const audit2 = d.audit(compiledCur as never, auditCtx)
    gates = audit2.gates
    assumptions = audit2.assumptions ?? assumptions
    const budget2 = d.budget?.(compiledCur as never, { stage, references: normalized.references })
    if (budget2 !== undefined) budget = budget2 as Budget
    resultCur = auditOnly ? {} : (compiledCur as Record<string, unknown>)

    const reviser = { changes: rev.changes, rebuttals: parseRebuttals(rev) }
    const second = await review({
      compiled: compiledCur,
      ruleGates: gates,
      firstFindings,
      revisionNote: rev.revisionNote, // T3 carry：strict 复审必须传 revisionNote
      revision: true,
    })
    if ('skipped' in second) {
      // final review I1：复审 skipped → round 2 整轮不 push（0 分 reviewer 是编造数据，
      // 会污染 debate 语料）；只留 judge_skipped advisory + round1 记录，消费方零改动。
      advisories.push('judge_skipped')
      return finish(second, debate)
    }
    debate.push({ round: 2, reviewer: reviewerOf(second), reviser })
    noteUnverified(second)
    outcome = second
  }

  // 分支3/6：needs_revision 终态 → findings 转 feedback 交调用方现有修正闭环（max 2 / loop_exhausted 语义不变）
  const judgeFeedback = outcome.verdict === 'needs_revision'
    ? outcome.findings.map((f) => `[${f.severity}] ${f.requiredFix}`)
    : undefined

  return finish(outcome, debate, judgeFeedback)
}
