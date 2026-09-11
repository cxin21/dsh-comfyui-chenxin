/**
 * enrich 引擎（spec §2）：LLM 扩写一句话意图 → 七维度 EnrichedBrief。
 *
 * - provider 复用 eval/critic.ts 的 CriticProvider 类型（persona/schema/user 三段注入，mock 友好）；
 * - outputLang（spec §2.2/§4）：anima 方言锁 'en'（显式传 zh 也直接纠正，advisory 语义由接线层 T6 承担）；
 *   h3 显式指定优先，否则 detectLanguage(userInput) 映射（中文→zh，日本語→ja，其他→en）；
 * - 降级铁律（spec §2.1/§6）：provider 抛错 / parse 失败 / schema 不合 / 大小超限 → { skipped: true, reason }，
 *   永不抛出、永不静默截断。
 */
import type { CriticProvider } from '../eval/critic.js'
import { detectLanguage } from '../dialect/h3.js'
import { validateBrief } from './brief.js'
import type { EnrichedBrief } from './brief.js'
import { buildEnrichPersona } from './personas.js'

export type EnrichTarget = 'anima' | 'h3'

export type EnrichResult = { brief: EnrichedBrief } | { skipped: true; reason: string }

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

function buildSchema(): string {
  const item = `{ "text": "维度内容（≤200 字符）", "source": "user" | "enriched" }`
  return `{
  "outputLang": "en" | "zh" | "ja",
  "subject": [${item}],
  "scene": [${item}],
  "composition": [${item}],
  "lighting": [${item}],
  "color": [${item}],
  "style": [${item}],
  "mood": [${item}],
  "nameAnchors": [{ "original": "用户原角色名", "anchored": "英文锚定名" }]
}`
}

function buildUser(input: { target: EnrichTarget; userInput: string }): string {
  return [
    `target=${input.target}`,
    '',
    '用户原始输入：',
    input.userInput,
    '',
    // Round7 T3：与 persona 的语义级保留规则同步——字面「原样保留，不改写」会让中文 user 条目穿透英文 brief
    '要求：source=user 仅用于用户显式指定的内容（语义与指代保留、不得增删要素，语言必须改写为 outputLang 对应语言）；其余全部标 source=enriched。',
    '每维度 ≤6 条、单条 ≤200 字符。outputLang 按目标方言给出（anima 恒为 en）。',
  ].join('\n')
}

/** detectLanguage（'中文'|'日本語'|'English'）→ brief outputLang（'zh'|'ja'|'en'，其他归 en）。 */
function mapDetectedLang(detected: string): EnrichedBrief['outputLang'] {
  if (detected === '中文') return 'zh'
  if (detected === '日本語') return 'ja'
  return 'en'
}

/** spec §2.2/§4：目标方言的最终 outputLang（在 validate 之后由代码强制，不信任 LLM 输出）。 */
function resolveOutputLang(target: EnrichTarget, explicit: EnrichedBrief['outputLang'] | undefined, userInput: string): EnrichedBrief['outputLang'] {
  if (target === 'anima') return 'en'
  if (explicit !== undefined) return explicit
  return mapDetectedLang(detectLanguage(userInput))
}

/**
 * runEnrich：扩写引擎入口。永不抛出；任何故障路径返回 { skipped: true, reason }：
 * - provider 抛错 → enrich_llm_error
 * - JSON parse 失败 / schema 不合 → enrich_invalid_schema
 * - 大小超限（validateBrief brief_too_large）→ brief_too_large（不截断，整体降级）
 */
export async function runEnrich(input: {
  target: EnrichTarget
  userInput: string
  /** 显式指定优先（仅 h3 有效；anima 恒锁 en） */
  outputLang?: EnrichedBrief['outputLang']
  provider: CriticProvider
}): Promise<EnrichResult> {
  try {
    const raw = await input.provider({
      persona: buildEnrichPersona(input.target),
      schema: buildSchema(),
      user: buildUser(input),
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(stripFences(raw))
    } catch {
      return { skipped: true, reason: 'enrich_invalid_schema' }
    }
    const validated = validateBrief(parsed)
    if (!validated.ok) {
      // 形状/schema 不合归一为 enrich_invalid_schema；大小超限保留专属 reason（不截断，整体降级）
      const reason = validated.reason === 'brief_too_large' ? 'brief_too_large' : 'enrich_invalid_schema'
      return { skipped: true, reason }
    }
    const brief: EnrichedBrief = {
      ...validated.brief,
      outputLang: resolveOutputLang(input.target, input.outputLang, input.userInput),
    }
    return { brief }
  } catch {
    return { skipped: true, reason: 'enrich_llm_error' }
  }
}
