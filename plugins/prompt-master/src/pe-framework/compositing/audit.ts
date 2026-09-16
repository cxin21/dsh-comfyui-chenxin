/**
 * S4 确定性审计（spec §7，零 LLM）：成文产物的机器契约谓词集。
 * 任一 critical → 直接进修复轮（不烧 judge，judge rule_critical 跳审语义不变）。
 * 词表复用 dialect/anima.ts 单一事实源（LIGHTING_BAN / FRAMING_MISMATCH / MUTUAL_EXCLUSIONS）。
 */
import type { WriterOutput } from './writer.js'
import { assemblePositive } from './compose.js'
import type { RetrievalPack } from '../dialect/retrieval-pack.js'
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
  /** bge-base-en-v1.5 相似度注入点（nl 句 × tag）；不可用时传 undefined → 仅词面 + advisory */
  vectorSim?: (nlSentence: string, tag: string) => number | undefined
  rating: Rating
  minTags?: number
  maxTags?: number
  maxChars?: number
  overlapThreshold?: number
}

const MIN_TAGS = 20
const MAX_TAGS = 40
const MAX_CHARS = 1200
const OVERLAP_THRESHOLD = 0.85

const norm = (s: string): string => s.trim().toLowerCase()

export function auditCompositing(
  out: WriterOutput,
  pack: RetrievalPack,
  bp: SemanticBlueprint,
  opts: AuditOptions,
): CompositingGate[] {
  const gates: CompositingGate[] = []
  const push = (rule: string, severity: GateSeverity, detail: string): void => {
    gates.push({ rule, severity, detail, source: 'compositing/audit' })
  }

  // fabricated_tag：tag.text 必须能在检索包（evidence ∪ artists）中回查命中（spec §7）
  const known = new Set<string>()
  for (const e of pack.evidence) for (const h of e.hits) known.add(norm(h.prompt_form))
  for (const a of pack.artists) known.add(norm(a.prompt_form))
  for (const t of out.tags) {
    if (!known.has(norm(t.text))) {
      push('fabricated_tag', 'critical', `tag '${t.text}' not in retrieval evidence; required_fix: use evidence prompt_form or move to NL`)
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
  // （搭车反馈；顺序"通顺"的语义级判断归 judge tag-selection 维度）
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
  const sentences = out.nl.split(/(?<=\.)\s+/).filter((s) => s.trim() !== '')
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

  // unresolved_dropped：unresolved 概念必须 ∈ NL 或 dropped_concepts（spec §6 N1）。
  // 覆盖判定 = query 词覆盖率 ≥ 60%（3+ 字词；整句子串过苛，与 N3 的信息增量容忍度一致）。
  const nlNorm = norm(out.nl)
  const dropped = new Set(out.dropped_concepts.map(norm))
  const queryCovered = (query: string): boolean => {
    if (nlNorm.includes(norm(query))) return true
    const words = norm(query).split(/\s+/).filter((w) => w.length >= 3)
    if (words.length === 0) return true
    const hitWords = words.filter((w) => nlNorm.includes(w)).length
    return hitWords / words.length >= 0.6
  }
  for (const u of pack.unresolved) {
    if (!queryCovered(u.query) && !dropped.has(norm(u.concept))) {
      push('unresolved_dropped', 'critical', `unresolved concept '${u.concept}' (${u.query}) absent from NL and not declared in dropped_concepts`)
    }
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

  // tag_budget：数量 + 字符（spec §6 T7）。
  // 2026-09-16 活跑实证修订（gen_1789521620450）：min 硬门与 T1（tag 只能来自证据）自相矛盾——
  // 证据概念数不足 20 时 writer 无法达标。下限取 min(minTags, 可用证据概念数)：
  // 低于它 = writer 丢弃了可得证据（critical）；高于它但未满 minTags = 数量偏少（important，搭车反馈不跳审）。
  const min = Math.min(opts.minTags ?? MIN_TAGS, pack.evidence.length + pack.artists.length)
  const max = opts.maxTags ?? MAX_TAGS
  const maxChars = opts.maxChars ?? MAX_CHARS
  if (out.tags.length < min || out.tags.length > max) {
    push('tag_budget', 'critical', `tag count ${out.tags.length} outside [${min},${max}]`)
  } else if (out.tags.length < (opts.minTags ?? MIN_TAGS)) {
    push('tag_budget', 'important', `tag count ${out.tags.length} below target ${opts.minTags ?? MIN_TAGS} (evidence-limited: ${pack.evidence.length} concepts resolved)`)
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

  // artist_whitelist：@tag 必须在检索包 artists 清单内
  const artistAllowed = new Set(pack.artists.map((a) => norm(a.prompt_form)))
  for (const t of out.tags) {
    if (t.text.startsWith('@') && !artistAllowed.has(norm(t.text))) {
      push('artist_whitelist', 'critical', `artist tag '${t.text}' not in evidence artists block`)
    }
  }

  return gates
}
