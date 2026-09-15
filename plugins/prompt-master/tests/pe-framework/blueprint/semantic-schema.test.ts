import { describe, expect, it } from 'vitest'
import { validateSemanticBlueprint, detectTagForm } from '../../../src/pe-framework/blueprint/semantic-schema.js'

const GOOD = {
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

describe('validateSemanticBlueprint (spec §3)', () => {
  it('valid blueprint passes with empty missing', () => {
    const r = validateSemanticBlueprint(GOOD)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.missing).toEqual([])
  })
  it('media!=image rejected', () => {
    expect(validateSemanticBlueprint({ ...GOOD, media: 'video' }).ok).toBe(false)
  })
  it('empty subjects rejected', () => {
    expect(validateSemanticBlueprint({ ...GOOD, subjects: [] }).ok).toBe(false)
  })
  it('duplicate subject id rejected', () => {
    const bp = { ...GOOD, subjects: [GOOD.subjects[0], { ...GOOD.subjects[0] }] }
    expect(validateSemanticBlueprint(bp).ok).toBe(false)
  })
  it('missing mood tolerated as empty missing advisory, not error', () => {
    const { mood, ...rest } = GOOD
    const r = validateSemanticBlueprint(rest)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.missing).toContain('mood')
  })
  it('non-object rejected', () => {
    expect(validateSemanticBlueprint('x').ok).toBe(false)
  })
})

describe('detectTagForm (spec §3 D3)', () => {
  it('plain english phrases pass', () => {
    expect(detectTagForm('long black hair')).toBe(false)
    expect(detectTagForm('warm sunset glow from the west')).toBe(false)
  })
  it('tag forms flagged', () => {
    expect(detectTagForm('long_hair')).toBe(true)
    expect(detectTagForm('1girl')).toBe(true)
    expect(detectTagForm('2girls')).toBe(true)
    expect(detectTagForm('@as109')).toBe(true)
    expect(detectTagForm('score_9')).toBe(true)
  })
  it('flagged inside longer text', () => {
    expect(detectTagForm('she has long_hair and a hat')).toBe(true)
  })
})
