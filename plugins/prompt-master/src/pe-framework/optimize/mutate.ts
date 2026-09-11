/**
 * 质量飞轮 §4.3 变异提案（GEPA 式简化循环第 1 步，离线纯提案层）。
 *
 * 离线铁律（spec §4.1）：本模块不被运行时管线 import、不注册 agent 工具。
 * 变异 LLM 复用 CriticProvider 同款注入形状（persona/schema/user → Promise<string>）；
 * provider 返回 { diff, rationale, targetsFailures } JSON，坏 JSON / 缺字段抛 Error，
 * 由调用方决定重试/放弃——本模块离线，允许抛。
 */
import type { EvalCase } from './harness.js'
import type { CriticProvider } from '../eval/critic.js'

export interface PersonaCandidate {
  id: string // cand_<ts>_<rand>
  diff: string // persona 的修改 diff（unified 风格文本即可）
  rationale: string // 为什么这样改
  targetsFailures: string[] // 针对哪些失败模式（来自负例 findings 的 dimension/problem 归纳）
}

const MUTATION_PERSONA = [
  '你是一位提示词工程专家（persona 变异器）。',
  '给定当前 persona、负例与评审 findings，提出一处针对失败模式的 persona 修改候选。',
  '铁律：只输出一个 JSON 对象（可带 ```json fence），不要任何额外文字或解释。',
].join('\n')

const MUTATION_SCHEMA = `{
  "diff": "unified 风格的 persona 修改 diff 文本",
  "rationale": "为什么这样改",
  "targetsFailures": ["针对的失败模式（dimension:problem 归纳）", ...]
}`

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

function buildUser(input: {
  negativeCases: EvalCase[]
  debates: Array<{ generationId: string; findings: Array<{ dimension: string; problem: string; requiredFix: string }> }>
  currentPersona: string
}): string {
  const parts: string[] = [
    '## 当前 persona',
    input.currentPersona,
    '',
    '## 负例（失败案例的原始创作意图）',
  ]
  for (const c of input.negativeCases) {
    parts.push(`- [${c.id}] target=${c.target} 意图：${c.input}`)
  }
  parts.push('', '## debate findings（评审指出的问题）')
  for (const d of input.debates) {
    for (const f of d.findings) {
      parts.push(`- [${d.generationId}] ${f.dimension}: ${f.problem} → ${f.requiredFix}`)
    }
  }
  parts.push(
    '',
    '请针对上述失败模式提出一处 persona 修改候选，按 schema 输出 JSON。',
  )
  return parts.join('\n')
}

/** 变异提案：组装负例 + debate findings + 当前 persona → provider → 校验后返回候选。 */
export async function proposeMutation(input: {
  negativeCases: EvalCase[]
  debates: Array<{ generationId: string; findings: Array<{ dimension: string; problem: string; requiredFix: string }> }>
  currentPersona: string
  provider: CriticProvider
}): Promise<PersonaCandidate> {
  const raw = await input.provider({
    persona: MUTATION_PERSONA,
    schema: MUTATION_SCHEMA,
    user: buildUser(input),
  })
  let obj: any
  try {
    obj = JSON.parse(stripFences(raw))
  } catch {
    throw new Error('proposeMutation：provider 返回的不是合法 JSON')
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('proposeMutation：provider 返回的 JSON 不是对象')
  }
  if (typeof obj.diff !== 'string' || obj.diff.length === 0) {
    throw new Error('proposeMutation：缺少字段 diff')
  }
  if (typeof obj.rationale !== 'string' || obj.rationale.length === 0) {
    throw new Error('proposeMutation：缺少字段 rationale')
  }
  if (!Array.isArray(obj.targetsFailures) || !obj.targetsFailures.every((t: unknown) => typeof t === 'string')) {
    throw new Error('proposeMutation：字段 targetsFailures 必须是字符串数组')
  }
  const rand = Math.random().toString(36).slice(2, 10)
  return {
    id: `cand_${Date.now()}_${rand}`,
    diff: obj.diff,
    rationale: obj.rationale,
    targetsFailures: obj.targetsFailures,
  }
}
