/**
 * 硬边界闸门（spec §5.4）——确定性词表 + 纯函数匹配，零 LLM。
 * 语义：minor gate 仅 rating !== 'safe' 时触发（safe 档画儿童合法）；
 * nonconsensual / bestiality 任何档位都拒绝；匹配大小写不敏感（corpus toLowerCase 后 includes，CJK 直接 includes）。
 */
import type { Rating } from '../types.js'

export interface BoundaryViolation {
  gate: 'minor_content_conflict' | 'nonconsensual_content_rejected' | 'bestiality_content_rejected'
  matched: string
}

/** 未成年标记——明确不含 flat_chest、petite 等成人身材词（spec §5.4） */
export const MINOR_MARKERS: readonly string[] = [
  'loli', 'shota', 'child', 'children', 'toddler', 'kid', 'preteen',
  '幼女', '萝莉', '正太', '小学生', '儿童', '小孩', '婴儿', 'infant', 'baby',
]

export const NONCONSENT_MARKERS: readonly string[] = [
  'rape', 'raping', 'forced sex', 'non-consensual', 'nonconsensual',
  '强奸', '非自愿', '强迫性行为',
]

export const BESTIALITY_MARKERS: readonly string[] = ['bestiality', 'zoophilia', '兽奸', '人兽']

export function checkBoundaries(corpus: string, rating: Rating): BoundaryViolation[] {
  const low = corpus.toLowerCase()
  const violations: BoundaryViolation[] = []
  if (rating !== 'safe') {
    const minor = MINOR_MARKERS.find((m) => low.includes(m))
    if (minor !== undefined) violations.push({ gate: 'minor_content_conflict', matched: minor })
  }
  const nonconsent = NONCONSENT_MARKERS.find((m) => low.includes(m))
  if (nonconsent !== undefined) violations.push({ gate: 'nonconsensual_content_rejected', matched: nonconsent })
  const bestiality = BESTIALITY_MARKERS.find((m) => low.includes(m))
  if (bestiality !== undefined) violations.push({ gate: 'bestiality_content_rejected', matched: bestiality })
  return violations
}
