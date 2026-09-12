/**
 * 风格库（spec §7.2 风格库分层；Phase 1 v0 → Phase 2 内容深化 → 2026-09 词表化）。
 * 11 个风格模板，对齐 spec §17 Phase 2 交付标准「10+ 风格模板可用」。
 *
 * 2026-09 外部基准升级（temp/prompt-quality-benchmark/benchmark-analysis.md，C9+B8）：
 * - prompt_fragments 从中文散文短语改写为 danbooru 词表英文短语——Anima 方言吃英文 tag，
 *   中文片段只会触发 CJK critical gate / catalog_miss（实测「写实电影」等短语零命中）；
 * - 新增 artistHints：画师是 Anima 画风第一杠杆（NewBie-LLM-Formatter / DanbooruSearch
 *   实证）。全部画师名经 tag-catalog 验证存在（category=artist，2026-09-11，usage_count
 *   见 tests/pe-framework/enrichment/style.test.ts 的存在性断言来源）；存裸名，grounding
 *   命中后经 prompt_form 升级为 @形输出；
 * - negative_hints 同步改英文 tag 词形（现状：数据字段，applyStyle 未接线——接线见后续）。
 * prompt_fragments 为具体名词短语（对齐 spec §7.2 分层：风格库存领域具体名词，不用空泛形容词），
 * 每个风格同时提供 image 与 video 两个通道。
 */
import type { BlueprintV1, Shot } from '../blueprint/schema.js'

export interface StyleTemplate {
  id: string
  name: string
  base?: string                 // 基底风格：媒介/画风
  theme?: string                // 主题风格：赛博朋克/和风/废土（影响场景+配色）
  palette?: string              // 情绪配色
  prompt_fragments: { image: string; video: string }
  /** B8：画师候选（catalog 验证存在的裸名，3 位；投影 → anima artist 槽） */
  artistHints: string[]
  applies_to: string[]          // 适用模型/方言 id
  negative_hints: string[]      // 该风格应规避的负向提示（具体名词）
}

export const MINIMAL_STYLES: StyleTemplate[] = [
  {
    id: 'cinematic_real',
    name: '写实电影',
    base: 'photorealistic',
    palette: 'teal and orange grading',
    prompt_fragments: {
      image: 'IMAX film grain, anamorphic lens flare, teal and orange grading, golden hour ambience, shallow depth of field',
      video: 'IMAX film grain, anamorphic lens flare, teal and orange grading, golden hour ambience, shallow depth of field',
    },
    artistHints: ['guweiz', 'wlop', 'ask (askzy)'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['amateur photography', 'over-sharpened'],
  },
  {
    id: 'game_cg',
    name: '游戏 CG',
    base: 'game CG rendering',
    prompt_fragments: {
      image: 'PBR materials, global illumination, volumetric fog, particle effects, ray-traced reflections',
      video: 'PBR materials, global illumination, volumetric fog, particle effects, ray-traced reflections',
    },
    artistHints: ['mika pikazo', 'gozz', 'as109'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['low-poly', 'blurry textures'],
  },
  {
    id: 'cel_shading',
    name: '赛璐璐',
    base: 'cel shading',
    prompt_fragments: {
      image: 'cel shading, hard two-tone shadows, white highlight accents, crisp lineart, flat colors',
      video: 'cel shading, hard two-tone shadows, white highlight accents, crisp lineart, flat colors',
    },
    artistHints: ['rella', 'atdan', 'satou kibi'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['impasto', 'realistic skin texture'],
  },
  {
    id: 'thick_paint',
    name: '厚涂',
    base: 'impasto painting',
    prompt_fragments: {
      image: 'impasto brush strokes, oil painting texture, warm-cool color blocking, palette knife highlights',
      video: 'impasto brush strokes, oil painting texture, warm-cool color blocking, palette knife highlights',
    },
    artistHints: ['guweiz', 'ask (askzy)', 'wlop'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['cel shading', 'hard two-tone shadows'],
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    theme: 'cyberpunk',
    palette: 'magenta and cyan neon palette',
    prompt_fragments: {
      image: 'neon signs, rain-soaked streets, holographic billboards, wet asphalt reflections',
      video: 'neon signs, rain-soaked streets, holographic billboards, wet asphalt reflections, magenta and cyan neon palette',
    },
    artistHints: ['as109', 'gozz', 'mika pikazo'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['low saturation', 'plastic texture'],
  },
  {
    id: 'wafuu',
    name: '和风',
    theme: 'japanese traditional',
    prompt_fragments: {
      image: 'shoji paper window, tatami mat, wooden eaves, paper lanterns, zen rock garden',
      video: 'shoji paper window, tatami mat, wooden eaves, paper lanterns, zen rock garden',
    },
    artistHints: ['hong (white spider)', 'kantoku', 'satou kibi'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['modern architecture', 'western furniture'],
  },
  {
    id: 'wasteland',
    name: '废土',
    theme: 'post-apocalyptic wasteland',
    prompt_fragments: {
      image: 'rusted metal, swirling sand, derelict vehicles, cracked earth, dust haze',
      video: 'rusted metal, swirling sand, derelict vehicles, cracked earth, dust haze',
    },
    artistHints: ['gozz', 'as109', 'quasarcake'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['busy city', 'lush vegetation'],
  },
  {
    id: 'dark_epic',
    name: '暗黑史诗',
    theme: 'dark fantasy epic',
    palette: 'black and gold palette',
    prompt_fragments: {
      image: 'black and gold palette, gothic spires, heavy dark clouds, ember sparks, polished armor reflections',
      video: 'black and gold palette, gothic spires, heavy dark clouds, ember sparks, polished armor reflections',
    },
    artistHints: ['quasarcake', 'guweiz', 'gozz'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['bright high saturation', 'cartoonish'],
  },
  {
    id: 'watercolor',
    name: '水彩',
    base: 'watercolor',
    prompt_fragments: {
      image: 'watercolor paper texture, wet-on-wet bleeding, soft pastel wash, pencil underdrawing',
      video: 'watercolor paper texture, wet-on-wet bleeding, soft pastel wash, pencil underdrawing',
    },
    artistHints: ['kantoku', 'satou kibi', 'hong (white spider)'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['oil impasto', 'sharp digital edges'],
  },
  {
    id: 'concept_art',
    name: '概念原画',
    base: 'concept art',
    prompt_fragments: {
      image: 'matte painting, bold brush blocks, ambient occlusion shading, sketch-like texture',
      video: 'matte painting, bold brush blocks, ambient occlusion shading, sketch-like texture',
    },
    artistHints: ['gozz', 'guweiz', 'quasarcake'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['photorealistic render', 'glossy advertisement'],
  },
  {
    id: 'fairy_tale',
    name: '童话',
    theme: 'fairy tale',
    palette: 'warm honey tones',
    prompt_fragments: {
      image: 'storybook illustration, mushroom cottage, glowing plants, warm honey tones, soft bokeh',
      video: 'storybook illustration, mushroom cottage, glowing plants, warm honey tones, soft bokeh',
    },
    artistHints: ['kantoku', 'mika pikazo', 'rella'],
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['gothic horror', 'gore'],
  },
]

/**
 * applyStyle：把风格 fragment 并入 core.style 与 media_layer 对应字段；artistHints 写入
 * core.style.artist_hints（B8，投影 → anima artist 槽）。
 * conformity 三档连续语义（spec §7.2「Phase 2 完善语义」，P2-6 两级修复第 2 级）：
 *   =0         全量注入 prompt_fragments（现有行为）；
 *   0<conformity<1  按比例注入前 round(conformity×短语数) 个完整短语（fragment 按中英文逗号拆短语，
 *                至少保留 1 个，杜绝半句话）；
 *   >=1        仅引用不注入（core.style 仍写入 style 字段与 artist_hints，片段不注入 media_layer）。
 * 默认 conformity=0.6 因此走「按比例注入」而非旧「>0 仅引用假档」。
 * 未知 styleId 返回原对象（引用不变）。不修改输入（structuredClone 后改写）。
 */

/** 按中英文逗号拆完整短语，返回前 round(ratio×n) 个（至少 1，不截断半句话） */
function proportionalFragment(fragment: string, conformity: number): string {
  const phrases = fragment.split(/[，,]/).map((p) => p.trim()).filter(Boolean)
  if (phrases.length === 0) return ''
  const count = Math.max(1, Math.min(phrases.length, Math.round(conformity * phrases.length)))
  return phrases.slice(0, count).join(', ')
}

export function applyStyle(bp: BlueprintV1, styleId: string, conformity: number): BlueprintV1 {
  const style = MINIMAL_STYLES.find((s) => s.id === styleId)
  if (!style) return bp

  const out: BlueprintV1 = structuredClone(bp)
  // 合并语义（保 P2 行为）：core.style 已有字段优先（用户 brief 显式风格不被风格库覆盖），风格库只补缺
  out.core.style = {
    ...(style.base ? { base: style.base } : {}),
    ...(style.theme ? { theme: style.theme } : {}),
    ...(style.palette ? { palette: style.palette } : {}),
    ...(out.core.style ?? {}),
    // B8：画师候选无条件写入（conformity 只约束 fragment 注入强度，画师引用是引用层决策）
    artist_hints: [...style.artistHints],
  }

  if (conformity < 1) {
    // 全量（=0）或按比例（0<conformity<1）注入 prompt_fragments 到 media_layer 对应字段
    const ratio = conformity <= 0 ? 1 : conformity
    if (out.media === 'video' || out.media === 'mixed') {
      const video = out.media_layer.video ?? { shots: [] as Shot[] }
      out.media_layer.video = video
      const fragment = style.prompt_fragments.video
      const inject = proportionalFragment(fragment, ratio)
      for (const shot of video.shots) {
        shot.action = shot.action ? `${shot.action}，${inject}` : inject
      }
    }
    if (out.media === 'image' || out.media === 'mixed') {
      const image = out.media_layer.image ?? {}
      out.media_layer.image = image
      const fragment = style.prompt_fragments.image
      const inject = proportionalFragment(fragment, ratio)
      image.lighting_detail = image.lighting_detail ? `${image.lighting_detail}，${inject}` : inject
    }
  }

  return out
}
