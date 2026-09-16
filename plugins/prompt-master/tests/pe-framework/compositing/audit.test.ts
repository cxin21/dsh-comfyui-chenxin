import { describe, expect, it } from 'vitest'
import { auditCompositing, type AuditOptions } from '../../../src/pe-framework/compositing/audit.js'
import type { WriterOutput } from '../../../src/pe-framework/compositing/writer.js'
import type { RetrievalPack } from '../../../src/pe-framework/dialect/retrieval-pack.js'
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js'

const BP: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'paper lanterns along the corridor keep her face exposed' },
    style_hints: [] },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal', negative_hints: [],
}
const PACK: RetrievalPack = {
  evidence: [
    { concept: 'S1.appearance', query: 'long black hair', hits: [{ prompt_form: 'long hair', match_type: 'canonical', usage_count: 891234 }, { prompt_form: 'black hair', match_type: 'canonical', usage_count: 700000 }] },
    { concept: 'S1.pose', query: 'standing', hits: [{ prompt_form: 'standing', match_type: 'canonical', usage_count: 500000 }] },
    { concept: 'composition.framing', query: 'full body', hits: [{ prompt_form: 'full body', match_type: 'canonical', usage_count: 300000 }] },
    { concept: 'core.scene.lighting_idea', query: 'paper lanterns', hits: [{ prompt_form: 'paper lanterns', match_type: 'semantic', score: 0.9 }] },
    { concept: 'fillers', query: 'fillers', hits: Array.from({ length: 18 }, (_, i) => ({ prompt_form: `filler${String(i).padStart(2, '0')}`, match_type: 'canonical', usage_count: 100 })) },
  ],
  unresolved: [{ concept: 'mood', query: 'nocturnal confident atmosphere' }],
  artists: [{ prompt_form: '@as109', match_type: 'canonical' }],
  mutual_exclusion_pairs: [['solo', '1boy']],
  truncated: [],
}
/** 合法满额产物：22 tags（全部可回查）+ 3 句 NL（无复述） */
const OUT: WriterOutput = {
  tags: [
    { text: 'long hair', source_concept: 'S1.appearance' },
    { text: 'black hair', source_concept: 'S1.appearance' },
    { text: 'standing', source_concept: 'S1.pose' },
    { text: 'paper lanterns', source_concept: 'core.scene.lighting_idea' },
    ...Array.from({ length: 18 }, (_, i) => ({ text: `filler${String(i).padStart(2, '0')}`, source_concept: 'fillers' })),
  ],
  nl: 'The girl sits on the right third of the frame. Lantern light along the corridor keeps her face exposed with no silhouette. The mood is nocturnal and confident.',
  negative: [],
  dropped_concepts: [],
}
const OPTS: AuditOptions = { rating: 'safe' }

describe('auditCompositing (spec §7)', () => {
  it('clean fixture (tags≥20, no overlap) → zero critical gates', () => {
    const gates = auditCompositing(OUT, PACK, BP, OPTS)
    expect(gates.filter((g) => g.severity === 'critical')).toEqual([])
  })
  it('fabricated_tag: tag outside evidence → critical', () => {
    const bad = { ...OUT, tags: [...OUT.tags, { text: 'neon glow', source_concept: 'S1.pose' }] }
    const gates = auditCompositing(bad, PACK, BP, OPTS)
    expect(gates.some((g) => g.rule === 'fabricated_tag' && g.detail.includes('neon glow'))).toBe(true)
  })
  it('nl_tag_overlap lexical: NL contains tag text → critical', () => {
    const bad = { ...OUT, nl: 'She has long hair and stands tall. Lanterns glow softly.' }
    const gates = auditCompositing(bad, PACK, BP, OPTS)
    expect(gates.some((g) => g.rule === 'nl_tag_overlap' && g.detail.includes('long hair'))).toBe(true)
  })
  it('nl_tag_overlap vector: sim ≥ 0.85 → critical; undefined → advisory only', () => {
    const bad = { ...OUT, nl: 'Her hair flows in the wind. Lanterns glow.' }
    const gates = auditCompositing(bad, PACK, BP, { ...OPTS, vectorSim: (s, t) => (t === 'long hair' && s.includes('hair flows') ? 0.92 : 0.1) })
    expect(gates.some((g) => g.rule === 'nl_tag_overlap' && g.detail.includes('semantically'))).toBe(true)
    const gatesNoVec = auditCompositing(bad, PACK, BP, OPTS)
    expect(gatesNoVec.some((g) => g.rule === 'overlap_vector_unavailable')).toBe(true)
  })
  it('unresolved_dropped: unresolved absent from NL/dropped → critical', () => {
    const bad = { ...OUT, nl: 'The girl sits alone. Lanterns glow.' }
    const gates = auditCompositing(bad, PACK, BP, OPTS)
    expect(gates.some((g) => g.rule === 'unresolved_dropped')).toBe(true)
  })
  it('tag_in_blueprint: snake_case in bp field → critical', () => {
    const bad = { ...BP, subjects: [{ ...BP.subjects[0], appearance: 'long_hair' }] }
    const gates = auditCompositing(OUT, PACK, bad, OPTS)
    expect(gates.some((g) => g.rule === 'tag_in_blueprint')).toBe(true)
  })
  it('tag_budget: below evidence-floor → critical; evidence-limited shortfall → important; over chars → critical', () => {
    // PACK 可用证据概念 = 5 evidence（含 fillers 块）+ 1 artist = 6 → 下限 6；2 tags 低于下限 → critical
    const few = { ...OUT, tags: OUT.tags.slice(0, 2) }
    expect(auditCompositing(few, PACK, BP, OPTS).some((g) => g.rule === 'tag_budget' && g.severity === 'critical')).toBe(true)
    // 6 tags 达到证据下限但未满目标 20 → important（搭车反馈，不跳审）
    const six = { ...OUT, tags: OUT.tags.slice(0, 6) }
    expect(auditCompositing(six, PACK, BP, OPTS).some((g) => g.rule === 'tag_budget' && g.severity === 'important')).toBe(true)
    const long = { ...OUT, nl: 'x'.repeat(1300) }
    expect(auditCompositing(long, PACK, BP, OPTS).some((g) => g.rule === 'tag_budget' && g.detail.includes('chars'))).toBe(true)
  })
  it('mutual_exclusion + framing_consistency → important (ride feedback, not judge-skip)', () => {
    const bad = { ...OUT, tags: [...OUT.tags, { text: 'solo', source_concept: 'S2' }, { text: '1boy', source_concept: 'S2' }, { text: 'shoes', source_concept: 'S1' }] }
    const bpClose = { ...BP, composition: { ...BP.composition, framing: 'close-up' } }
    const gates = auditCompositing(bad, PACK, bpClose, OPTS)
    expect(gates.some((g) => g.rule === 'mutual_exclusion' && g.severity === 'important')).toBe(true)
    expect(gates.some((g) => g.rule === 'framing_consistency' && g.severity === 'important')).toBe(true)
  })
  it('lighting_term_banned + cjk + rating_seed → critical', () => {
    const bad = { ...OUT, nl: 'Sunlight bathes the scene. 她坐着。' }
    const gates = auditCompositing(bad, PACK, BP, { ...OPTS, rating: 'explicit' })
    expect(gates.some((g) => g.rule === 'lighting_term_banned')).toBe(true)
    expect(gates.some((g) => g.rule === 'cjk_in_positive')).toBe(true)
  })
  it('artist_whitelist: @tag outside evidence artists block → critical', () => {
    const bad = { ...OUT, tags: [...OUT.tags, { text: '@fakeartist', source_concept: 'core.style_hints[0]' }] }
    const gates = auditCompositing(bad, PACK, BP, OPTS)
    expect(gates.some((g) => g.rule === 'artist_whitelist' && g.detail.includes('@fakeartist'))).toBe(true)
  })
})
