/**
 * 硬边界闸门（spec §5.4）——确定性词表 + 纯函数匹配，零 LLM。
 * 语义：minor gate 仅 rating !== 'safe' 时触发（safe 档画儿童合法）；
 * nonconsensual / bestiality 任何档位都拒绝。
 * 匹配（M2 T1 两级语义）：ASCII marker 用 \b<marker>\b 大小写不敏感词边界
 * （消除 kidmo∋kid / drapery∋rape 类子串碰撞；'_' 是词字符，故 lolita_fashion 放行、
 * bare lolita 阻断）；CJK marker 保持 substring includes（CJK 无空格分词，\b 无意义）。
 */
import type { Rating } from '../types.js'

export interface BoundaryViolation {
  gate: 'minor_content_conflict' | 'nonconsensual_content_rejected' | 'bestiality_content_rejected'
  matched: string
}

/** 未成年标记——明确不含 flat_chest、petite 等成人身材词（spec §5.4）。
 *  M2 T1 增补复合变体 lolita/lolicon/shotacon：词边界下 shota 裸词不命中 shotacon 内部，
 *  由独立变体承接；bare lolita/lolicon/shotacon 为未成年语义暗语一律阻断。 */
export const MINOR_MARKERS: readonly string[] = [
  'loli', 'lolita', 'lolicon', 'shota', 'shotacon', 'child', 'children', 'toddler', 'kid', 'preteen',
  '幼女', '萝莉', '正太', '小学生', '儿童', '小孩', '婴儿', 'infant', 'baby',
]

export const NONCONSENT_MARKERS: readonly string[] = [
  'rape', 'raping', 'forced sex', 'non-consensual', 'nonconsensual',
  '强奸', '非自愿', '强迫性行为',
]

export const BESTIALITY_MARKERS: readonly string[] = ['bestiality', 'zoophilia', '兽奸', '人兽']

/** CJK 字符判定（假名 + CJK 统一表意/兼容表意）：命中任一字符的 marker 走 substring 通道。 */
const CJK_MARKER_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface CompiledMarker {
  marker: string
  /** true → corpus.toLowerCase() 后 includes（CJK）；false → \b<marker>\b 'i' 正则测原 corpus */
  cjk: boolean
  re?: RegExp
}

function compileMarkers(markers: readonly string[]): CompiledMarker[] {
  return markers.map((m) =>
    CJK_MARKER_RE.test(m)
      ? { marker: m, cjk: true }
      : { marker: m, cjk: false, re: new RegExp(`\\b${escapeRe(m)}\\b`, 'i') },
  )
}

const MINOR_COMPILED = compileMarkers(MINOR_MARKERS)
const NONCONSENT_COMPILED = compileMarkers(NONCONSENT_MARKERS)
const BESTIALITY_COMPILED = compileMarkers(BESTIALITY_MARKERS)

function firstHit(compiled: CompiledMarker[], low: string, corpus: string): string | undefined {
  const hit = compiled.find(({ cjk, marker, re }) => (cjk ? low.includes(marker) : re!.test(corpus)))
  return hit?.marker
}

export function checkBoundaries(corpus: string, rating: Rating): BoundaryViolation[] {
  const low = corpus.toLowerCase()
  const violations: BoundaryViolation[] = []
  if (rating !== 'safe') {
    const minor = firstHit(MINOR_COMPILED, low, corpus)
    if (minor !== undefined) violations.push({ gate: 'minor_content_conflict', matched: minor })
  }
  const nonconsent = firstHit(NONCONSENT_COMPILED, low, corpus)
  if (nonconsent !== undefined) violations.push({ gate: 'nonconsensual_content_rejected', matched: nonconsent })
  const bestiality = firstHit(BESTIALITY_COMPILED, low, corpus)
  if (bestiality !== undefined) violations.push({ gate: 'bestiality_content_rejected', matched: bestiality })
  return violations
}
