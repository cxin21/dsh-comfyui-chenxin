import { describe, expect, it } from 'vitest'
import { parseWriterOutput, buildWriterPrompt, WRITER_PERSONA } from '../../../src/pe-framework/compositing/writer.js'
import { assemblePositive, assembleNegative, deterministicCompose } from '../../../src/pe-framework/compositing/compose.js'
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js'
import type { RetrievalPack } from '../../../src/pe-framework/dialect/retrieval-pack.js'

const BP: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'warm sunset glow from the west' },
    style_hints: [] },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'cowboy shot', camera_angle: 'from below', placement: 'right third' },
  mood: 'nocturnal', negative_hints: ['no modern elements'],
}
const PACK: RetrievalPack = {
  evidence: [{ concept: 'S1.appearance', query: 'long black hair', hits: [{ prompt_form: 'long hair', match_type: 'canonical', usage_count: 891234 }] }],
  unresolved: [{ concept: 'composition.placement', query: 'right third' }],
  artists: [],
  mutual_exclusion_pairs: [['solo', '1boy']],
  truncated: [],
}
const OUT = {
  tags: [{ text: 'long hair', source_concept: 'S1.appearance' }],
  nl: 'The subject sits on the right third of the frame. Warm sunset glow from the west keeps her face exposed with no silhouette.',
  negative: ['no modern elements'],
  dropped_concepts: [],
}

describe('parseWriterOutput (spec §6)', () => {
  it('valid output parses', () => {
    const r = parseWriterOutput(JSON.stringify(OUT))
    expect(r.tags).toHaveLength(1)
    expect(r.tags[0]).toEqual({ text: 'long hair', source_concept: 'S1.appearance' })
  })
  it('fenced output tolerated', () => {
    expect(parseWriterOutput('```json\n' + JSON.stringify(OUT) + '\n```').nl).toContain('right third')
  })
  it('tag without source_concept → contract error citing T2', () => {
    const bad = { ...OUT, tags: [{ text: 'long hair' }] }
    expect(() => parseWriterOutput(JSON.stringify(bad))).toThrow(/source_concept/)
  })
  it('negative with quality word → contract error', () => {
    const bad = { ...OUT, negative: ['worst quality'] }
    expect(() => parseWriterOutput(JSON.stringify(bad))).toThrow(/质量词/)
  })
  it('non-JSON → parse error', () => {
    expect(() => parseWriterOutput('no braces here')).toThrow(/非 JSON/)
  })
})

describe('buildWriterPrompt (spec §2.1/§8)', () => {
  it('sectioned template with blueprint/evidence; frozen block when hash present', () => {
    const p = buildWriterPrompt(BP, PACK, { frozenHash: 'abc123' })
    expect(p).toContain('<task_persona>')
    expect(p).toContain('<blueprint_v1>')
    expect(p).toContain('<evidence>')
    expect(p).toContain('<output_contract>')
    expect(p).toContain('blueprint_v1_hash="abc123"')
    expect(p).toContain(WRITER_PERSONA.slice(0, 20))
  })
  it('feedback lands in rules block', () => {
    const p = buildWriterPrompt(BP, PACK, { feedback: 'use canonical long hair' })
    expect(p).toContain('<rules>')
    expect(p).toContain('use canonical long hair')
  })
})

describe('assemblePositive / assembleNegative (spec §6/§7)', () => {
  it('positive = rating seed + tags + nl', () => {
    const p = assemblePositive(OUT, 'explicit')
    expect(p).toBe('rating_explicit, long hair, The subject sits on the right third of the frame. Warm sunset glow from the west keeps her face exposed with no silhouette.')
  })
  it('negative = template + content negatives, deduped', () => {
    const n = assembleNegative({ ...OUT, negative: ['no modern elements', 'blurry'] })
    expect(n).toContain('worst quality')
    expect(n).toContain('loli')
    expect(n).toContain('no modern elements')
    expect(n.match(/blurry/g)?.length).toBe(1)
  })
})

describe('deterministicCompose (spec §7 D7)', () => {
  it('evidence top hits → tags; unresolved + composition + lighting + mood → NL', () => {
    const r = deterministicCompose(BP, PACK)
    expect(r.tags).toEqual([{ text: 'long hair', source_concept: 'S1.appearance' }])
    const sents = r.nl.split(/(?<=\.)\s+/)
    expect(sents.length).toBeGreaterThanOrEqual(2)
    expect(sents.length).toBeLessThanOrEqual(4)
    expect(r.nl).toContain('right third')
    expect(r.nl).toContain('warm sunset glow from the west')
    expect(r.nl).toContain('no silhouette')
    expect(r.negative).toEqual(['no modern elements'])
  })
  it('empty evidence + empty unresolved still composes (never fails)', () => {
    const empty: RetrievalPack = { evidence: [], unresolved: [], artists: [], mutual_exclusion_pairs: [], truncated: [] }
    const r = deterministicCompose(BP, empty)
    expect(r.tags).toEqual([])
    expect(r.nl.length).toBeGreaterThan(0)
  })
})
