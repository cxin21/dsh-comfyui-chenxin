/**
 * 内容分级定档 + 三档策略表（spec §5.1-5.3）——纯确定性数据与纯函数，零 LLM。
 * Rating 序：safe < sensitive < explicit（定义于 types.ts）。
 */
import type { Rating } from '../types.js'
// type-only import：编译期取 AnimaSlots 形状，运行时零依赖，规避与 dialect 层的环。
import type { AnimaSlots } from '../dialect/anima.js'

/** types.py EXPLICIT_SAFETY_MARKERS 逐字（自 dialect/anima.ts 平移，原位再导出保兼容） */
export const EXPLICIT_MARKERS: readonly string[] = [
  'explicit', 'nude', 'nudity', 'genitals', 'genital', 'vulva', 'penis',
  '乳头', '乳房', '生殖器', '阴部', '阴茎', '阴道', '隐私部位', '裸露', '露骨', '色情', 'pornographic', 'nsfw',
]

/** 敏感（非露骨）标记词表：任一命中即 sensitive（spec §5.2） */
export const SENSITIVE_MARKERS: readonly string[] = ['swimsuit', 'bikini', 'lingerie', 'underwear', 'cleavage', 'seductive', '泳装', '内衣', '性感', '撩人']

/** 关键词扫描：显式/敏感双命中取高（explicit > sensitive），未命中 safe */
function keywordRating(corpus: string): Rating {
  const low = corpus.toLowerCase()
  if (EXPLICIT_MARKERS.some((m) => low.includes(m))) return 'explicit'
  if (SENSITIVE_MARKERS.some((m) => low.includes(m))) return 'sensitive'
  return 'safe'
}

/**
 * 定档（spec §5.2）：显式输入优先——输入非空时关键词不覆盖用户声明（不升级、不记 escalatedFrom）；
 * 输入缺省时按关键词定档，自 safe 地板提升时记 escalatedFrom='safe'（供编排层出 rating_escalated advisory）。
 */
export function resolveRating(
  input: Rating | undefined,
  corpus: string,
): { rating: Rating; escalatedFrom?: Rating; source: 'input' | 'keyword' } {
  if (input) return { rating: input, source: 'input' }
  const kw = keywordRating(corpus)
  return kw === 'safe'
    ? { rating: 'safe', source: 'keyword' }
    : { rating: kw, escalatedFrom: 'safe', source: 'keyword' }
}

/** positive 端分级锚 tag（装配 3b 用，spec §5.3） */
export const RATING_SEEDS: Record<Rating, readonly string[]> = {
  safe: ['safe'],
  sensitive: ['rating_sensitive'],
  explicit: ['rating_explicit'],
}

/** negative 端策略追加（policy 通道）：sensitive 阻断 explicit 词汇；explicit 阻断未成年硬排除 */
export const RATING_NEGATIVE_ADDITIONS: Record<Rating, readonly string[]> = {
  safe: [],
  sensitive: ['nude', 'nudity', 'genitals', 'rating_explicit'],
  explicit: ['child', 'loli', 'shota', 'toddler', 'kid', 'preteen'],
}

/**
 * slots → 有效分级（spec §5.3）：slots.rating > explicit 布尔 > 全槽关键词扫描 > safe。
 * 入参 AnimaSlots & { rating?: Rating }：rating 槽由 Task 8 正式加入 AnimaSlots，此处结构前向兼容。
 */
export function resolveEffectiveRating(slots: AnimaSlots & { rating?: Rating }): Rating {
  if (slots.rating) return slots.rating
  if (slots.explicit === true) return 'explicit'
  const pieces: string[] = []
  for (const value of Object.values(slots)) {
    if (Array.isArray(value)) pieces.push(...value.map((t) => String(t)))
    else if (typeof value === 'string') pieces.push(value)
  }
  return keywordRating(pieces.join(' '))
}
