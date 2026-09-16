/**
 * S3 确定性后处理 + 回退组装（spec §6/§7 D7，零 LLM）：
 * assemblePositive/assembleNegative = 成文产物的机器拼装（rating 种子、质量词/分级词模板）；
 * deterministicCompose = 确定性回退 writer——纯字符串组装、永不失败（D7：任何情况下不空手出稿）。
 */
import type { WriterOutput } from './writer.js'
import type { RetrievalPack } from '../dialect/retrieval-pack.js'
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'

export type Rating = 'safe' | 'sensitive' | 'explicit'

/** 回退 NL 字符预算（positive = tags + nl ≤ 1200，tags 最多 40×~10 chars，NL 留 600） */
export const NL_CHAR_BUDGET = 600
/** audit P2：回退 tag 字符预算——positive 总长数学保证 ≤ 1200：
 *  rating_explicit(15) + 分隔(', '×2=4) + tags(≤560，tag 间分隔已计入) + nl(≤600) = 1179 */
export const TAG_CHAR_BUDGET = 560
const MAX_FALLBACK_TAGS = 40

/** 负面模板（spec §7：quality 系列 + 分级守卫；现行 policy 词表沿用） */
export const NEGATIVE_TEMPLATE = [
  'worst quality',
  'low quality',
  'score_1',
  'score_2',
  'score_3',
  'artist name',
  'blurry',
  'jpeg artifacts',
  'chromatic aberration',
  'child',
  'loli',
  'shota',
  'toddler',
  'kid',
  'preteen',
  'extra limbs',
]

export function assemblePositive(out: WriterOutput, rating: Rating): string {
  const parts = [`rating_${rating}`, ...out.tags.map((t) => t.text)]
  if (out.nl.trim() !== '') parts.push(out.nl.trim())
  return parts.join(', ')
}

export function assembleNegative(out: WriterOutput): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const n of [...NEGATIVE_TEMPLATE, ...out.negative]) {
    const key = n.trim().toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    parts.push(n.trim())
  }
  return parts.join(', ')
}

/**
 * 确定性回退组装（D7 fail-open）：evidence 按 T3 顺序直取 top hit（@artist 计入），
 * unresolved + composition + lighting + mood 进 NL 模板句（2-4 句）；永不失败。
 */
export function deterministicCompose(bp: SemanticBlueprint, pack: RetrievalPack): WriterOutput {
  // audit P2：tag 按 TAG_CHAR_BUDGET 累计裁剪（分隔符计入）+ 大小写去重 + 40 上限，
  // 保证 assemblePositive 产物恒 ≤ 1200 字符（此前只截 40 个、无字符预算，长词形可超一倍）。
  const seenForms = new Set<string>()
  const tags: Array<{ text: string; source_concept: string }> = []
  let usedChars = 0
  for (const e of pack.evidence) {
    if (tags.length >= MAX_FALLBACK_TAGS) break
    const text = e.hits[0]?.prompt_form ?? ''
    if (text === '') continue
    const key = text.trim().toLowerCase()
    if (seenForms.has(key)) continue
    const cost = (tags.length > 0 ? 2 : 0) + text.length
    if (usedChars + cost > TAG_CHAR_BUDGET) continue
    seenForms.add(key)
    tags.push({ text, source_concept: e.concept })
    usedChars += cost
  }

  const sentences: string[] = []
  const comp = bp.composition
  const framingBits = [comp.framing, comp.camera_angle, comp.placement].filter((s) => s.trim() !== '')
  if (framingBits.length > 0) sentences.push(`The scene is ${framingBits.join(', ')}.`)
  if (bp.core.scene.lighting_idea.trim() !== '') {
    sentences.push(`${bp.core.scene.lighting_idea}, no silhouette.`)
  }
  if (pack.unresolved.length > 0) {
    sentences.push(`${pack.unresolved.map((u) => u.query).join(', ')}.`)
  }
  if (bp.mood.trim() !== '') sentences.push(`${bp.mood}.`)

  // 2026-09-16 活跑实证（gen_1789530728519）：V1 的 lighting_idea/mood 被 enrich 扩成长段 →
  // 回退 NL 整段塞入 → positive 2328 字符超预算（tag_budget critical）。
  // 修：NL 总长截到 NL_CHAR_BUDGET(600)——按句保留，超预算句尾截断。
  // audit P2（2026-09-17）：死变量 bug——此处截断结果此前未真正返回（L83 返回未截断 join），
  // gen_1789535180257 回退产物 2803 字符实证 bug 存活；现返回截断后的 nl。
  const nlJoined = sentences.slice(0, 4).join(' ')
  const nl = nlJoined.length > NL_CHAR_BUDGET ? `${nlJoined.slice(0, NL_CHAR_BUDGET).replace(/\s+\S*$/, '')}…` : nlJoined

  return {
    tags,
    nl,
    negative: [...bp.negative_hints],
    dropped_concepts: [],
  }
}
