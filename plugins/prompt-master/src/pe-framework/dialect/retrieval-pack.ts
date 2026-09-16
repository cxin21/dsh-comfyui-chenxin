/**
 * S2.5 概念检索包（spec §5，2026-09-15 管线重设计）：
 * 全管线唯一与 tag 字典交互的确定性层——从语义蓝图 V1 抽取概念清单，
 * 逐概念走 catalog 级联（canonical/alias → 向量语义 → fuzzy，由注入的 search 承载），
 * 组装【词表证据】检索包供 S3 成文消费。零 LLM。
 *
 * 降级语义：search 故障/空结果 → 该概念进 unresolved（NL 尾原料），不阻塞。
 * 预算：每概念 hits ≤ MAX_HITS(5)；检索包序列化 > PACK_CHAR_BUDGET(4096) 时
 * 从命中数最多的 evidence 逐条丢弃并记 truncated（确定性）。
 */
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js'
import { MUTUAL_EXCLUSIONS } from './anima.js'

export const MAX_HITS = 5
export const PACK_CHAR_BUDGET = 4096

export interface EvidenceHit {
  prompt_form: string
  match_type: string
  usage_count?: number
  score?: number
}

export interface ConceptEvidence {
  concept: string
  query: string
  hits: EvidenceHit[]
}

export interface RetrievalPack {
  evidence: ConceptEvidence[]
  unresolved: Array<{ concept: string; query: string }>
  artists: EvidenceHit[]
  mutual_exclusion_pairs: Array<[string, string]>
  truncated: string[]
  /** 质量门拒量等检索层 advisory（编排层并入 envelope，不进 writer prompt） */
  advisories?: string[]
}

export interface CatalogHitLike {
  prompt_form?: string
  raw?: string
  match_type?: string
  usage_count?: number
  score?: number
}

export type CatalogSearchFn = (query: string) => Promise<CatalogHitLike[]>

/** 概念清单抽取（确定性，无裁量）：句/短语级切分，粒度对齐 catalog 检索习惯 */
export function extractConcepts(bp: SemanticBlueprint): Array<{ concept: string; query: string }> {
  const out: Array<{ concept: string; query: string }> = []
  const splitPhrases = (text: string): string[] =>
    text.split(/[,;，；]/).map((s) => s.trim()).filter((s) => s.length > 0)

  out.push({ concept: 'core.concept', query: bp.core.concept })
  for (const [k, v] of Object.entries(bp.core.scene)) {
    if (v.trim()) out.push({ concept: `core.scene.${k}`, query: v })
  }
  for (const s of bp.subjects) {
    for (const [k, v] of Object.entries(s) as Array<[string, string]>) {
      if (k === 'id' || k === 'count') continue
      // 概念路径按主体 id（spec §5："S1.appearance"），与 writer source_concept（T2）对齐
      if (k === 'appearance' || k === 'pose') {
        for (const phrase of splitPhrases(v)) out.push({ concept: `${s.id}.${k}`, query: phrase })
      } else if (v.trim()) {
        out.push({ concept: `${s.id}.${k}`, query: v })
      }
    }
  }
  for (const [k, v] of Object.entries(bp.composition)) {
    if (v.trim()) out.push({ concept: `composition.${k}`, query: v })
  }
  if (bp.mood.trim()) out.push({ concept: 'mood', query: bp.mood })
  for (const [i, h] of bp.core.style_hints.entries()) {
    if (h.trim()) out.push({ concept: `core.style_hints[${i}]`, query: h })
  }
  return out
}

function normalizeHits(raw: CatalogHitLike[], query: string): EvidenceHit[] {
  return raw.slice(0, MAX_HITS).map((h) => ({
    prompt_form: h.prompt_form ?? h.raw ?? query,
    match_type: h.match_type ?? 'unknown',
    ...(typeof h.usage_count === 'number' ? { usage_count: h.usage_count } : {}),
    ...(typeof h.score === 'number' ? { score: h.score } : {}),
  }))
}

/* ── 向量命中质量门（spec §5 修订 2026-09-16；活跑噪声实证：gen_1789525639240 证据块混入
 *  'nishino - the boy at the bottom…' / 'general:handlebar deepthroat' / 'standing upskirt' 等
 *  字面碰瓷的向量命中）──
 * 规则（全部可判定谓词）：
 * Q0 形式白名单：证据 = 已验证形式——仅 canonical / alias / semantic 入证据主表；
 *    fuzzy / unknown 一律拒（fuzzy = 词面相近但未经验证，'fingering from behind' 类
 *    真 tag 碰瓷通道就此堵死；其概念走 unresolved 出口由 NL 承载）
 * Q1 原子性：prompt_form 词数 > MAX_FORM_WORDS(6) → 拒（全部 match_type；canonical 也不例外）
 * Q2 标点：含 ':' / '：' / ' - ' 连接结构 → 拒（全部 match_type；danbooru 规范 tag 无冒号）
 * Q3 语义分：semantic 命中 score < MIN_SEMANTIC_SCORE(0.85) → 拒（T1R §12.3 阈值，
 *    env PM_VECTOR_MIN_SCORE 可标定覆盖）
 * Q4 频次：非 canonical 命中 usage_count < MIN_USAGE_COUNT(100) → 拒
 *    （env PM_VECTOR_MIN_USAGE 可标定覆盖）；canonical/alias 免 Q3/Q4（人工策展形式），Q1/Q2 照查。 */

export const MIN_SEMANTIC_SCORE = 0.85
export const MIN_USAGE_COUNT = 100
export const MAX_FORM_WORDS = 6

export interface RetrievalGateOpts {
  minSemanticScore?: number
  minUsageCount?: number
  maxFormWords?: number
}

const QUALITY_RANK: Record<string, number> = { canonical: 0, alias: 1, fuzzy: 2, semantic: 3, unknown: 4 }

function envNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** 单命中质量裁决（导出供测试）；返回 'accept' 或拒因。
 *  阈值优先级：opts 显式 > env（PM_VECTOR_MIN_SCORE/PM_VECTOR_MIN_USAGE，§12.3 标定面）> 常量。 */
export function judgeHitQuality(h: EvidenceHit, opts: RetrievalGateOpts = {}): 'accept' | string {
  const maxWords = opts.maxFormWords ?? MAX_FORM_WORDS
  const minScore = opts.minSemanticScore ?? envNumber('PM_VECTOR_MIN_SCORE') ?? MIN_SEMANTIC_SCORE
  const minUsage = opts.minUsageCount ?? envNumber('PM_VECTOR_MIN_USAGE') ?? MIN_USAGE_COUNT
  const form = h.prompt_form
  const words = form.trim().split(/\s+/).length
  if (words > maxWords) return `Q1 原子性：${words} 词超上限 ${maxWords}`
  if (/[:：]| - /.test(form)) return 'Q2 标点：含冒号或连接结构'
  const mt = h.match_type
  if (mt !== 'canonical' && mt !== 'alias' && mt !== 'semantic') {
    return `Q0 未验证形式（${mt}）不进证据`
  }
  if (mt === 'semantic') {
    if (h.score !== undefined && h.score < minScore) return `Q3 语义分 ${h.score?.toFixed(2)} < ${minScore}`
    if ((h.usage_count ?? 0) < minUsage) return `Q4 频次 ${h.usage_count ?? 0} < ${minUsage}`
  } else if (mt !== 'canonical') {
    if ((h.usage_count ?? 0) < minUsage) return `Q4 频次 ${h.usage_count ?? 0} < ${minUsage}`
  }
  return 'accept'
}

function gateHits(hits: EvidenceHit[], opts: RetrievalGateOpts): EvidenceHit[] {
  return hits.filter((h) => judgeHitQuality(h, opts) === 'accept')
}

/** 预算收缩顺序（§13 落点）：先裁低质（semantic/fuzzy），同质按 usage/score 升序 */
function hitQualityRank(h: EvidenceHit): number {
  const typeRank = QUALITY_RANK[h.match_type] ?? 4
  const freq = (h.usage_count ?? 0) / 1_000_000
  return typeRank - Math.min(freq, 1)
}

export async function buildRetrievalPack(
  bp: SemanticBlueprint,
  search: CatalogSearchFn,
  gate: RetrievalGateOpts = {},
): Promise<RetrievalPack> {
  const evidence: ConceptEvidence[] = []
  const unresolved: Array<{ concept: string; query: string }> = []
  let rejectedCount = 0
  let evidenceAdvisory: string | undefined
  // 2026-09-16 活跑实证（retrieval_pack 56.7s）：概念间独立，并行查询——bge-base-en-v1.5 ONNX 单次嵌入 ~4s，
  // 串行 14+ 概念是管线延迟大头。降级语义不变：单查询故障 → 该概念进 unresolved。
  // 相同 query 去重：只查一次，多概念共享命中（extractConcepts 可能产出重复短语）。
  const queryCache = new Map<string, EvidenceHit[]>()
  const results = await Promise.all(
    extractConcepts(bp).map(async ({ concept, query }) => {
      let hits = queryCache.get(query)
      if (hits === undefined) {
        try {
          hits = normalizeHits(await search(query), query)
        } catch {
          hits = []
        }
        queryCache.set(query, hits)
      }
      return { concept, query, hits }
    }),
  )
  for (const r of results) {
    // 质量门（Q1-Q4）：拒因计数进 advisory（可观测），全拒 → unresolved 出口
    const gated = gateHits(r.hits, gate)
    rejectedCount += r.hits.length - gated.length
    if (gated.length === 0) unresolved.push({ concept: r.concept, query: r.query })
    else evidence.push({ concept: r.concept, query: r.query, hits: gated })
  }
  if (rejectedCount > 0) evidenceAdvisory = `vector_hits_rejected:${rejectedCount}`
  // 画师块：style_hints 命中中 prompt_form 以 @ 开头者
  const styleHintQueries = new Set(bp.core.style_hints.map((h) => h.trim()).filter(Boolean))
  const artists = evidence
    .filter((e) => styleHintQueries.has(e.query))
    .flatMap((e) => e.hits)
    .filter((h) => h.prompt_form.startsWith('@'))
    .slice(0, MAX_HITS)

  let pack: RetrievalPack = {
    evidence,
    unresolved,
    artists,
    mutual_exclusion_pairs: MUTUAL_EXCLUSIONS.map(([a, b]) => [a, b] as [string, string]),
    truncated: [],
    ...(evidenceAdvisory !== undefined ? { advisories: [evidenceAdvisory] } : {}),
  }

  // 字符预算（确定性收缩）：从命中数最多的 evidence 逐条丢**质量最低**的命中
  // （hitQualityRank：semantic/fuzzy 先于 canonical 裁，同质按 usage/score 升序——§13 落点④）
  while (JSON.stringify(pack).length > PACK_CHAR_BUDGET) {
    const biggest = [...pack.evidence].sort((a, b) => b.hits.length - a.hits.length)[0]
    if (!biggest || biggest.hits.length <= 1) break
    biggest.hits.sort((a, b) => hitQualityRank(a) - hitQualityRank(b))
    biggest.hits.pop()
    if (!pack.truncated.includes(biggest.concept)) pack.truncated.push(biggest.concept)
  }
  return pack
}
