import { describe, expect, it } from 'vitest'
import { COMPOSITING_RUBRIC, COMPOSITING_RUBRIC_IDS, buildCompositingJudgePrompt } from '../../../../src/pe-framework/eval/rubrics/compositing.js'
import type { WriterOutput } from '../../../../src/pe-framework/compositing/writer.js'
import type { SemanticBlueprint } from '../../../../src/pe-framework/blueprint/semantic-schema.js'
import type { RetrievalPack } from '../../../../src/pe-framework/dialect/retrieval-pack.js'

const OUT: WriterOutput = {
  tags: [{ text: 'long hair', source_concept: 'S1.appearance' }],
  nl: 'She sits on the right third. Lantern light keeps her face exposed.',
  negative: [],
  dropped_concepts: [],
}
const BP: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'lantern light' },
    style_hints: [] },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal', negative_hints: [],
}
const PACK: RetrievalPack = { evidence: [], unresolved: [], artists: [], mutual_exclusion_pairs: [], truncated: [] }

describe('COMPOSITING_RUBRIC (spec §7)', () => {
  it('exactly 6 dimensions with the spec ids, in order', () => {
    expect(COMPOSITING_RUBRIC_IDS).toEqual([
      'blueprint-fidelity', 'nl-quality', 'tag-selection',
      'negative-template', 'composition-coherence', 'aesthetic-vocabulary',
    ])
  })
  it('every criterion is an operationalized predicate (no bare adjectives)', () => {
    for (const r of COMPOSITING_RUBRIC) {
      expect(r.criterion.length).toBeGreaterThan(20)
      // 每条判据必须含可核对结构（编号规则/量词/枚举/否定式禁止），非纯形容词
      expect(/\d|不|无|仅|必须|只|存在|缺失/.test(r.criterion)).toBe(true)
    }
  })
})

describe('buildCompositingJudgePrompt (spec §7)', () => {
  it('user wraps the judged artifact in <response> and carries evidence context', () => {
    const p = buildCompositingJudgePrompt(OUT, BP, PACK)
    expect(p.persona).toContain('六维')
    expect(p.schema).toContain('blueprint-fidelity')
    expect(p.user).toContain('<response>')
    expect(p.user).toContain('long hair')
    expect(p.user).toContain('<blueprint_v1>')
    expect(p.user).toContain('<evidence>')
    expect(p.user).toContain('rating 种子为系统注入，不参与评审')
  })
  it('persona lists all six rubric criteria verbatim', () => {
    const p = buildCompositingJudgePrompt(OUT, BP, PACK)
    for (const r of COMPOSITING_RUBRIC) expect(p.persona).toContain(r.id)
  })
})
