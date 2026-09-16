import { describe, expect, it } from 'vitest'
import { orchestrateCompositing } from '../../../src/pe-framework/compositing/orchestrate.js'
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js'

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
  praise: ['clean mapping'],
})
const NEEDS_JUDGE = JSON.stringify({
  verdict: 'needs_revision',
  dimensionScores: { 'blueprint-fidelity': 60, 'nl-quality': 70, 'tag-selection': 80, 'negative-template': 90, 'composition-coherence': 85, 'aesthetic-vocabulary': 88 },
  findings: [{ severity: 'major', dimension: 'blueprint-fidelity', problem: 'mood not expressed', evidence: { tool: 'catalog', query: 'nocturnal', result: 'missing' }, requiredFix: 'express nocturnal mood in nl' }],
  praise: [],
})

describe('orchestrateCompositing (spec §2/§8)', () => {
  it('happy path: enrich → pack → writer → judge pass; corrections=0, ok=true', async () => {
    const outcome = await orchestrateCompositing(V0, 'explicit', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      critic: async () => PASS_JUDGE,
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.corrections).toBe(0)
    expect(outcome.fallbackUsed).toBe(false)
    expect(outcome.positive).toContain('rating_explicit')
    expect(outcome.positive).toContain('long black hair')
    expect(outcome.v1.mood).toContain('quietly tense')
    expect(outcome.judge?.verdict).toBe('pass')
    expect(outcome.advisories.some((a) => a.startsWith('enrich_path_violation'))).toBe(false)
  })
  it('fabricated tag → narrow repair: writer re-entered with frozen hash + feedback; enrich frozen (D4)', async () => {
    const writerPrompts: string[] = []
    let authorCalls = 0
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => { authorCalls++; return ENRICH_PATCH },
      writerRunner: async (p: string) => {
        writerPrompts.push(p)
        return writerPrompts.length === 1
          ? JSON.stringify({ tags: [{ text: 'neon glow', source_concept: 'S1.pose' }], nl: 'She stands alone. Lantern light glows.', negative: [], dropped_concepts: [] })
          : VALID_OUT
      },
      critic: async () => PASS_JUDGE,
      search: SEARCH,
    }, { minTags: 0 })
    expect(authorCalls).toBe(1) // 蓝图/扩写冻结（D4）
    expect(writerPrompts.length).toBe(2)
    expect(writerPrompts[1]).toContain('frozen blueprint_v1_hash')
    expect(writerPrompts[1]).toContain('fabricated_tag')
    expect(outcome.corrections).toBe(1)
    expect(outcome.ok).toBe(true)
  })
  it('judge needs_revision persists 2 rounds → loop_exhausted advisory, ok stays true (P3 parity)', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      critic: async () => NEEDS_JUDGE,
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.corrections).toBe(2)
    expect(outcome.advisories).toContain('loop_exhausted:true')
    expect(outcome.ok).toBe(true)
    expect(outcome.judgeFeedback[0]).toContain('express nocturnal mood')
  })
  it('no writerRunner → immediate deterministic fallback, ok=true (D7 fail-open)', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', { search: SEARCH }, { minTags: 0 })
    expect(outcome.fallbackUsed).toBe(true)
    expect(outcome.ok).toBe(true)
    expect(outcome.advisories).toContain('writer_fallback_used')
    expect(outcome.positive.length).toBeGreaterThan(0)
  })
  it('writer parse failure → fallback with writer_parse_failed advisory', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => 'not json at all',
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.fallbackUsed).toBe(true)
    expect(outcome.advisories.some((a) => a.startsWith('writer_parse_failed'))).toBe(true)
  })
  it('judge critic error → judge_skipped, audit gates alone decide', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      critic: async () => { throw new Error('llm down') },
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.advisories.some((a) => a.startsWith('judge_skipped'))).toBe(true)
    expect(outcome.ok).toBe(true)
  })
  it('repair round judge prompt carries previous findings (audit P4a 跨轮去重)', async () => {
    const criticPrompts: string[] = []
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      critic: async (p: unknown) => {
        criticPrompts.push(typeof p === 'string' ? p : JSON.stringify(p))
        return NEEDS_JUDGE
      },
      search: SEARCH,
    }, { minTags: 0 })
    expect(criticPrompts.length).toBeGreaterThanOrEqual(2)
    expect(criticPrompts[0]).not.toContain('<previous_findings>')
    // 第二轮 judge 必须看到第一轮的 major finding requiredFix，才能执行去重指令
    expect(criticPrompts[1]).toContain('<previous_findings>')
    expect(criticPrompts[1]).toContain('express nocturnal mood in nl')
    expect(outcome.corrections).toBe(2)
  })
})
