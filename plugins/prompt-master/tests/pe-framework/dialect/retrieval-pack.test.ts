import { describe, expect, it, vi } from 'vitest'
import { buildRetrievalPack, extractConcepts, PACK_CHAR_BUDGET, type RetrievalPack } from '../../../src/pe-framework/dialect/retrieval-pack.js'
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js'

const BP: SemanticBlueprint = {
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'warm sunset glow from the west' },
    style_hints: ['retro anime cel shading'],
  },
  subjects: [
    { id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair, school uniform', pose: 'standing, looking back', expression: 'soft smile' },
  ],
  composition: { framing: 'cowboy shot', camera_angle: 'from below', placement: 'right third' },
  mood: 'nocturnal, confident',
  negative_hints: [],
}

describe('extractConcepts (spec §5)', () => {
  it('sentence/phrase level split for appearance/pose', () => {
    const cs = extractConcepts(BP)
    const appearance = cs.filter((c) => c.concept === 'S1.appearance')
    expect(appearance.map((c) => c.query)).toEqual(['long black hair', 'school uniform'])
    const pose = cs.filter((c) => c.concept === 'S1.pose')
    expect(pose.map((c) => c.query)).toEqual(['standing', 'looking back'])
  })
  it('scene fields / composition / mood / style_hints each one query', () => {
    const cs = extractConcepts(BP)
    expect(cs.some((c) => c.concept === 'core.scene.lighting_idea' && c.query.includes('sunset'))).toBe(true)
    expect(cs.some((c) => c.concept === 'composition.placement' && c.query === 'right third')).toBe(true)
    expect(cs.some((c) => c.concept === 'mood')).toBe(true)
    expect(cs.some((c) => c.concept === 'core.style_hints[0]' && c.query === 'retro anime cel shading')).toBe(true)
  })
})

describe('buildRetrievalPack (spec §5)', () => {
  it('canonical hit lands in evidence; total miss lands in unresolved', async () => {
    const search = async (q: string) =>
      q.includes('hair') ? [{ prompt_form: 'long hair', match_type: 'canonical', usage_count: 891234 }] : []
    const pack = await buildRetrievalPack(BP, search)
    const hair = pack.evidence.find((e) => e.concept === 'S1.appearance')
    expect(hair?.hits[0]).toMatchObject({ prompt_form: 'long hair', match_type: 'canonical' })
    expect(pack.unresolved.some((u) => u.query === 'right third')).toBe(true)
    expect(pack.unresolved.every((u) => typeof u.concept === 'string')).toBe(true)
  })
  it('semantic hit passes through with score', async () => {
    const search = async (q: string) =>
      q === 'cowboy shot' ? [{ prompt_form: 'cowboy_shot', match_type: 'semantic', score: 0.91, usage_count: 5700 }] : []
    const pack = await buildRetrievalPack(BP, search)
    const comp = pack.evidence.find((e) => e.concept === 'composition.framing')
    expect(comp?.hits[0]).toMatchObject({ prompt_form: 'cowboy_shot', score: 0.91 })
  })
  it('hits capped at MAX_HITS per concept', async () => {
    const search = async (q: string) =>
      q.includes('hair') ? Array.from({ length: 7 }, (_, i) => ({ prompt_form: `hit${i}`, match_type: 'canonical', usage_count: 500 })) : []
    const pack = await buildRetrievalPack(BP, search)
    expect(pack.evidence.find((e) => e.concept === 'S1.appearance')?.hits.length).toBe(5)
  })
  it('search failure degrades to unresolved (non-blocking)', async () => {
    const search = async () => {
      throw new Error('catalog down')
    }
    const pack = await buildRetrievalPack(BP, search)
    expect(pack.evidence).toHaveLength(0)
    expect(pack.unresolved.length).toBeGreaterThan(0)
  })
  it('char budget: pack serialized size ≤ PACK_CHAR_BUDGET or single-hit floor', async () => {
    const search = async (q: string) =>
      q.includes('hair')
        ? Array.from({ length: 5 }, (_, i) => ({ prompt_form: `x`.repeat(400) + i, match_type: 'canonical', usage_count: 1000 - i }))
        : []
    const pack = await buildRetrievalPack(BP, search)
    expect(JSON.stringify(pack).length <= PACK_CHAR_BUDGET || pack.evidence.every((e) => e.hits.length <= 1)).toBe(true)
  })
  it('artist block: @-prefixed hits from style_hints queries', async () => {
    const search = async (q: string) =>
      q === 'retro anime cel shading' ? [{ prompt_form: '@as109', match_type: 'canonical', usage_count: 999 }, { prompt_form: 'cel shading', match_type: 'canonical', usage_count: 50 }] : []
    const pack = await buildRetrievalPack(BP, search)
    expect(pack.artists.map((a) => a.prompt_form)).toEqual(['@as109'])
  })
})

describe('向量命中质量门（spec §5 修订 2026-09-16；冒烟噪声形态回归锁 gen_1789525639240）', () => {
  const NOISE = [
    // 冒烟实证的真实噪声形态（bge-base 字面碰瓷命中；standing upskirt 0.83/9000 在 0.62 阈值下
    // 属于门拦不住的"真 tag 语义无关"形态——归 judge tag-selection 查，见 §12.3 标定遗留）
    { prompt_form: 'nishino - the boy at the bottom of the school caste and also at the top of the underground', match_type: 'semantic', score: 0.88, usage_count: 12 },
    { prompt_form: 'general:handlebar deepthroat', match_type: 'semantic', score: 0.86, usage_count: 300 },
    { prompt_form: 'pathfinder: wrath of the righteous', match_type: 'semantic', score: 0.87, usage_count: 40 },
  ]
  it('Q1 原子性：多词长句拒绝', async () => {
    const pack = await gatedPack(NOISE.slice(0, 1))
    expect(pack.evidence).toHaveLength(0)
    expect(pack.unresolved.length).toBeGreaterThan(0)
  })
  it('Q2 标点：含冒号/连接结构拒绝（canonical 也不例外）', async () => {
    const pack = await gatedPack([
      { prompt_form: 'general:handlebar deepthroat', match_type: 'canonical', usage_count: 999999 },
    ])
    expect(pack.evidence).toHaveLength(0)
  })
  it('Q3 语义分：score < 0.62 拒绝；≥ 0.62 且频次达标通过（§12.3 阈值修订）', async () => {
    const pack = await gatedPack([
      { prompt_form: 'standing upskirt', match_type: 'semantic', score: 0.55, usage_count: 9000 },
      { prompt_form: 'paper lantern', match_type: 'semantic', score: 0.91, usage_count: 5000 },
    ])
    // 同一概念：合格命中留下、低分命中被拒
    expect(pack.evidence[0].hits.map((h) => h.prompt_form)).toEqual(['paper lantern'])
  })
  it('Q0+Q4：fuzzy 未验证形式一律拒；canonical 免频次门', async () => {
    const pack = await gatedPack([
      { prompt_form: 'rare obi', match_type: 'fuzzy', usage_count: 42 },
      { prompt_form: 'kimono', match_type: 'canonical', usage_count: 1 },
    ])
    expect(pack.evidence[0].hits.map((h) => h.prompt_form)).toEqual(['kimono'])
  })
  it('拒绝量可观测：advisories 携带 vector_hits_rejected:N', async () => {
    const pack = await gatedPack(NOISE)
    expect(pack.advisories?.[0]).toMatch(/^vector_hits_rejected:\d+$/)
  })
  it('预算收缩先裁低质：semantic/fuzzy 先于 canonical 被丢弃', async () => {
    // 构造超预算：每概念 5 hits（1 canonical + 4 长 semantic），echo search 让全部概念命中
    // → 13 概念 × ~800 字符/概念 ≫ 4096 → 收缩必然触发；qualityRank 低的 semantic 先被裁
    const hits = [
      { prompt_form: 'canon', match_type: 'canonical', usage_count: 10 },
      ...Array.from({ length: 4 }, (_, i) => ({ prompt_form: `semantic ${i} ${'x'.repeat(240)}`, match_type: 'semantic', score: 0.99, usage_count: 1000 })),
    ]
    const search = async () => hits
    const pack = await buildRetrievalPack(BP, search)
    expect(pack.truncated.length).toBeGreaterThan(0)
    // canonical（qualityRank 最低）在每个概念的证据里存活
    expect(pack.evidence.length).toBeGreaterThan(0)
    expect(pack.evidence.every((e) => e.hits.some((h) => h.prompt_form === 'canon'))).toBe(true)
  })
})

/** 最小单概念蓝图：仅 S1.appearance 一个查询（'long black hair'），其余字段空串跳过 */
const GATED_BP: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'x',
    scene: { environment: '', time_of_day: '', weather: '', lighting_idea: '' },
    style_hints: [] },
  subjects: [{ id: 'S1', count: 1, identity: '', appearance: 'long black hair', pose: '', expression: '' }],
  composition: { framing: '', camera_angle: '', placement: '' },
  mood: '', negative_hints: [],
}

/** 门测试便捷装配：search 仅对 'long black hair' 返回给定 hits（复用真实 buildRetrievalPack 门逻辑） */
async function gatedPack(hits: Array<{ prompt_form: string; match_type: string; score?: number; usage_count?: number }>): Promise<RetrievalPack> {
  const search = async (q: string) => (q === 'long black hair' ? hits : [])
  return buildRetrievalPack(GATED_BP, search)
}

describe('prewarm seam（audit P4b：检索前批量预热，Phase 2 收口）', () => {
  it('prewarm 以去重后的 query 清单调一次，先于任何 search', async () => {
    const callOrder: string[] = []
    const prewarm = vi.fn(async (qs: string[]) => { callOrder.push(`prewarm:${qs.join('|')}`) })
    const search = vi.fn(async (q: string) => { callOrder.push(`search:${q}`); return [] })
    await buildRetrievalPack(BP, search, {}, prewarm)
    expect(prewarm).toHaveBeenCalledTimes(1)
    const pwArg = prewarm.mock.calls[0][0] as string[]
    expect(new Set(pwArg).size).toBe(pwArg.length) // 去重
    expect(callOrder[0].startsWith('prewarm:')).toBe(true) // 预热先于检索
  })

  it('有/无 prewarm 的 pack 产出字节级一致（纯性能缝，零语义变化）', async () => {
    const search = async (q: string) =>
      q.includes('hair') ? [{ prompt_form: 'long hair', match_type: 'canonical', usage_count: 891234 }] : []
    const without = await buildRetrievalPack(BP, search)
    const withPw = await buildRetrievalPack(BP, search, {}, async () => {})
    expect(JSON.stringify(withPw)).toBe(JSON.stringify(without))
  })

  it('prewarm 故障降级：pack 照常构建（预热是 best-effort）', async () => {
    const search = async (q: string) =>
      q.includes('hair') ? [{ prompt_form: 'long hair', match_type: 'canonical', usage_count: 891234 }] : []
    const pack = await buildRetrievalPack(BP, search, {}, async () => { throw new Error('prewarm boom') })
    expect(pack.evidence.find((e) => e.concept === 'S1.appearance')?.hits[0]).toMatchObject({ prompt_form: 'long hair' })
  })
})
