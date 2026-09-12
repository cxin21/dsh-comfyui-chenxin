/** 风格预设 v2 schema（spec §4.1）——纯类型 + 确定性校验器 */
import type { Rating } from '../types.js'

// RATING_ORDER 定义在 types.ts（Global Constraints：Rating 序类型与 AuditGate 同处）；
// 此处再导出以满足「从 schema 模块导入」的测试契约（计划偏差修正，见提交说明）。
export { RATING_ORDER } from '../types.js'

export type StyleCategory =
  | 'photography' | 'anime' | 'illustration' | 'cg_3d' | 'oriental'
  | 'dark_supernatural' | 'scifi_fantasy' | 'retro' | 'graphic' | 'glamour_intimate'

const CATEGORIES: readonly StyleCategory[] = [
  'photography', 'anime', 'illustration', 'cg_3d', 'oriental',
  'dark_supernatural', 'scifi_fantasy', 'retro', 'graphic', 'glamour_intimate',
]
const RATINGS: readonly Rating[] = ['safe', 'sensitive', 'explicit']

export interface StylePresetV2 {
  id: string
  name: string
  category: StyleCategory
  rating: Rating
  base?: string
  theme?: string
  palette?: string
  fragments: { image: string; video: string }
  negative_hints: string[]
  artist_hints: string[]
  artist_max: number
  applies_to: ('anima' | 'h3' | 'sd')[]
  art_direction_hints?: Partial<Record<'perspective' | 'composition' | 'lighting' | 'color' | 'motion', string>>
  source: string
}

function isNonEmptyString(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0 }
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null }

export function validateStylePreset(v: unknown): { ok: true; value: StylePresetV2 } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ['preset must be an object'] }
  if (!isNonEmptyString(v['id'])) errors.push('id must be a non-empty string')
  if (!isNonEmptyString(v['name'])) errors.push('name must be a non-empty string')
  if (!CATEGORIES.includes(v['category'] as StyleCategory)) errors.push(`category must be one of ${CATEGORIES.join('|')}`)
  if (!RATINGS.includes(v['rating'] as Rating)) errors.push('rating must be safe|sensitive|explicit')
  const frag = v['fragments']
  if (!isRecord(frag) || !isNonEmptyString(frag['image']) || !isNonEmptyString(frag['video'])) {
    errors.push('fragments.image/fragments.video must be non-empty strings')
  }
  if (!Array.isArray(v['negative_hints']) || v['negative_hints'].length < 1) errors.push('negative_hints must be a non-empty array')
  if (!Array.isArray(v['artist_hints'])) errors.push('artist_hints must be an array')
  const am = v['artist_max']
  if (typeof am !== 'number' || !Number.isFinite(am) || am < 1) errors.push('artist_max must be a number >= 1')
  if (!Array.isArray(v['applies_to']) || v['applies_to'].length < 1) errors.push('applies_to must be a non-empty array')
  if (!isNonEmptyString(v['source'])) errors.push('source must be a non-empty string')
  if (errors.length > 0) return { ok: false, errors }
  // spec §4.1：nsfw 预设只能 anima
  if ((v['rating'] === 'sensitive' || v['rating'] === 'explicit')) {
    const ap = v['applies_to'] as unknown[]
    if (ap.length !== 1 || ap[0] !== 'anima') errors.push('sensitive/explicit presets must apply to ["anima"] only')
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: v as unknown as StylePresetV2 }
}
