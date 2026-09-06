import { describe, expect, it } from 'vitest'
import { validateBlueprint } from '../../../src/pe-framework/blueprint/schema.js'

describe('validateBlueprint', () => {
  it('accepts a minimal valid image blueprint', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'image',
      core: { concept: '黄昏荒原的剑客', aspect_ratio: '16:9', negative: [] },
      media_layer: { image: { lighting_detail: '黄金时刻' } },
    })
    expect(r.ok).toBe(true)
  })
  it('rejects missing concept', () => {
    const r = validateBlueprint({ schema_version: 1, media: 'video', core: {} })
    expect(r.ok).toBe(false)
    expect((r as { errors: string[] }).errors.join()).toContain('concept')
  })
  it('rejects bad aspect_ratio', () => {
    const r = validateBlueprint({ schema_version: 1, media: 'image', core: { concept: 'x', aspect_ratio: '5:7' } })
    expect(r.ok).toBe(false)
  })
  it('rejects video total_duration outside 4-15', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'video',
      core: { concept: 'x' },
      media_layer: { video: { total_duration_seconds: 30, shots: [{ beat: 'a' }] } },
    })
    expect(r.ok).toBe(false)
  })
})
