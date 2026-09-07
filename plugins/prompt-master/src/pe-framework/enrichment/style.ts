/**
 * 最小风格库（spec §7.2 风格库分层；Phase 1 v0 → Phase 2 内容深化）。
 * Phase 2 在 8 个基础上新增 spec §7.2 列出的候选基底/主题：水彩、概念原画、童话，共 11 个，
 * 对齐 spec §17 Phase 2 交付标准「10+ 风格模板可用」。
 * prompt_fragments 为具体名词片段（对齐 spec §7.2 分层：风格库存领域具体名词，不用空泛形容词），
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
  applies_to: string[]          // 适用模型/方言 id
  negative_hints: string[]      // 该风格应规避的负向提示（具体名词）
}

export const MINIMAL_STYLES: StyleTemplate[] = [
  {
    id: 'cinematic_real',
    name: '写实电影',
    base: '写实电影',
    palette: '青橙色彩分级',
    prompt_fragments: {
      image: 'IMAX 胶片质感，Panavision C 系 35mm f4，伦勃朗光，黄昏黄金时刻，青橙色彩分级',
      video: 'IMAX 胶片质感，Panavision C 系 35mm f4，伦勃朗光，黄昏黄金时刻，青橙色彩分级',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['手机摄影感', '过度锐化'],
  },
  {
    id: 'game_cg',
    name: '游戏 CG',
    base: '游戏 CG',
    prompt_fragments: {
      image: '次世代 PBR 材质，全局光照，体积雾，粒子特效，电影级景深',
      video: '次世代 PBR 材质，全局光照，体积雾，粒子特效，电影级景深',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['低多边形感', '贴图模糊'],
  },
  {
    id: 'cel_shading',
    name: '赛璐璐',
    base: '赛璐璐',
    prompt_fragments: {
      image: '赛璐璐上色，硬阴影二分，高光留白，手绘线稿轮廓',
      video: '赛璐璐上色，硬阴影二分，高光留白，手绘线稿轮廓',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['厚涂笔触', '写实皮肤纹理'],
  },
  {
    id: 'thick_paint',
    name: '厚涂',
    base: '厚涂',
    prompt_fragments: {
      image: '厚涂肌理笔触，油画布质感，冷暖色块过渡，刀刮堆叠高光',
      video: '厚涂肌理笔触，油画布质感，冷暖色块过渡，刀刮堆叠高光',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['赛璐璐平涂', '硬阴影二分'],
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    theme: '赛博朋克',
    palette: '青品红霓虹配色',
    prompt_fragments: {
      image: '霓虹灯牌，雨夜街道镜面反光，全息投影广告，潮湿柏油路面',
      video: '霓虹灯牌，雨夜街道镜面反光，全息投影广告，潮湿柏油路面，赛博朋克青品红配色',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['低饱和', '塑料质感'],
  },
  {
    id: 'wafuu',
    name: '和风',
    theme: '和风',
    prompt_fragments: {
      image: '障子纸窗透光，榻榻米纹理，木构屋檐，和纸灯笼暖光，枯山水石组',
      video: '障子纸窗透光，榻榻米纹理，木构屋檐，和纸灯笼暖光，枯山水石组',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['现代建筑', '西式陈设'],
  },
  {
    id: 'wasteland',
    name: '废土',
    theme: '废土',
    prompt_fragments: {
      image: '锈蚀金属，黄沙漫卷，报废载具残骸，焦土裂缝，核冬天灰霾',
      video: '锈蚀金属，黄沙漫卷，报废载具残骸，焦土裂缝，核冬天灰霾',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['繁华都市', '绿色植被'],
  },
  {
    id: 'dark_epic',
    name: '暗黑史诗',
    theme: '暗黑史诗',
    palette: '黑金配色',
    prompt_fragments: {
      image: '黑金配色，哥特尖顶剪影，翻涌暗云，熔岩余烬，铠甲金属反光',
      video: '黑金配色，哥特尖顶剪影，翻涌暗云，熔岩余烬，铠甲金属反光',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['明亮高饱和', '卡通质感'],
  },
  {
    id: 'watercolor',
    name: '水彩',
    base: '水彩',
    prompt_fragments: {
      image: '水彩纸纹理留白，湿润晕染边缘，淡彩透明叠色，铅笔淡稿线条',
      video: '水彩纸纹理留白，湿润晕染边缘，淡彩透明叠色，铅笔淡稿线条',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['油画厚涂肌理', '写实锐化边缘'],
  },
  {
    id: 'concept_art',
    name: '概念原画',
    base: '概念原画',
    prompt_fragments: {
      image: '哑光概念原画，硬边笔刷块面，暗部环境光遮蔽，材质速写纹理',
      video: '哑光概念原画，硬边笔刷块面，暗部环境光遮蔽，材质速写纹理',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['照片写实渲染', '商业广告质感'],
  },
  {
    id: 'fairy_tale',
    name: '童话',
    theme: '童话',
    palette: '温暖蜂蜜色',
    prompt_fragments: {
      image: '手绘童话绘本线条，蘑菇屋，发光植物，暖黄窗光，柔光光斑',
      video: '手绘童话绘本线条，蘑菇屋，发光植物，暖黄窗光，柔光光斑',
    },
    applies_to: ['anima', 'h3', 'sd'],
    negative_hints: ['哥特暗黑', '血腥恐怖'],
  },
]

/**
 * applyStyle：把风格 fragment 并入 core.style 与 media_layer 对应字段。
 * conformity=0 全按模板（注入 prompt_fragments 到 media_layer）；conformity>0 仅注入 style 引用不注入片段
 * （=1 完全不注入片段；中间值按 v0 确定性地取"仅引用"侧，对齐计划「=0 全按模板，=1 仅引用」两极）。
 * 未知 styleId 返回原对象（引用不变）。不修改输入（structuredClone 后改写）。
 */
export function applyStyle(bp: BlueprintV1, styleId: string, conformity: number): BlueprintV1 {
  const style = MINIMAL_STYLES.find((s) => s.id === styleId)
  if (!style) return bp

  const out: BlueprintV1 = structuredClone(bp)
  out.core.style = {
    ...(out.core.style ?? {}),
    ...(style.base ? { base: style.base } : {}),
    ...(style.theme ? { theme: style.theme } : {}),
    ...(style.palette ? { palette: style.palette } : {}),
  }

  if (conformity === 0) {
    // 全按模板：注入 prompt_fragments 到 media_layer 对应字段
    if (out.media === 'video' || out.media === 'mixed') {
      const video = out.media_layer.video ?? { shots: [] as Shot[] }
      out.media_layer.video = video
      const fragment = style.prompt_fragments.video
      for (const shot of video.shots) {
        shot.action = shot.action ? `${shot.action}，${fragment}` : fragment
      }
    }
    if (out.media === 'image' || out.media === 'mixed') {
      const image = out.media_layer.image ?? {}
      out.media_layer.image = image
      const fragment = style.prompt_fragments.image
      image.lighting_detail = image.lighting_detail ? `${image.lighting_detail}，${fragment}` : fragment
    }
  }

  return out
}
