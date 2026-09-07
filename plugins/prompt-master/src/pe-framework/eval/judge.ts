/**
 * LLM 评委（spec §13 评估闭环）：可选路径——用户要求或 eval 模式触发，不进默认 author 管线。
 * 按 rubric（coherence/fidelity/美学）对扩展后蓝图打分；输出 {scores:{coherence,fidelity,aesthetic}, overall, issues[]}。
 * 失败（LLM 错误/输出不可解析）→ 返回零分 + judge_failed advisory，不抛错。
 */
import type { Context } from '@deepseek-ai/cordis'
import { complete } from '../../llm/complete.js'
import type { BlueprintV1 } from '../blueprint/schema.js'

export interface JudgeRoute {
  provider: string
  model: string
}

export interface JudgeScores {
  coherence: number
  fidelity: number
  aesthetic: number
}

export interface JudgeResult {
  scores: JudgeScores
  overall: number
  issues: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

/** 分数夹取到 [0, 10]（四舍五入取整；非数字 → 0） */
function clampScore(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  return Math.max(0, Math.min(10, Math.round(v)))
}

function buildJudgePersona(): string {
  return [
    '你是一个创作蓝图评估评委（spec §13 评估闭环）。',
    '对给定「扩展后蓝图 + 用户原意」按 rubric 打分（每项 0-10 整数）：',
    '- coherence：叙事/镜头衔接/风格一致性；',
    '- fidelity：与用户原意保真度（原词保留、无情节编造）；',
    '- aesthetic：美学质量（具体名词运用、镜头语言、光影色彩）。',
    '输出契约：只输出一个 JSON（不要代码块、不要解释），形状：',
    '{"scores":{"coherence":7,"fidelity":8,"aesthetic":9},"overall":8,"issues":["问题1", ...]}',
  ].join('\n')
}

export async function judgeBlueprint(
  ctx: Context,
  route: JudgeRoute,
  v1: BlueprintV1,
  originalIntent: string,
): Promise<JudgeResult> {
  const user = [
    '扩展后蓝图：',
    JSON.stringify(v1),
    `用户原意：${originalIntent}`,
  ].join('\n')

  let raw: string
  try {
    const signal = new AbortController().signal
    const res = await complete(ctx, {
      provider: route.provider,
      model: route.model,
      system: buildJudgePersona(),
      user,
      maxTokens: 512,
      temperature: 0.2,
      signal,
    })
    raw = res.text
  } catch {
    return { scores: { coherence: 0, fidelity: 0, aesthetic: 0 }, overall: 0, issues: ['judge_failed:llm_error'] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    return { scores: { coherence: 0, fidelity: 0, aesthetic: 0 }, overall: 0, issues: ['judge_failed:unparseable'] }
  }
  if (!isPlainObject(parsed)) {
    return { scores: { coherence: 0, fidelity: 0, aesthetic: 0 }, overall: 0, issues: ['judge_failed:invalid_shape'] }
  }

  const rawScores = parsed['scores']
  const scores: JudgeScores = {
    coherence: clampScore(isPlainObject(rawScores) ? rawScores['coherence'] : undefined),
    fidelity: clampScore(isPlainObject(rawScores) ? rawScores['fidelity'] : undefined),
    aesthetic: clampScore(isPlainObject(rawScores) ? rawScores['aesthetic'] : undefined),
  }
  const overall = clampScore(parsed['overall'])
  const issues = Array.isArray(parsed['issues'])
    ? (parsed['issues'] as unknown[]).filter((i): i is string => typeof i === 'string')
    : []
  return { scores, overall, issues }
}
