/**
 * 艺术指导卡片库（Round8 T3Q）：把专业美术指导的「设计意图包」固化为组合拳卡片。
 *
 * 方法论参考 SD-Anima-Prompt-Studio：出稿「没有美学和设计感」的根因是 enrich persona 只教了
 * 结构、没教艺术指导。本库让 LLM 先做设计决策（每类至多选 1 张卡）、再按所选卡片的 tag
 * 组合拳扩写——卡片内容从实战 studio 提炼，5 类 36 张：
 *   perspective 镜头视角 8 / composition 构图设计 8 / lighting 光影设计 8 / color 色彩设计 6 / motion 动势设计 6。
 *
 * id 是 brief.artDirection 的合法取值（brief.ts 按类目校验）；name 为中文设计意图名；tags 为配套英文 tag 组合拳。
 */

export interface ArtDirectionCard {
  id: string
  /** 中文设计意图名 */
  name: string
  /** 配套 tag 组合拳（3-5 个） */
  tags: readonly string[]
}

/** 镜头视角（8）：突出气势 / 自然人像 / 叙事感 / 紧张动感 / 场景宏大 / 情绪特写 / 俯瞰叙事 / 戏剧轮廓 */
export const PERSPECTIVE_CARDS: readonly ArtDirectionCard[] = [
  { id: 'low_angle', name: '低角度仰拍', tags: ['from below', 'dramatic low angle', 'looking up'] },
  { id: 'three_quarter_view', name: '三分之二视角', tags: ['three-quarter view', 'dynamic angle', 'showing both face and body'] },
  { id: 'over_shoulder_glance', name: '过肩回眸', tags: ['over the shoulder shot', 'looking back at viewer', 'soft focus on background'] },
  { id: 'dutch_angle', name: '荷兰角', tags: ['dutch angle', 'tilted frame', 'sense of tension'] },
  { id: 'wide_panorama', name: '广角全景', tags: ['wide angle shot', 'expansive view', 'cinematic wide shot'] },
  { id: 'close_up', name: '特写', tags: ['close-up', 'shallow depth of field', 'detailed face'] },
  { id: 'top_down', name: '俯视', tags: ['from above', 'top-down view', 'looking down'] },
  { id: 'side_silhouette', name: '侧面剪影', tags: ['from side', 'silhouette', 'backlit subject'] },
]

/** 构图设计（8）：均衡 / 动势 / 呼吸感 / 聚焦 / 仪式感 / 纵深 / 协调 / 戏剧性 */
export const COMPOSITION_CARDS: readonly ArtDirectionCard[] = [
  { id: 'rule_of_thirds', name: '三分法则', tags: ['rule of thirds', 'off-center placement', 'balanced asymmetry'] },
  { id: 'diagonal_dynamics', name: '对角线动势', tags: ['diagonal composition', 'dynamic diagonal lines', 'sense of movement'] },
  { id: 'negative_space', name: '负空间', tags: ['negative space composition', 'minimalist', 'empty space for breathing room'] },
  { id: 'framed_subject', name: '框架构图', tags: ['framed composition', 'natural frame around subject', 'foreground framing'] },
  { id: 'perfect_symmetry', name: '对称', tags: ['perfect symmetry', 'mirrored composition', 'formal and elegant'] },
  { id: 'leading_lines', name: '引导线', tags: ['leading lines', 'converging lines', 'depth through perspective'] },
  { id: 'golden_ratio', name: '黄金分割', tags: ['golden ratio composition', 'naturally pleasing placement', 'organic balance'] },
  { id: 'strong_silhouette', name: '剪影', tags: ['strong silhouette', 'dramatic outline', 'backlit minimal detail'] },
]

/** 光影设计（8）：电影感 / 发丝边缘光 / 穿透感 / 夜景 / 黄金时刻 / 暖光私密 / 明暗戏剧 / 梦幻柔焦 */
export const LIGHTING_CARDS: readonly ArtDirectionCard[] = [
  { id: 'cinematic_lighting', name: '电影级', tags: ['cinematic lighting', 'volumetric lighting', 'dramatic shadows'] },
  { id: 'rim_backlight', name: '逆光轮廓', tags: ['backlighting', 'rim lighting', 'glowing edge'] },
  { id: 'god_rays', name: '体积光', tags: ['god rays', 'light rays', 'volumetric sunlight'] },
  { id: 'moonlight_cool', name: '月夜冷调', tags: ['moonlight', 'cool blue tones', 'soft night glow'] },
  { id: 'golden_hour', name: '黄金时刻', tags: ['golden hour lighting', 'warm sunlight', 'long shadows'] },
  { id: 'lantern_glow', name: '烛光灯火', tags: ['warm lantern light', 'candlelight glow', 'intimate warm tones'] },
  { id: 'high_contrast', name: '高对比', tags: ['high contrast lighting', 'chiaroscuro', 'dramatic light and shadow'] },
  { id: 'soft_dreamlight', name: '柔光梦幻', tags: ['soft lighting', 'ethereal glow', 'diffused light'] },
]

/** 色彩设计（6）：张力 / 统一 / 电影调色 / 点睛 / 淡雅 / 幻想高饱和 */
export const COLOR_CARDS: readonly ArtDirectionCard[] = [
  { id: 'warm_cool_contrast', name: '冷暖对比', tags: ['contrasting color palette', 'cool and warm tones', 'color tension'] },
  { id: 'limited_palette', name: '有限色板', tags: ['limited palette', 'two-tone color scheme', 'unified color harmony'] },
  { id: 'cinematic_grading', name: '浓郁电影调色', tags: ['cinematic color grading', 'rich saturated colors', 'vivid yet natural tones'] },
  { id: 'accent_on_mono', name: '单色点缀', tags: ['monochrome with accent color', 'splash of red', 'selective color pop'] },
  { id: 'soft_pastel', name: '柔和淡彩', tags: ['soft pastel colors', 'muted tones', 'gentle color transition'] },
  { id: 'vivid_fantasy', name: '高饱和幻想', tags: ['vibrant fantasy colors', 'iridescent highlights', 'luminous colors'] },
]

/** 动势设计（6）：直接服务舞剑类动作需求 */
export const MOTION_CARDS: readonly ArtDirectionCard[] = [
  { id: 'dynamic_pose', name: '动态姿势', tags: ['dynamic pose', 'action-ready stance', 'mid-movement'] },
  { id: 'flowing_dress', name: '衣袂飘飞', tags: ['flowing dress', 'fabric in motion', 'clothes fluttering in wind'] },
  { id: 'flowing_hair', name: '发丝飞扬', tags: ['hair flowing in wind', 'dynamic hair', 'hair strands floating'] },
  { id: 'weapon_trail', name: '武器轨迹', tags: ['sword trail', 'gleaming blade', 'weapon arc'] },
  { id: 'falling_petals', name: '花瓣飞舞', tags: ['falling petals', 'petals in the wind', 'swirling petals'] },
  { id: 'frozen_peak', name: '定格瞬间', tags: ['caught mid-action', 'frozen motion', 'peak of the movement'] },
]

export type ArtDirectionField = 'perspective' | 'composition' | 'lighting' | 'color' | 'motion'

/** 五类卡组总表（brief.artDirection 校验与卡片菜单的唯一数据源） */
export const ALL_ART_DIRECTION: Record<ArtDirectionField, readonly ArtDirectionCard[]> = {
  perspective: PERSPECTIVE_CARDS,
  composition: COMPOSITION_CARDS,
  lighting: LIGHTING_CARDS,
  color: COLOR_CARDS,
  motion: MOTION_CARDS,
}

const FIELD_LABELS: Record<ArtDirectionField, string> = {
  perspective: '镜头视角',
  composition: '构图设计',
  lighting: '光影设计',
  color: '色彩设计',
  motion: '动势设计',
}

/** 按类目校验：id 必须属于该字段对应卡组（跨类目 id 一律拒绝，保证字段语义无歧义）。 */
export function isKnownCardId(field: ArtDirectionField, id: string): boolean {
  return ALL_ART_DIRECTION[field].some((card) => card.id === id)
}

/** 卡片清单菜单（engine buildUser 注入 user 段）：id+name+tags，供 LLM 先选卡、再按组合拳扩写。 */
export function buildArtDirectionMenu(): string {
  const lines: string[] = [
    '艺术指导卡片菜单（先选卡再扩写：每类至多选 1 张，把卡片 id 填入 schema 的 artDirection 对应字段，并把该卡片的配套 tag 融入对应维度短语）：',
  ]
  for (const field of ['perspective', 'composition', 'lighting', 'color', 'motion'] as const) {
    lines.push(`【${field} ${FIELD_LABELS[field]}】`)
    for (const card of ALL_ART_DIRECTION[field]) lines.push(`- ${card.id} ${card.name}: ${card.tags.join(', ')}`)
  }
  return lines.join('\n')
}
