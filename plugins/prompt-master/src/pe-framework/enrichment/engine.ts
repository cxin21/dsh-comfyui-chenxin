/**
 * 美学化扩展引擎（spec §7）：蓝图 v0 → v1。
 * enrichBlueprint：构造扩展 persona（§7.1 规则：具体名词化/禁空泛词/ROI 顺序「光影>主体特征>运镜」/
 * 负向推断/角色锚点补全），注入 CINEMA_LEXICON 六类（景别/焦段/运镜/光线/色彩分级/构图）候选词；
 * 经 complete 让 LLM 只输出增量 JSON patch（{set, additions, expansions}，兼容裸部分蓝图 {core:…} 形态）；
 * 应用 patch 到 v0 → v1；风格注入（opts.styleId → applyStyle）；expansions 从 LLM 收集
 * （无则用 opts.missing 生成占位记录）；patch 应用失败 → 回退 v0 + expansions:['enrichment_failed:fallback_to_v0']（不抛错）；
 * v1 产出后必须过质量自检（spec §7.1 确定性项：checkConcreteness 可感知名词比例+禁词、checkFieldCompleteness 字段完整度、
 * checkFidelity 保真）——任一失败追加 advisory 进 expansions 但不阻断。
 * M5-T3 三件事：①D6/R7 core.rating 信任边界——patch 应用前 strip（LLM 产物不可信于确定性注入的安全数据，
 * spec §5.1 偏差记录），覆写企图 advisory enrich_rating_overwrite_blocked；
 * ②V8 persona media 分支——video shot 五维密度规则仅 video/mixed，image 换画面密度纪律；
 * ③D7 recommendations 推荐先验通道——user 段【推荐先验】块（与 enrich/engine.ts buildUser 同源逐字，LLM 仍终决）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { complete } from '../../llm/complete.js'
import type { BlueprintMedia, BlueprintV1 } from '../blueprint/schema.js'
import { applyStyle } from './style.js'
import { getStylePreset } from '../styles/registry.js'
import { checkConcreteness, checkFidelity, checkShotDensity } from '../aesthetics/check.js'
import { CINEMA_LEXICON } from '../aesthetics/lexicon.js'

export interface EnrichRoute {
  provider: string
  model: string
}

export interface EnrichOptions {
  styleId?: string
  conformity?: number
  missing?: string[]
  /** M5-T3（D7 推荐先验通道）：T10 推荐器输出（recommendArtDirection）→ user 段【推荐先验】块。
   *  文案与 enrich/engine.ts buildUser（spec §7 P2/§6.2）同源逐字，改动必须两处同步；LLM 仍做最终设计决策。
   *  消费方：M5-T2 编排接线（prompt-author 推荐卡透传）。 */
  recommendations?: Array<{ field: string; cardId: string; reason: string }>
}

export interface EnrichResult {
  blueprint: BlueprintV1
  expansions: string[]
  /** M2-T2（spec §4.3 备注）：风格应用层面的非阻塞 advisory（如 style_negative_hints_h3_ignored:<id>）——由编排层并入 envelope advisories */
  advisories?: string[]
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
      // M5-T3b：对象值 additions 合并进既有节点（修复 void 赋值缺陷——旧实现把 deepMerge 的 void
      // 返回值赋给键，把节点覆成 undefined 摧毁既有内容，如 additions.media_layer）。
      // target[k] 为对象时就地深合并（既有键保留、patch 键并入），否则以空对象承接。
      const base = isPlainObject(target[k]) ? (target[k] as Record<string, unknown>) : {}
      deepMerge(base, pv)
      target[k] = base
    } else {
      target[k] = pv
    }
  }
}

/** M5-T3（D6/R7）：core.rating 覆写企图 advisory token（契约原文，勿改——T2/T4 断言面） */
const RATING_OVERWRITE_ADVISORY = 'enrich_rating_overwrite_blocked'

/**
 * M5-T3（D6/R7）core.rating 信任边界：patch 应用前 strip 会写入 core.rating 的路径。
 * core.rating 是确定性注入的安全数据（spec §5.1 偏差记录：LLM 产物不可信于安全数据，声明档位由注入方独占）。
 *
 * 覆盖形态（写入面 = deepMerge(set 通道，含裸部分蓝图形态——normalize 后即 set) 与 applyAdditions
 * (additions 通道) 两条应用通道；patch 契约无独立 unset 通道，若未来新增应用通道必须同样先过本 strip）：
 * ① patch.core 为对象 → 仅删除其 rating 键（其余键保留，良性 core 扩写不受影响）——即 set.core.rating 嵌套全形态；
 * ② patch.core 存在但非对象（标量/数组）→ 任何应用语义都会整体顶掉 core 节点（连带 rating）→ 整键删除；
 * ③ additions 通道（wholeCore=true）对 core 整体不信任：additions 语义是数组追加/标量覆盖，对 core
 *    （rating 载体节点）的任何写入都按覆写企图整键阻断——历史上对象值 additions 曾因 void 赋值缺陷
 *    摧毁整个 core 节点（M5-T3b 已修为节点合并，见 applyAdditions），但信任边界不因修复放宽：
 *    additions 通道对 rating 载体节点零写权限。
 *
 * strip 面论证（acceptance：rating 必挡；是否扩面给结论留痕）：strip 面收敛为 core.rating 一项，
 * 不扩到其他 core 字段——concept/scene/style/emotion/composition/negative/narrative/characters/aspect_ratio
 * 是扩展层的目标业务字段，strip 它们等于废掉扩展层；后续若有新的确定性注入字段，在本函数白名单式显式追加，
 * 不做模糊匹配。
 *
 * @returns 是否发生 strip（true = 覆写企图成立，调用方补 advisory enrich_rating_overwrite_blocked）
 */
function stripCoreRatingFromPatch(patch: Record<string, unknown>, opts: { wholeCore?: boolean } = {}): boolean {
  const core = patch['core']
  if (core == null) return false
  if (isPlainObject(core) && !opts.wholeCore) {
    if ('rating' in core) {
      delete core['rating']
      return true
    }
    return false
  }
  delete patch['core']
  return true
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

/** M5-T3（V8）：video shot 五维密度规则——video/mixed 保持原文逐字不动（mixed 可能含 video.shots，checkShotDensity video 分支同样适用） */
const VIDEO_SHOT_DENSITY_RULES = [
  '3. 镜头细节密度（硬性）：每个 video shot 的 action 必须完整覆盖 5 个维度，缺一不可——',
  '   ① 主体（谁/什么在动，具体名词，≥8 字）',
  '   ② 环境（场景/空间，具体名词，≥8 字）',
  '   ③ 光影（时间/光源/明暗，具体名词，≥6 字）',
  '   ④ 运镜（景别/机位/镜头运动，从候选词库选，或填 shot_size/camera）',
  '   ⑤ 情绪（氛围/气氛，具体可感，≥4 字）',
  '   禁止一句话带过（如「两名女剑客持剑对峙」缺环境/光影/情绪即不合格）；用「，」连接各维度描述。',
]

/**
 * M5-T3（V8）：image 蓝图的画面密度纪律——与设计稿 §2.2 ANIMA 蓝图 persona discipline 同源
 * （景别 discipline/角色锚点 discipline/场景锚点语义），防 video 五维规则对 image 蓝图空转
 * 甚至诱导 LLM 给 image 蓝图编造 video.shots。
 */
const IMAGE_DETAIL_DENSITY_RULES = [
  '3. 画面细节密度（硬性，image）：media_layer.image.pose_action 写动作峰值瞬间的单一画面（主体+动作，具体名词，≥8 字）；expression ≤2 个具体可感表情词；scene_anchors ≤3 个高影响场景锚点（保序）；camera_angle 只允许 anima 景别词（full body / cowboy shot / upper body / close-up）+ 至多 1 个视角词；focal_length/depth_of_field 不确定规范写法时留空（camera 是结构槽，脏词会全文穿透）；光源物件/曝光/空间纵深/色彩主次写进 core.scene.lighting 与 core.narrative。',
]

function buildExpansionPersona(media: BlueprintMedia): string {
  return [
    '你是一个创作蓝图美学扩展引擎（spec §7.1）。',
    '规则：',
    '1. 具体名词化：把空泛形容词改写为可感知名词短语（如「电影感」→「IMAX 胶片机 + Panavision C 系 35mm f4」）。',
    '2. 禁空泛词：输出不得含 cinematic/beautiful/amazing/stunning/epic/大气/高级/电影感 等空泛词。',
    ...(media === 'image' ? IMAGE_DETAIL_DENSITY_RULES : VIDEO_SHOT_DENSITY_RULES),
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
    '输出契约（硬性）：本任务为 one-shot 结构产出，不要调用任何工具；只输出一个增量 JSON patch——裸 JSON（不要代码块、不要解释）。形状：',
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
  const recs = opts.recommendations ?? []
  const user = [
    'v0 蓝图：',
    JSON.stringify(v0),
    ...(opts.styleId ? [`用户风格: ${opts.styleId}（conformity=${opts.conformity ?? 0.6}）`] : []),
    ...(opts.missing && opts.missing.length > 0 ? [`缺失维度: ${opts.missing.join(', ')}`] : []),
    // M5-T3（D7 推荐先验通道）：推荐器输出注入——与 enrich/engine.ts buildUser（spec §7 P2/§6.2）
    // 同源逐字（空行 + 头行 + 条目行），文案改动必须两处同步；LLM 仍做最终设计决策。
    ...(recs.length > 0
      ? [
          '',
          '【推荐先验】艺术指导推荐器建议（你仍做最终设计决策，每类至多 1 张）：',
          ...recs.map((r) => `- ${r.field}: ${r.cardId}（${r.reason}）`),
        ]
      : []),
  ].join('\n')

  let raw: string
  try {
    const signal = new AbortController().signal
    const res = await complete(ctx, {
      provider: route.provider,
      model: route.model,
      system: buildExpansionPersona(v0.media),
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
    // M5-T3（D6/R7）：core.rating 信任边界——patch 应用前 strip（set 含裸形态 + additions 两通道全覆盖）。
    // 两条通道都要实际执行 strip（不可短路），advisory 只出一次。
    let ratingOverwriteBlocked = stripCoreRatingFromPatch(set)
    if (isPlainObject(parsed['additions'])) {
      // additions 通道整键阻断（wholeCore）：只删 rating 键不足以保住 rating（见 stripCoreRatingFromPatch ③）
      ratingOverwriteBlocked = stripCoreRatingFromPatch(parsed['additions'] as Record<string, unknown>, { wholeCore: true }) || ratingOverwriteBlocked
    }
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
    // spec §4.3 ③：未知 styleId 仍返回原对象，engine 层补 advisory（applyStyle 不感知展示通道）
    let styleAdvisories: string[] = []
    const preset = opts.styleId ? getStylePreset(opts.styleId) : undefined
    if (opts.styleId && !preset) expansions.push(`style_preset_unknown:${opts.styleId}`)
    let enriched = v1
    if (opts.styleId && preset) {
      enriched = applyStyle(v1, opts.styleId, opts.conformity ?? 0.6)
      // M2-T2（spec §4.3 备注）：h3 通道（video 蓝图）negative_hints 被忽略必须可观测——
      // applyStyle 不感知展示通道，advisory 由 engine 层补（与 style_preset_unknown 同口径）
      if (v1.media === 'video' && preset.negative_hints.length > 0) {
        styleAdvisories = [`style_negative_hints_h3_ignored:${opts.styleId}`]
      }
    }

    // 质量自检（spec §7.1 确定性项）：具体性（可感知名词比例+禁词）+ 字段完整度 + 保真
    // 任一失败追加 advisory 进 expansions，不阻断
    const cc = checkConcreteness(enriched)
    if (!cc.pass) expansions.push(`concreteness_failed:${cc.issues.join(';')}`)
    const completeFields = checkFieldCompleteness(enriched)
    if (completeFields.length > 0) expansions.push(`field_completeness:missing:${completeFields.join(';')}`)
    const sd = checkShotDensity(enriched)
    if (!sd.pass) expansions.push(`shot_density:missing:${sd.issues.join(';')}`)
    const fid = checkFidelity(v0.core?.concept ?? '', enriched)
    if (!fid.pass) expansions.push(`fidelity_failed:${fid.missingEntities.join(';')}`)

    // M5-T3（D6/R7）：core.rating 覆写企图 → advisory（与 styleAdvisories 同通道并入 envelope advisories）
    const advisories = [...styleAdvisories]
    if (ratingOverwriteBlocked) advisories.push(RATING_OVERWRITE_ADVISORY)

    return { blueprint: enriched, expansions, ...(advisories.length > 0 ? { advisories } : {}) }
  } catch {
    return { blueprint: v0, expansions: ['enrichment_failed:fallback_to_v0'] }
  }
}
