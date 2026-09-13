import { defineTool } from '@deepseek-ai/dsh-tools'
import { listStylePresets, loadStylePresets } from '../pe-framework/styles/registry.js'
import { RATING_ORDER, type StyleCategory } from '../pe-framework/styles/schema.js'
import type { Rating } from '../pe-framework/types.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

const CATEGORIES: readonly StyleCategory[] = [
  'photography', 'anime', 'illustration', 'cg_3d', 'oriental',
  'dark_supernatural', 'scifi_fantasy', 'retro', 'graphic', 'glamour_intimate',
]
const APPLIES_TO = ['anima', 'h3', 'sd'] as const

/** 只读查询（无 LLM）：风格预设库检索（spec §9）→ JSON 摘要数组 */
export function registerStyleListTool(_ctx: Context, _config: Config) {
  // 审计 #5（2026-09-12）：描述条数不再硬编码——注册时经 loadStylePresets().presets.length
  // 动态插值（registry 模块内缓存，注册期一次性零额外成本；库增减后重启自愈，消漂移类）。
  const presetCount = loadStylePresets().presets.length
  return defineTool({
    name: 'style_list',
    description:
      `风格预设库查询（spec §9）：按 category/rating/applies_to/关键字过滤 ${presetCount} 条 v2 风格预设；只读零 LLM。rating 为会话内容分级上限（序 safe < sensitive < explicit，preset.rating ≤ 上限才可见），缺省不过滤。`,
    parameters: {
      category: { type: 'string', enum: [...CATEGORIES], description: '风格大类过滤（十类之一）' },
      rating: { type: 'string', enum: [...RATING_ORDER], description: '会话内容分级上限（safe/sensitive/explicit）：preset.rating ≤ 上限才可见；缺省不过滤' },
      applies_to: { type: 'string', enum: [...APPLIES_TO], description: '适用模型过滤：anima/h3/sd' },
      query: { type: 'string', description: '关键字：匹配 id/name 子串（大小写不敏感）' },
    },
    output: {
      schema: { type: 'string', description: 'JSON 数组 [{id,name,category,rating,artistCount,negativeCount,source}]' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { category?: string; rating?: string; applies_to?: string; query?: string }) {
      let category: StyleCategory | undefined
      if (args.category !== undefined) {
        const c = String(args.category)
        if (!(CATEGORIES as readonly string[]).includes(c)) throw new Error(`style_list: category must be one of ${CATEGORIES.join('/')}`)
        category = c as StyleCategory
      }
      let maxRating: Rating | undefined
      if (args.rating !== undefined) {
        const r = String(args.rating)
        if (!(RATING_ORDER as readonly string[]).includes(r)) throw new Error(`style_list: rating must be one of ${RATING_ORDER.join('/')}`)
        maxRating = r as Rating
      }
      let appliesTo: (typeof APPLIES_TO)[number] | undefined
      if (args.applies_to !== undefined) {
        const a = String(args.applies_to)
        if (!(APPLIES_TO as readonly string[]).includes(a)) throw new Error('style_list: applies_to must be one of anima/h3/sd')
        appliesTo = a as (typeof APPLIES_TO)[number]
      }
      const query = args.query !== undefined && String(args.query).trim() !== '' ? String(args.query) : undefined
      const presets = listStylePresets({ category, maxRating, appliesTo, query })
      return JSON.stringify(
        presets.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          rating: p.rating,
          artistCount: p.artist_hints.length,
          negativeCount: p.negative_hints.length,
          source: p.source,
        })),
      )
    },
  })
}
