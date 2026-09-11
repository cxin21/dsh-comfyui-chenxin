/**
 * EvidenceCritic 证据化评审器（spec §2.1）：旧 eval/judge.ts（llm/complete HTTP 直连）的替代者。
 *
 * 设计：
 * - 评审 LLM 通过 CriticProvider 注入（Task 5 用 createSubagentCriticProvider 装配，测试用 mock）；
 * - persona 由 rubric.dimensions[].instruction + severityRules 拼接；schema 为 CriticOutcome JSON Schema
 *   （dimension 枚举注入 rubric.dimensions[].id）；user 携带 compiled + originalIntent（revision 时另带
 *   首轮 findings 与修正说明）。
 *
 * 降级铁律（spec §2.5）：本模块任何故障路径都返回 { skipped: true, reason }，绝不抛出。
 */
import type { DialectRubric } from './rubrics/contract.js'
import type { EvidenceBridge, EvidenceResult, EvidenceToolId } from './evidence.js'
import type { AuditGate } from '../types.js'

export type CriticFinding = {
  /** 首轮内稳定编号 f1…fN（LLM 不产 id，parse 后由代码编号；复审/rebuttal/回查引用此 id） */
  id: string
  severity: 'blocker' | 'major' | 'minor'
  dimension: string
  problem: string
  /** evidenceOptional 维度的 finding 可无证据（此时带 evidenceAssumed: true）；verified 由回查复核写入 */
  evidence?: { tool: string; query: string; result: string; verified?: boolean }
  requiredFix: string
  /** 证据可选维度放行标记（spec §10.2-A5；bridge 缺工具的维度自动获得，spec §10.1-A1 规格7） */
  evidenceAssumed?: boolean
}

export type CriticOutcome =
  | { verdict: 'pass' | 'needs_revision'; score: number; findings: CriticFinding[]; praise: string[]; /** 回查未能执行/执行失败：findings 未经验证（runStage 转 evidence_unverified advisory；spec §10.1-A1 规格5） */ evidenceUnverified?: boolean }
  | { skipped: true; reason: string }

/** 评审 LLM 注入点：Task 5 用 subagent seam 装配，测试用 mock */
export type CriticProvider = (req: { persona: string; schema: string; user: string }) => Promise<string>

export type CriticStage = 'first' | 'revision'

export interface JudgeReviewInput {
  target: 'anima' | 'h3'
  rubric: DialectRubric
  /** 可选（spec §10.1-A1 规格8）：未传 = 跳过证据回查（findings 全保留 + evidenceUnverified 标志），既有 off 评审调用方零改动 */
  bridge?: EvidenceBridge
  compiled: unknown
  ruleGates: AuditGate[]
  originalIntent: string
  provider: CriticProvider
  stage?: CriticStage
  /** stage='revision' 必带 */
  firstFindings?: CriticFinding[]
  /** stage='revision' 时由调用方（Task 5 装配）传入修正说明 */
  revisionNote?: string
}

/* ── stripFences（自 eval/judge.ts 抄，纯函数） ── */

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

function skipped(reason: string): CriticOutcome {
  return { skipped: true, reason }
}

/** bridge 工具列表安全读取：bridge 未传或 list 抛错 → null（= bridge 整体不可用，spec §10.1-A1 规格5） */
function bridgeToolsOf(bridge: EvidenceBridge | undefined): EvidenceToolId[] | null {
  if (bridge === undefined) return null
  try {
    return bridge.list()
  } catch {
    return null
  }
}

/* ── A1 关键词交集判定（spec §10.5）：两侧各取 ≥2 字符的词/词元集合（规范化小写），交集非空即通过 ── */

function tokensOf(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of s.toLowerCase().matchAll(/[a-z0-9\u4e00-\u9fff\u3040-\u30ff\uff66-\uff9f]+/g)) {
    const run = m[0]
    if (/[a-z0-9]/.test(run[0]) && /[a-z0-9]/.test(run[run.length - 1])) {
      if (run.length >= 2) out.add(run)
    } else {
      // CJK/假名连串：无空格分词 → 以 2 字符词元（bigram）为最小单元，单字符不成词元
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
    }
  }
  return out
}

function evidenceIntersects(summary: string, claimed: string): boolean {
  const a = tokensOf(summary)
  for (const t of tokensOf(claimed)) {
    if (a.has(t)) return true
  }
  return false
}

/**
 * 证据铁律过滤（spec §10.2-A5 + §10.1-A1 规格7）：evidence 三键（tool/query/result）任一缺失（含空串）
 * 的 finding 丢弃；例外放行（加 evidenceAssumed: true）：
 * - finding.dimension 对应维度 evidenceOptional===true；
 * - bridge 缺 rubric 声明的某工具（available 集合不含）→ 声明该工具的维度自动视为 evidenceOptional；
 * - finding 携带 evidence 但其 tool 不在 available 集合 → 放行（无工具可回查，不因无法验证而丢弃）。
 * 返回 null 表示该 finding 无效（丢弃）。首个有效 id 由调用方在过滤后统一编号。
 */
function toValidFinding(f: unknown, rubric: DialectRubric, available: ReadonlySet<EvidenceToolId>): CriticFinding | null {
  const ev = (f as { evidence?: unknown })?.evidence
  if (typeof ev === 'object' && ev !== null) {
    const e = ev as Record<string, unknown>
    if (typeof e['tool'] === 'string' && e['tool'].length > 0
      && typeof e['query'] === 'string' && e['query'].length > 0
      && typeof e['result'] === 'string' && e['result'].length > 0) {
      if (!available.has(e['tool'] as EvidenceToolId)) {
        return { ...(f as CriticFinding), evidenceAssumed: true }
      }
      return { ...(f as CriticFinding) }
    }
  }
  const dim = (f as { dimension?: unknown })?.dimension
  const dimDef = typeof dim === 'string' ? rubric.dimensions.find((d) => d.id === dim) : undefined
  const bridgeMissingTool = rubric.evidenceTools.some((t) => !available.has(t))
  if (dimDef?.evidenceOptional === true || bridgeMissingTool) {
    return { ...(f as CriticFinding), evidenceAssumed: true }
  }
  return null
}

/** schema 级校验：形状不合 → null（调用方转 skipped）。 */
function parseOutcome(raw: string): { verdict: 'pass' | 'needs_revision'; dimensionScores: unknown; findings: unknown[]; praise: string[] } | null {
  let obj: any
  try {
    obj = JSON.parse(stripFences(raw))
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  if (obj.verdict !== 'pass' && obj.verdict !== 'needs_revision') return null
  if (!Array.isArray(obj.findings)) return null
  const praise = Array.isArray(obj.praise) ? obj.praise.filter((p: unknown): p is string => typeof p === 'string') : []
  return { verdict: obj.verdict, dimensionScores: obj.dimensionScores, findings: obj.findings, praise }
}

/**
 * A6 维度分校验：dimensionScores 必须覆盖 rubric 全维度（多/缺/非 0-100 有限数 → null，调用方 skipped
 * reason=invalid_dimensions）。总分单数字 score 字段已废弃，LLM 不再产。
 */
function dimensionScoresOf(raw: unknown, rubric: DialectRubric): Record<string, number> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (Object.keys(obj).length !== rubric.dimensions.length) return null
  const out: Record<string, number> = {}
  for (const d of rubric.dimensions) {
    const v = obj[d.id]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return null
    out[d.id] = v
  }
  return out
}

function buildPersona(rubric: DialectRubric): string {
  const dims = rubric.dimensions
    .map((d) => `- [${d.id}] ${d.instruction}${d.evidenceOptional === true ? '（证据可选：该维度 finding 无证据也可输出）' : ''}`)
    .join('\n')
  return [
    '你是一位资深的提示词质量评审评委（EvidenceCritic）。',
    '对给定「编译产物 + 用户原意」按以下维度逐条评审：',
    dims,
    '',
    '严重度判定标准：',
    rubric.severityRules,
    '',
    '打分要求：对上述每个维度各给一个 0-100 的维度分（dimensionScores，全维度必填）。',
    '铁律：每条 finding 必须附带 evidence 三键 {tool, query, result}——tool 是你实际调用过的证据工具名，',
    'query 是查询串，result 是证据摘要。没有证据的 finding 一律不要输出；标注「证据可选」的维度例外。',
    '输出：只输出一个 JSON（可带 ```json fence），形状见 schema；不要任何额外文字或解释。',
  ].join('\n')
}

function buildSchema(rubric: DialectRubric): string {
  const ids = rubric.dimensions.map((d) => JSON.stringify(d.id)).join(', ')
  const dimScoreLines = rubric.dimensions.map((d) => `    ${JSON.stringify(d.id)}: 0-100`).join(',\n')
  return `{
  "verdict": "pass" | "needs_revision",
  "dimensionScores": {
${dimScoreLines}
  },
  "findings": [
    {
      "severity": "blocker" | "major" | "minor",
      "dimension": ${ids},
      "problem": "问题描述",
      "evidence": { "tool": "catalog|tokenizer|aesthetics", "query": "查询串", "result": "证据摘要" },
      "requiredFix": "必须执行的修正"
    }
  ],
  "praise": ["做得好的点", ...]
}`
}

function buildUser(input: JudgeReviewInput): string {
  // bridge 未传 / list 抛错（整体不可用）→ 工具列表空（不阻断 provider 调用；回查阶段再标 evidenceUnverified）
  const tools = bridgeToolsOf(input.bridge)
  const parts: string[] = [
    `target=${input.target}`,
    '',
    '编译产物：',
    JSON.stringify(input.compiled),
    '',
    `用户原意：${input.originalIntent}`,
    '',
    `可用证据工具：${(tools ?? []).join(', ') || '（无）'}`,
  ]
  if (input.stage === 'revision') {
    const note = typeof input.revisionNote === 'string' && input.revisionNote.trim().length > 0
      ? input.revisionNote
      : '未提供'
    parts.push(
      '',
      '## revision 轮：以下是首轮评审 findings 与本轮修正说明，请核对首轮问题是否已解决，并按同一 schema 重新评审。',
      `修正说明：${note}`,
      '首轮 findings：',
      JSON.stringify(input.firstFindings ?? []),
    )
  }
  return parts.join('\n')
}

/** 评审 LLM 装配说明：createSubagentCriticProvider 见文件尾部（Task 5 装配用）。 */

export async function judgeReview(input: JudgeReviewInput): Promise<CriticOutcome> {
  try {
    // 规格 1：规则审计 critical 短路——provider 零调用
    if (input.ruleGates.some((g) => g?.severity === 'critical')) {
      return skipped('rule_critical')
    }

    const req = {
      persona: buildPersona(input.rubric),
      schema: buildSchema(input.rubric),
      user: buildUser(input),
    }
    const raw = await input.provider(req)

    // 规格 5：schema 不合 / parse 失败 → skipped；A6 维度分缺失/多出/非法 → skipped invalid_dimensions
    const parsed = parseOutcome(raw)
    if (!parsed) return skipped('invalid_schema_or_parse')
    const dimScores = dimensionScoresOf(parsed.dimensionScores, input.rubric)
    if (!dimScores) return skipped('invalid_dimensions')

    // A6：score = Math.round(Σ weight × dimScore)，由代码计算（LLM 只产维度分）
    const score = Math.round(
      input.rubric.dimensions.reduce((sum, d) => sum + d.weight * dimScores[d.id], 0),
    )

    // 证据铁律（含 A5 evidenceOptional 放行）→ 有效 findings 按序编号 f1…fN
    let findings = parsed.findings
      .map((f) => toValidFinding(f, input.rubric, new Set(bridgeToolsOf(input.bridge) ?? [])))
      .filter((f): f is CriticFinding => f !== null)
      .map((f, i) => ({ ...f, id: `f${i + 1}` }))

    // A1 证据回查复核（spec §10.1-A1）：发生在归一（规格3/规格4）之前。
    // 对每条携带 evidence 且非 evidenceAssumed 的 finding 调 bridge.query(tool, query)：
    // ok=false → 丢；summary 与声称 result 实词交集为空（编造）→ 丢；命中 → evidence.verified=true。
    // 单条 query 抛错 → 保留 + evidenceUnverified 全局标志；bridge 整体不可用（未传/list 抛错）→
    // 跳过全部回查，findings 全保留 + evidenceUnverified。
    let evidenceUnverified = false
    if (bridgeToolsOf(input.bridge) === null) {
      evidenceUnverified = true
    } else {
      const kept: CriticFinding[] = []
      for (const f of findings) {
        if (f.evidence === undefined || f.evidenceAssumed === true) {
          kept.push(f)
          continue
        }
        let res: EvidenceResult
        try {
          res = await input.bridge!.query(f.evidence.tool as EvidenceToolId, f.evidence.query)
        } catch {
          evidenceUnverified = true
          kept.push(f)
          continue
        }
        if (!res.ok) continue
        if (!evidenceIntersects(res.summary, f.evidence.result)) continue
        kept.push({ ...f, evidence: { ...f.evidence, verified: true } })
      }
      findings = kept
    }

    // 规格 3（防御归一）：只作用于 LLM 原生 verdict=pass——pass 但加权分 < passThreshold 或含 blocker → needs_revision
    let verdict = parsed.verdict
    const hasBlocker = findings.some((f) => f.severity === 'blocker')
    if (verdict === 'pass' && (score < input.rubric.passThreshold || hasBlocker)) {
      verdict = 'needs_revision'
    }

    // 规格 4（证据铁律，终局）：缺 evidence 三键任一的条目丢弃；
    // 全丢后 findings 为空且 verdict 是 needs_revision → 改判 pass（无有效证据不得打回）。
    // 终局生效：对 LLM 原生 pass / needs_revision（含规格 3 改判）都适用，其后不再有改判。
    if (verdict === 'needs_revision' && findings.length === 0) {
      verdict = 'pass'
    }

    return {
      verdict,
      score,
      findings,
      praise: parsed.praise,
      ...(evidenceUnverified ? { evidenceUnverified: true as const } : {}),
    }
  } catch (err) {
    return skipped(`critic_error:${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}`)
  }
}

/* ── Task 5 装配：用 ctx.subagents.start 装 CriticProvider ── */

/** DSH 0.1.2 one-shot subagent run 的鸭子类型（与 intent/subagent-provider.ts 同款）。 */
interface SubagentLikeRun {
  id: string
  result: Promise<{
    output: Array<{ type: string; text?: string }>
    stopReason: string
    diagnostic?: string
  }>
  dispose: () => Promise<unknown> | unknown
}

/**
 * 用 ctx.subagents.start 装 CriticProvider（模式对齐 intent/subagent-provider.ts 的
 * createSubagentIntentProvider：one-shot run + persona/schema 前缀 + 解析 text + run.dispose +
 * 超时 AbortController）。persona/schema/user 三段由 judgeReview 构造后整体传入。
 * ctx 不可用/抛错由调用方 catch 后走 skipped 降级。
 */
export function createSubagentCriticProvider(ownerCtx: any, opts?: { timeoutMs?: number }): CriticProvider {
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const providerName = 'spawn'

  return async function subagentCritic(req: { persona: string; schema: string; user: string }): Promise<string> {
    if (!ownerCtx?.subagents?.start) {
      throw new Error('SubagentCriticProvider 不可用：ctx.subagents 未注册（plugin 未注入 "subagents"）')
    }
    const taskText = [
      req.persona,
      '',
      '输出 JSON Schema:',
      req.schema,
      '',
      req.user,
      '',
      '现在按上述 persona + schema 产出 JSON。仅输出 JSON 对象，不要任何额外文字或 markdown fence。',
    ].join('\n')

    const controller = new AbortController()
    const timeoutError = new Error(`SubagentCriticProvider 超时：未在 ${timeoutMs}ms 内收到结果`)
    let timer: ReturnType<typeof setTimeout> | undefined

    let run: SubagentLikeRun
    try {
      run = await ownerCtx.subagents.start(providerName, {
        label: `pm-critic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: [{ type: 'text', text: taskText }],
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError
      throw error
    }

    try {
      const result = await Promise.race([
        run.result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(timeoutError)
            reject(timeoutError)
          }, timeoutMs)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (result.stopReason !== 'completed') {
        const detail = result.diagnostic === undefined ? '' : `；diagnostic: ${result.diagnostic}`
        throw new Error(`SubagentCriticProvider 子代理未完成：stopReason=${result.stopReason}${detail}`)
      }
      const text = (result.output ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text.trim().length === 0) {
        throw new Error('SubagentCriticProvider 子代理未产出 assistant 文本')
      }
      return text
    } finally {
      try {
        await run.dispose()
      } catch {
        /* 吞掉 dispose 异常 */
      }
    }
  }
}
