/**
 * 艺术指导卡推荐器（spec §6.2）——纯规则函数，零 LLM。
 * 每类至多 1 张，输出顺序即优先级：motion → lighting → composition → perspective。
 * presetHints（预设 art_direction_hints，spec §6.3 附加先验信号）语义：
 *   - 仅在对应维度被推荐时决定「推哪张卡」（优先于默认卡）——维度缺失信号为权威；
 *   - 维度已满足（对应 has* 信号为真）时该类不推荐，「hint 视为已满足」由调用方在
 *     信号计算层落实（Task 12/14 拼装 RecommendSignals 时处理）；
 *   - 非法 hint（isKnownCardId 不过）忽略，回退默认卡并记 reason 'invalid_hint_ignored'。
 */
import { isKnownCardId, type ArtDirectionField } from '../enrich/art-direction.js'

export interface RecommendSignals {
  media: 'image' | 'video' | 'mixed'
  hasMotionIntent: boolean
  hasLighting: boolean
  hasComposition: boolean
  hasFocal: boolean
  presetHints?: Partial<Record<ArtDirectionField, string>>
}

export interface ArtDirectionRecommendation {
  field: ArtDirectionField
  cardId: string
  reason: string
}

export function recommendArtDirection(s: RecommendSignals): ArtDirectionRecommendation[] {
  const out: ArtDirectionRecommendation[] = []
  // ① motion：非纯图媒体且 motion 维度未表达（hasMotionIntent 为「已满足」信号，
  //    与 has* 平行——计划规则①文本 hasMotionIntent||media!=='image' 与其测试 3 直接矛盾，
  //    测试为验收标准，按测试钉死的语义实现）
  if (s.media !== 'image' && !s.hasMotionIntent) {
    out.push(pick('motion', s.presetHints?.motion, 'dynamic_pose', 'video_media'))
  }
  // ② lighting：缺光方向/造型表达
  if (!s.hasLighting) out.push(pick('lighting', s.presetHints?.lighting, 'cinematic_lighting', 'lighting_missing'))
  // ③ composition：缺构图锚点
  if (!s.hasComposition) out.push(pick('composition', s.presetHints?.composition, 'rule_of_thirds', 'composition_missing'))
  // ④ perspective：缺焦点/景别表达
  if (!s.hasFocal) out.push(pick('perspective', s.presetHints?.perspective, 'close_up', 'focal_missing'))
  return out
}

function pick(field: ArtDirectionField, hint: string | undefined, fallback: string, baseReason: string): ArtDirectionRecommendation {
  if (hint && isKnownCardId(field, hint)) return { field, cardId: hint, reason: `preset_hint:${hint}` }
  return { field, cardId: fallback, reason: hint !== undefined ? 'invalid_hint_ignored' : baseReason }
}
