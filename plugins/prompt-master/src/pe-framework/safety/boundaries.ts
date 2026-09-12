/**
 * 硬边界闸门（spec §5.4）——确定性词表 + 纯函数匹配，零 LLM。
 * 语义：minor gate 仅 rating !== 'safe' 时触发（safe 档画儿童合法）；
 * nonconsensual / bestiality 任何档位都拒绝。
 * 匹配（M2 T1 两级语义 + T1b 复数收口）：ASCII marker 用 \b<marker>(?:s|es|ren)?\b
 * 大小写不敏感后缀模式（词边界消除 kidmo∋kid / drapery∋rape 类子串碰撞的语义保持——
 * 后缀组可选不改变首/尾边界判定；'_' 是词字符，故 lolita_fashion/lolitas_fashion 放行、
 * bare lolita/lolitas 阻断；kids/lolis/lolitas/toddlers/infants/children(child+ren 冗余
 * 无害)/shotacons 由后缀组覆盖）；y→ies 词干变形复数无法由后缀组覆盖（babies/bestialities
 * 无 'y'），由 PLURAL_VARIANTS 显式变体表承接；CJK marker 保持 substring includes。
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

/**
 * 词干变形复数显式变体表（M2 T1b）：y→ies 类不规则复数——后缀模式 (?:s|es|ren) 无法覆盖
 * （复数形不含词干尾 'y'），按 marker→复数形显式枚举；变体词以同一后缀模式编译（matched
 * 报告变体词本身）。全表 y 结尾 ASCII 词扫描结论（任务面 20E+10S+minor + 保守延伸）：
 * - MINOR_MARKERS：baby（→babies，captain 点名关键点）；
 * - BESTIALITY_MARKERS：bestiality（→bestialities）——超出任务字面扫描范围，但为硬闸门
 *   （全档拒绝）的同类逃逸，按 M1 ⑤a「保守方向扩表」先例纳入，备案；
 * - NONCONSENT_MARKERS：无 y 结尾 ASCII 词（rape/raping/forced sex/non-consensual/
 *   nonconsensual 均不以 y 结尾）；
 * - rating 侧 EXPLICIT 表 y 结尾词（pussy→pussies、nudity→nudities）在 rating.ts 词表内
 *   处置（substring 语义无编译机制，直接收录复数形态；扫描结论注释同源留痕）。
 * 变体误伤面评估：babies/bestialities 无合法英文同形词，substring 不参与（\b 通道），
 * 过度阻断风险为零。
 */
export const PLURAL_VARIANTS: Readonly<Record<string, string>> = {
  baby: 'babies',
  bestiality: 'bestialities',
}

/** CJK 字符判定（假名 + CJK 统一表意/兼容表意）：命中任一字符的 marker 走 substring 通道。 */
const CJK_MARKER_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface CompiledMarker {
  marker: string
  /** true → corpus.toLowerCase() 后 includes（CJK）；false → \b<marker>(?:s|es|ren)?\b 'i' 正则测原 corpus */
  cjk: boolean
  re?: RegExp
}

function compileMarkers(markers: readonly string[]): CompiledMarker[] {
  const compiled: CompiledMarker[] = []
  for (const m of markers) {
    if (CJK_MARKER_RE.test(m)) {
      compiled.push({ marker: m, cjk: true })
      continue
    }
    // M2 T1b 后缀模式：(?:s|es|ren)? 覆盖规则复数（kids/lolis/lolitas/toddlers/infants/
    // children(child+ren 冗余无害)/shotacons）；变体词与原词同模式编译。
    const re = new RegExp(`\\b${escapeRe(m)}(?:s|es|ren)?\\b`, 'i')
    compiled.push({ marker: m, cjk: false, re })
    const variant = PLURAL_VARIANTS[m]
    if (variant !== undefined) {
      compiled.push({ marker: variant, cjk: false, re: new RegExp(`\\b${escapeRe(variant)}(?:s|es|ren)?\\b`, 'i') })
    }
  }
  return compiled
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
