/**
 * 确定性美学 gates（spec §6.1）——advisory 级，纯词表判定，零 LLM 零 IO。
 * 分工（spec §6.3）：gates 管「有没有」（四类锚点缺失判定），评委管「好不好」；
 * h3 不加确定性美学 gates（其美学覆盖由评委 atmosphere-coupling / camera-motivation 承担）。
 * cardIds = 对应艺术指导卡组全部 id（enrich/art-direction.ts 单源派生）——修复提示，
 * 注入【推荐先验】由 LLM 做最终设计决策，不硬注入（spec §6.2）。
 * lighting 词表全部通过 LIGHTING_BAN 合规检查（camera-anima 部署约束：光照渲染由 LoRA 承接，
 * 推荐修复不得引入禁词；由 audit.test.ts 镜像把关，同 art-direction 卡 tag 一致性测试口径）。
 */
import { ALL_ART_DIRECTION } from '../enrich/art-direction.js'

export type AestheticAnchorField = 'composition' | 'lighting' | 'color' | 'perspective'

export type AestheticGateId =
  | 'aesthetic_composition_missing'
  | 'aesthetic_lighting_missing'
  | 'aesthetic_palette_missing'
  | 'aesthetic_focal_missing'

export interface AestheticGate {
  id: AestheticGateId
  cardField: AestheticAnchorField
  cardIds: string[]
}

/** 判定词表（计划 Task 9 Interfaces 逐字；小写 includes）。键为检测维度名（palette/focal），
 *  与卡字段映射（palette→color、focal→perspective，见 ANCHOR_TABLE）解耦。
 *  composition/lighting/focal 词全部源自对应卡组 tag 的锚点短语；palette 含自由调色词
 *  （desaturated/sepia 等检测侧词汇，不用于注入故不受 LIGHTING_BAN 约束）。 */
export const AESTHETIC_ANCHOR_WORDS: Record<'composition' | 'lighting' | 'palette' | 'focal', readonly string[]> = {
  composition: ['rule of thirds', 'negative space', 'leading lines', 'golden ratio', 'symmetry', 'diagonal composition', 'framed composition', 'silhouette', 'off-center'],
  lighting: ['golden hour', 'chiaroscuro', 'dramatic shadows', 'soft diffused', 'dappled', 'cool blue tones', 'warm amber', 'high contrast lighting', 'long shadows', 'luminous outline'],
  palette: ['palette', 'tones', 'monochrome', 'pastel', 'saturated', 'desaturated', 'teal', 'sepia', 'color scheme'],
  focal: ['close-up', 'closeup', 'portrait', 'depth of field', 'focal', 'upper body', 'cowboy shot', 'full body', 'wide shot'],
}

const ANCHOR_TABLE: readonly { id: AestheticGateId; cardField: AestheticAnchorField; words: readonly string[] }[] = [
  { id: 'aesthetic_composition_missing', cardField: 'composition', words: AESTHETIC_ANCHOR_WORDS.composition },
  { id: 'aesthetic_lighting_missing', cardField: 'lighting', words: AESTHETIC_ANCHOR_WORDS.lighting },
  { id: 'aesthetic_palette_missing', cardField: 'color', words: AESTHETIC_ANCHOR_WORDS.palette },
  { id: 'aesthetic_focal_missing', cardField: 'perspective', words: AESTHETIC_ANCHOR_WORDS.focal },
]

/** 成稿 positive 的四类美学锚点缺失判定：命中任一词即视为该维度已锚定（不触发 gate）；
 *  全维度锚定返回 []。cardIds 为该维度卡组全部 id（修复提示，advisory 级）。 */
export function detectAestheticGates(positive: string): AestheticGate[] {
  const low = positive.toLowerCase()
  const gates: AestheticGate[] = []
  for (const a of ANCHOR_TABLE) {
    if (!a.words.some((w) => low.includes(w))) {
      gates.push({ id: a.id, cardField: a.cardField, cardIds: ALL_ART_DIRECTION[a.cardField].map((c) => c.id) })
    }
  }
  return gates
}
