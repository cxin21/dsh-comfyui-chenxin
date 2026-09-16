import { describe, expect, it } from 'vitest'
import { orchestrateCompositing } from '../../../src/pe-framework/compositing/orchestrate.js'
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js'

// fixtures 与 orchestrate.test.ts 同款（audit P3：envelope 顶层质量三态的判定源测试）
const V0: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'paper lanterns along the corridor' },
    style_hints: ['cel shading'] },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal', negative_hints: [],
}

const ENRICH_PATCH = JSON.stringify({ set: { mood: 'nocturnal, quietly tense' }, additions: { core: { style_hints: ['cel shading'] } } })

const SEARCH = async (q: string) => [{ prompt_form: q, match_type: 'canonical', usage_count: 1000 }]

const VALID_OUT = JSON.stringify({
  tags: [
    { text: 'long black hair', source_concept: 'S1.appearance' },
    { text: 'standing', source_concept: 'S1.pose' },
    { text: 'full body', source_concept: 'composition.framing' },
    { text: 'paper lanterns along the corridor', source_concept: 'core.scene.lighting_idea' },
    { text: 'cel shading', source_concept: 'core.style_hints[0]' },
  ],
  nl: 'She sits on the right third of the frame. Lantern light keeps her face exposed with no silhouette.',
  negative: [],
  dropped_concepts: ['core.concept', 'core.scene.environment', 'core.scene.time_of_day', 'core.scene.weather', 'S1.identity', 'S1.expression', 'composition.camera_angle', 'composition.placement', 'mood'],
})

const PASS_JUDGE = JSON.stringify({
  verdict: 'pass',
  dimensionScores: { 'blueprint-fidelity': 90, 'nl-quality': 90, 'tag-selection': 90, 'negative-template': 90, 'composition-coherence': 90, 'aesthetic-vocabulary': 90 },
  findings: [],
  praise: [],
})

describe('compositing quality 三态（audit P3）', () => {
  it('clean pass → quality=passed', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      critic: async () => PASS_JUDGE,
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.corrections).toBe(0)
    expect(outcome.quality).toBe('passed')
  })

  it('repair round then writer kept → quality=degraded', async () => {
    let writerCalls = 0
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => {
        writerCalls++
        return writerCalls === 1
          ? JSON.stringify({ tags: [{ text: 'neon glow', source_concept: 'S1.pose' }], nl: 'She stands alone.', negative: [], dropped_concepts: [] })
          : VALID_OUT
      },
      critic: async () => PASS_JUDGE,
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.corrections).toBe(1)
    expect(outcome.fallbackUsed).toBe(false)
    expect(outcome.quality).toBe('degraded')
  })

  it('writer failure → fallback → quality=fallback', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', { search: SEARCH }, { minTags: 0 })
    expect(outcome.fallbackUsed).toBe(true)
    expect(outcome.ok).toBe(true)
    expect(outcome.quality).toBe('fallback')
  })
})
