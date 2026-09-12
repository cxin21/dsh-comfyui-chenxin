/**
 * applyStyleV2（spec §4.3）——registry 支撑的风格注入，修复三个死数据问题：
 * ① negative_hints 以 {target, severity:'soft'} 并入 core.negative（与既有 target 大小写不敏感去重）；
 * ② artist_hints 经 slice(0, artist_max) 截断后写入 core.style.artist_hints（候选可多于注入上限）；
 * ③ 未知 styleId 仍返回原对象（引用不变；advisory style_preset_unknown:<id> 由 engine 层补）。
 * conformity 三档语义逐字节不变（自 enrichment/style.ts 平移）：=0 全量注入 /
 * (0,1) 按中英文逗号拆短语按比例注入完整短语（至少 1，不截半句）/ ≥1 仅引用不注入。
 * 不修改输入（structuredClone 后改写）。
 */
import type { BlueprintV1, Shot } from '../blueprint/schema.js'
import { getStylePreset } from './registry.js'

/** 按中英文逗号拆完整短语，返回前 round(ratio×n) 个（至少 1，不截断半句话） */
function proportionalFragment(fragment: string, conformity: number): string {
  const phrases = fragment.split(/[，,]/).map((p) => p.trim()).filter(Boolean)
  if (phrases.length === 0) return ''
  const count = Math.max(1, Math.min(phrases.length, Math.round(conformity * phrases.length)))
  return phrases.slice(0, count).join(', ')
}

export function applyStyle(bp: BlueprintV1, styleId: string, conformity: number): BlueprintV1 {
  const style = getStylePreset(styleId)
  if (!style) return bp

  const out: BlueprintV1 = structuredClone(bp)
  // 合并语义（保 P2 行为）：core.style 已有字段优先（用户 brief 显式风格不被风格库覆盖），风格库只补缺
  out.core.style = {
    ...(style.base ? { base: style.base } : {}),
    ...(style.theme ? { theme: style.theme } : {}),
    ...(style.palette ? { palette: style.palette } : {}),
    ...(out.core.style ?? {}),
    // spec §4.3 ②：artist_max 截断（画师引用是引用层决策，conformity 只约束 fragment 注入强度）
    artist_hints: style.artist_hints.slice(0, style.artist_max),
  }

  // spec §4.3 ①：negative_hints 并入 core.negative（soft 级；与既有 target 大小写不敏感去重）
  const negatives = out.core.negative ?? []
  for (const hint of style.negative_hints) {
    if (!negatives.some((n) => n.target.toLowerCase() === hint.toLowerCase())) {
      negatives.push({ target: hint, severity: 'soft' })
    }
  }
  out.core.negative = negatives

  if (conformity < 1) {
    // 全量（=0）或按比例（0<conformity<1）注入 fragments 到 media_layer 对应字段
    const ratio = conformity <= 0 ? 1 : conformity
    if (out.media === 'video' || out.media === 'mixed') {
      const video = out.media_layer.video ?? { shots: [] as Shot[] }
      out.media_layer.video = video
      const fragment = style.fragments.video
      const inject = proportionalFragment(fragment, ratio)
      for (const shot of video.shots) {
        shot.action = shot.action ? `${shot.action}，${inject}` : inject
      }
    }
    if (out.media === 'image' || out.media === 'mixed') {
      const image = out.media_layer.image ?? {}
      out.media_layer.image = image
      const fragment = style.fragments.image
      const inject = proportionalFragment(fragment, ratio)
      image.lighting_detail = image.lighting_detail ? `${image.lighting_detail}，${inject}` : inject
    }
  }

  return out
}
