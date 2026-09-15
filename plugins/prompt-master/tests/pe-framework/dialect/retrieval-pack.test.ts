import { describe, expect, it } from 'vitest'
import { buildRetrievalPack, extractConcepts, PACK_CHAR_BUDGET } from '../../../src/pe-framework/dialect/retrieval-pack.js'
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
      q === 'cowboy shot' ? [{ prompt_form: 'cowboy_shot', match_type: 'semantic', score: 0.91, usage_count: 57 }] : []
    const pack = await buildRetrievalPack(BP, search)
    const comp = pack.evidence.find((e) => e.concept === 'composition.framing')
    expect(comp?.hits[0]).toMatchObject({ prompt_form: 'cowboy_shot', score: 0.91 })
  })
  it('hits capped at MAX_HITS per concept', async () => {
    const search = async (q: string) =>
      q.includes('hair') ? Array.from({ length: 7 }, (_, i) => ({ prompt_form: `hit${i}`, match_type: 'fuzzy' })) : []
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
