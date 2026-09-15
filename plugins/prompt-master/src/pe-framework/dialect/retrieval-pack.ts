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
  for (const [i, s] of bp.subjects.entries()) {
    for (const [k, v] of Object.entries(s) as Array<[string, string]>) {
      if (k === 'id' || k === 'count') continue
      if (k === 'appearance' || k === 'pose') {
        for (const phrase of splitPhrases(v)) out.push({ concept: `subjects[${i}].${k}`, query: phrase })
      } else if (v.trim()) {
        out.push({ concept: `subjects[${i}].${k}`, query: v })
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

export async function buildRetrievalPack(
  bp: SemanticBlueprint,
  search: CatalogSearchFn,
): Promise<RetrievalPack> {
  const evidence: ConceptEvidence[] = []
  const unresolved: Array<{ concept: string; query: string }> = []
  for (const { concept, query } of extractConcepts(bp)) {
    let hits: EvidenceHit[] = []
    try {
      hits = normalizeHits(await search(query), query)
    } catch {
      hits = []
    }
    if (hits.length === 0) unresolved.push({ concept, query })
    else evidence.push({ concept, query, hits })
  }

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
  }

  // 字符预算（确定性收缩）：从命中数最多的 evidence 逐条丢尾
  while (JSON.stringify(pack).length > PACK_CHAR_BUDGET) {
    const biggest = [...pack.evidence].sort((a, b) => b.hits.length - a.hits.length)[0]
    if (!biggest || biggest.hits.length <= 1) break
    biggest.hits.pop()
    if (!pack.truncated.includes(biggest.concept)) pack.truncated.push(biggest.concept)
  }
  return pack
}
