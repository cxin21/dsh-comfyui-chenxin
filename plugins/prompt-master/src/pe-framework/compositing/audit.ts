/**
 * S4 确定性审计（spec 2026-09-17 agentic-pipeline-redesign §6）：成文产物的机器契约谓词集。
 * 任一 critical → 进修复轮（同时审计 LLM 每轮必跑，A3——本门不再承担全部审核职责）。
 * 词表复用 dialect/anima.ts 单一事实源（LIGHTING_BAN / FRAMING_MISMATCH / MUTUAL_EXCLUSIONS）。
 * fabricated_tag（A5）：tag 合法性经注入 verifyTag 直查 catalog（canonical/alias/artist），不再依赖检索包。
 * 检索包依赖已随 S2.5 层废除（A1）：unresolved_dropped 门删除。
 */
import type { WriterOutput } from './writer.js'
import { assemblePositive } from './compose.js'
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'
import { detectTagForm } from '../blueprint/semantic-schema.js'
import { LIGHTING_BAN, FRAMING_MISMATCH, MUTUAL_EXCLUSIONS } from '../dialect/anima.js'

export type Rating = 'safe' | 'sensitive' | 'explicit'
export type GateSeverity = 'minor' | 'important' | 'critical'

export interface CompositingGate {
  rule: string
  severity: GateSeverity
  detail: string
  source: 'compositing/audit'
}

export interface AuditOptions {
  /** A5：tag 合法性直查（canonical/alias/artist 命中 = true）；缺省 → fabricated_tag 门跳过 */
  verifyTag?: (tag: string) => boolean
  rating: Rating
  minTags?: number
  maxTags?: number
  maxChars?: number
  overlapThreshold?: number
  /** bge-base-en-v1.5 相似度注入点（nl 句 × tag）；不可用时传 undefined → 仅词面 + advisory */
  vectorSim?: (nlSentence: string, tag: string) => number | undefined
}

const MIN_TAGS = 20
const MAX_TAGS = 40
const MAX_CHARS = 1200
const OVERLAP_THRESHOLD = 0.85

const norm = (s: string): string => s.trim().toLowerCase()

/** NL 分句（nl_tag_overlap 与 vector-sim prewarm 共用单一事实源，防切分漂移；audit P1） */
export function splitNlSentences(nl: string): string[] {
  return nl.split(/(?<=\.)\s+/).filter((s) => s.trim() !== '')
}

export function auditCompositing(
  out: WriterOutput,
  bp: SemanticBlueprint,
  opts: AuditOptions,
): CompositingGate[] {
  const gates: CompositingGate[] = []
  const push = (rule: string, severity: GateSeverity, detail: string): void => {
    gates.push({ rule, severity, detail, source: 'compositing/audit' })
  }

  // fabricated_tag（A5）：tag.text 必须经 verifyTag 直查 catalog 命中（canonical/alias/artist）
  if (opts.verifyTag) {
    for (const t of out.tags) {
      if (!opts.verifyTag(t.text)) {
        push('fabricated_tag', 'critical', `tag '${t.text}' not verified in catalog; required_fix: query catalog for the real prompt_form or move the concept to NL`)
      }
    }
  }

  // duplicate_tag（2026-09-16 用户裁决：审核层四查之一——重复 tag 可机检）：规范化后精确重复
  const seenTexts = new Set<string>()
  for (const t of out.tags) {
    if (seenTexts.has(norm(t.text))) {
      push('duplicate_tag', 'critical', `duplicate tag '${t.text}' (source_concept ${t.source_concept}); required_fix: keep one, merge the other into NL if it adds relation/exposure info`)
    }
    seenTexts.add(norm(t.text))
  }

  // tag_order（T3 权重序的可机检投影）：已知 rank 的 tag 序列必须非降——违反 = important
  // （搭车反馈；顺序"通顺"的语义级判断归审计 LLM 维度 E）
  const ORDER_RANK: Array<[RegExp, number]> = [
    [/^S\d+\.identity$/, 1],
    [/^core\.style_hints/, 2], // artist 槽
    [/^S\d+\.appearance$/, 3],
    [/^S\d+\.pose$/, 4],
    [/^S\d+\.expression$/, 5],
    [/^composition\.(framing|camera_angle)$/, 6],
    [/^core\.scene\./, 7],
    [/^mood$/, 8],
  ]
  const rankOf = (sourceConcept: string): number | undefined => {
    for (const [re, r] of ORDER_RANK) if (re.test(sourceConcept)) return r
    return undefined
  }
  let lastRank = -1
  let orderViolations = 0
  for (const t of out.tags) {
    const r = rankOf(t.source_concept)
    if (r === undefined) continue
    if (r < lastRank) {
      push('tag_order', 'important', `tag '${t.text}' (${t.source_concept}, rank ${r}) breaks T3 weight order after rank ${lastRank}`)
      orderViolations++
      if (orderViolations >= 5) break
    } else {
      lastRank = r
    }
  }

  // nl_tag_overlap：词面包含 或 bge-base-en-v1.5 余弦 ≥ 阈值（spec §7 D6）
  const sentences = splitNlSentences(out.nl)
  let vectorUnavailable = false
  let vectorChecked = false
  for (const s of sentences) {
    for (const t of out.tags) {
      if (norm(s).includes(norm(t.text))) {
        push('nl_tag_overlap', 'critical', `NL sentence restates tag '${t.text}': "${s.slice(0, 120)}"`)
        continue
      }
      if (opts.vectorSim) {
        const sim = opts.vectorSim(s, t.text)
        vectorChecked = true
        if (sim !== undefined && sim >= (opts.overlapThreshold ?? OVERLAP_THRESHOLD)) {
          push('nl_tag_overlap', 'critical', `NL sentence semantically overlaps tag '${t.text}' (sim=${sim.toFixed(2)}): "${s.slice(0, 120)}"`)
        }
      } else {
        vectorUnavailable = true
      }
    }
  }
  if (vectorUnavailable && !vectorChecked) {
    push('overlap_vector_unavailable', 'minor', 'vectorSim not provided; nl_tag_overlap checked lexically only')
  }

  // tag_in_blueprint：V1 蓝图文本字段零 tag 形态（D3；S1 解析层同款谓词）
  const bpPaths: string[] = []
  const scan = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (detectTagForm(node)) bpPaths.push(path || '(root)')
      return
    }
    if (Array.isArray(node)) {
      node.forEach((x, i) => scan(x, `${path}[${i}]`))
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) scan(v, path ? `${path}.${k}` : k)
    }
  }
  scan(bp, '')
  if (bpPaths.length > 0) push('tag_in_blueprint', 'critical', `blueprint fields contain tag-form words: ${bpPaths.join(',')}`)

  // tag_budget：数量 + 字符（spec §6 T7）。writer 可自由查字典，20 下限恢复硬门。
  const min = opts.minTags ?? MIN_TAGS
  const max = opts.maxTags ?? MAX_TAGS
  const maxChars = opts.maxChars ?? MAX_CHARS
  if (out.tags.length < min || out.tags.length > max) {
    push('tag_budget', 'critical', `tag count ${out.tags.length} outside [${min},${max}]`)
  }
  const positive = assemblePositive(out, opts.rating)
  if (positive.length > maxChars) {
    push('tag_budget', 'critical', `positive ${positive.length} chars > ${maxChars}`)
  }

  // mutual_exclusion：tag 对（沿 anima 词表，severity=important 沿现行语义）
  const tagNorms = out.tags.map((t) => norm(t.text))
  for (const [first, second] of MUTUAL_EXCLUSIONS) {
    if (tagNorms.some((t) => t.includes(norm(first))) && tagNorms.some((t) => t.includes(norm(second)))) {
      push('mutual_exclusion', 'important', `mutually exclusive tags: ${first} + ${second}`)
    }
  }

  // framing_consistency：framing term → 取景外内容 tag（沿 anima FRAMING_MISMATCH 表）
  const framingText = norm(`${bp.composition.framing} ${out.tags.map((t) => t.text).join(' ')}`)
  for (const [framing, mismatches] of FRAMING_MISMATCH) {
    if (framingText.includes(framing)) {
      for (const m of mismatches) {
        if (tagNorms.some((t) => t.includes(norm(m)))) {
          push('framing_consistency', 'important', `framing '${framing}' excludes '${m}' (out of frame)`)
        }
      }
    }
  }

  // lighting_term_banned：positive 命中 LIGHTING_BAN 词表（沿 anima 部署禁令）
  const bannedLight = LIGHTING_BAN.filter((term) => positive.toLowerCase().includes(term)).sort()
  if (bannedLight.length > 0) {
    push('lighting_term_banned', 'critical', `banned lighting terms in positive: ${bannedLight.join(', ')}; light must be written as scene objects`)
  }

  // cjk_in_positive
  if (/[\u4e00-\u9fff]/.test(positive)) {
    push('cjk_in_positive', 'critical', 'CJK characters in positive; writer output must be English')
  }

  // rating_seed：positive 缺档位种子词（确定性注入缺失即违规）
  if (!positive.includes(`rating_${opts.rating}`)) {
    push('rating_seed', 'critical', `positive missing rating seed 'rating_${opts.rating}'`)
  }

  // artist_whitelist：@tag 必须经 verifyTag 命中（artist registry）
  if (opts.verifyTag) {
    for (const t of out.tags) {
      if (t.text.startsWith('@') && !opts.verifyTag(t.text)) {
        push('artist_whitelist', 'critical', `artist tag '${t.text}' not verified in catalog artist registry`)
      }
    }
  }

  return gates
}
