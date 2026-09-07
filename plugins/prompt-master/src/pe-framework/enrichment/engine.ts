/**
 * 美学化扩展引擎（spec §7）：蓝图 v0 → v1。
 * enrichBlueprint：构造扩展 persona（§7.1 规则：具体名词化/禁空泛词/ROI 顺序「光影>主体特征>运镜」/
 * 负向推断/角色锚点补全），注入 CINEMA_LEXICON 六类（景别/焦段/运镜/光线/色彩分级/构图）候选词；
 * 经 complete 让 LLM 只输出增量 JSON patch（{set, additions, expansions}，兼容裸部分蓝图 {core:…} 形态）；
 * 应用 patch 到 v0 → v1；风格注入（opts.styleId → applyStyle）；expansions 从 LLM 收集
 * （无则用 opts.missing 生成占位记录）；patch 应用失败 → 回退 v0 + expansions:['enrichment_failed:fallback_to_v0']（不抛错）；
 * v1 产出后必须过质量自检（spec §7.1 确定性项：checkConcreteness 可感知名词比例+禁词、checkFieldCompleteness 字段完整度、
 * checkFidelity 保真）——任一失败追加 advisory 进 expansions 但不阻断。
 */
import type { Context } from '@deepseek-ai/cordis'
import { complete } from '../../llm/complete.js'
import type { BlueprintV1 } from '../blueprint/schema.js'
import { applyStyle } from './style.js'
import { checkConcreteness, checkFidelity } from '../aesthetics/check.js'
import { CINEMA_LEXICON } from '../aesthetics/lexicon.js'

export interface EnrichRoute {
  provider: string
  model: string
}

export interface EnrichOptions {
  styleId?: string
  conformity?: number
  missing?: string[]
}

export interface EnrichResult {
  blueprint: BlueprintV1
  expansions: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** set 语义：深合并对象字段，数组整体替换（保留未提及的既有字段） */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const k of Object.keys(patch)) {
    const pv = patch[k]
    const tv = target[k]
    if (isPlainObject(pv) && isPlainObject(tv)) {
      deepMerge(tv as Record<string, unknown>, pv)
    } else {
      target[k] = pv
    }
  }
}

/** additions 语义：数组追加，对象深合并，标量覆盖 */
function applyAdditions(target: Record<string, unknown>, additions: Record<string, unknown>): void {
  for (const k of Object.keys(additions)) {
    const pv = additions[k]
    if (Array.isArray(pv)) {
      target[k] = [...(Array.isArray(target[k]) ? (target[k] as unknown[]) : []), ...pv]
    } else if (isPlainObject(pv)) {
      target[k] = deepMerge({ ...(isPlainObject(target[k]) ? (target[k] as Record<string, unknown>) : {}) }, pv)
    } else {
      target[k] = pv
    }
  }
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

function buildExpansionPersona(): string {
  return [
    '你是一个创作蓝图美学扩展引擎（spec §7.1）。',
    '规则：',
    '1. 具体名词化：把空泛形容词改写为可感知名词短语（如「电影感」→「IMAX 胶片机 + Panavision C 系 35mm f4」）。',
    '2. 禁空泛词：输出不得含 cinematic/beautiful/amazing/stunning/epic/大气/高级/电影感 等空泛词。',
    '3. ROI 补全：按优先级补缺失维度——光影 > 主体特征 > 运镜 > 环境细节 > 风格。',
    '4. 负向推断：从用户语境推断合理负向（如「无现代元素」）→ negative[]（severity: soft）。',
    '5. 角色卡锚点补全：同一角色跨镜头时补齐 appearance_anchors（可见/可生成/可比较）。',
    '6. 保留事实：用户原词必须保留在 v1 的某字段（保真守卫），不编造情节。',
    '候选词库（可引用）：',
    `景别: ${CINEMA_LEXICON.shots.join('/')}`,
    `焦段: ${CINEMA_LEXICON.lenses.join('/')}`,
    `运镜: ${CINEMA_LEXICON.camera_moves.join('/')}`,
    `光线: ${CINEMA_LEXICON.lighting.join('/')}`,
    `色彩分级: ${CINEMA_LEXICON.grading.join('/')}`,
    `构图: ${CINEMA_LEXICON.composition.join('/')}`,
    '输出契约：只输出一个增量 JSON patch（不要代码块、不要解释），形状：',
    '{"set": {...要覆盖的蓝图字段...}, "additions": {...要追加的数组字段...}, "expansions": ["改写记录1", ...]}',
  ].join('\n')
}

/**
 * 字段完整度检查（spec §7.1 质量自检确定性项）。
 * 关键维度：media / core.concept / 至少一个 style|scene|emotion 非空。
 * 返回缺失维度描述列表（空 = 完整）；缺失仅作 advisory，不阻断（由调用方追加进 expansions）。
 */
export function checkFieldCompleteness(bp: BlueprintV1): string[] {
  const missing: string[] = []
  if (!bp.media) missing.push('media')
  if (!bp.core?.concept || bp.core.concept.trim().length === 0) missing.push('core.concept')
  const hasStyle = bp.core?.style != null && Object.keys(bp.core.style).length > 0
  const hasScene = bp.core?.scene != null && Object.keys(bp.core.scene).length > 0
  const hasEmotion = bp.core?.emotion != null && bp.core.emotion.trim().length > 0
  if (!hasStyle && !hasScene && !hasEmotion) missing.push('style|scene|emotion')
  return missing
}

export async function enrichBlueprint(
  ctx: Context,
  route: EnrichRoute,
  v0: BlueprintV1,
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const user = [
    'v0 蓝图：',
    JSON.stringify(v0),
    ...(opts.styleId ? [`用户风格: ${opts.styleId}（conformity=${opts.conformity ?? 0.6}）`] : []),
    ...(opts.missing && opts.missing.length > 0 ? [`缺失维度: ${opts.missing.join(', ')}`] : []),
  ].join('\n')

  let raw: string
  try {
    const signal = new AbortController().signal
    const res = await complete(ctx, {
      provider: route.provider,
      model: route.model,
      system: buildExpansionPersona(),
      user,
      maxTokens: 1024,
      temperature: 0.4,
      signal,
    })
    raw = res.text
  } catch {
    return { blueprint: v0, expansions: ['enrichment_failed:fallback_to_v0'] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    return { blueprint: v0, expansions: ['enrichment_failed:fallback_to_v0'] }
  }
  if (!isPlainObject(parsed)) {
    return { blueprint: v0, expansions: ['enrichment_failed:fallback_to_v0'] }
  }

  let expansions: string[] = []
  try {
    const v1 = structuredClone(v0) as BlueprintV1
    // patch 形状：{set, additions, expansions}；兼容裸部分蓝图（整个对象视为 set）
    const set = isPlainObject(parsed['set']) ? (parsed['set'] as Record<string, unknown>) : parsed
    deepMerge(v1 as unknown as Record<string, unknown>, set)
    if (isPlainObject(parsed['additions'])) {
      applyAdditions(v1 as unknown as Record<string, unknown>, parsed['additions'] as Record<string, unknown>)
    }
    if (Array.isArray(parsed['expansions'])) {
      expansions = (parsed['expansions'] as unknown[]).filter((e): e is string => typeof e === 'string')
    } else if (opts.missing && opts.missing.length > 0) {
      expansions = opts.missing.map((m) => `missing_filled:${m}`)
    }

    // 风格注入（确定性；用户选择优先于 LLM 隐含风格）
    const enriched = opts.styleId ? applyStyle(v1, opts.styleId, opts.conformity ?? 0.6) : v1

    // 质量自检（spec §7.1 确定性项）：具体性（可感知名词比例+禁词）+ 字段完整度 + 保真
    // 任一失败追加 advisory 进 expansions，不阻断
    const cc = checkConcreteness(enriched)
    if (!cc.pass) expansions.push(`concreteness_failed:${cc.issues.join(';')}`)
    const completeFields = checkFieldCompleteness(enriched)
    if (completeFields.length > 0) expansions.push(`field_completeness:missing:${completeFields.join(';')}`)
    const fid = checkFidelity(v0.core?.concept ?? '', enriched)
    if (!fid.pass) expansions.push(`fidelity_failed:${fid.missingEntities.join(';')}`)

    return { blueprint: enriched, expansions }
  } catch {
    return { blueprint: v0, expansions: ['enrichment_failed:fallback_to_v0'] }
  }
}
