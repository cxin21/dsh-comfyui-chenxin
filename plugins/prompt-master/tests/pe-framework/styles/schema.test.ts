import { describe, expect, it } from 'vitest'
import { validateStylePreset, RATING_ORDER } from '../../../src/pe-framework/styles/schema.js'
import type { Rating } from '../../../src/pe-framework/types.js'

const valid = {
  id: 'nb01_x', name: '测试', category: 'anime', rating: 'safe',
  fragments: { image: 'cel shading, flat colors', video: 'cel shading, flat colors' },
  negative_hints: ['impasto'], artist_hints: ['rella'], artist_max: 3,
  applies_to: ['anima', 'h3', 'sd'], source: 'newbie-migrated',
}

describe('validateStylePreset', () => {
  it('accepts a valid preset', () => {
    const r = validateStylePreset(valid)
    expect(r.ok).toBe(true)
  })
  it('rejects missing required fields with field-path errors', () => {
    const r = validateStylePreset({ ...valid, category: undefined, fragments: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('category'))).toBe(true)
      expect(r.errors.some((e) => e.includes('fragments'))).toBe(true)
    }
  })
  it('rejects bad rating enum and empty fragments channels', () => {
    expect(validateStylePreset({ ...valid, rating: 'r18' }).ok).toBe(false)
    expect(validateStylePreset({ ...valid, fragments: { image: '', video: 'x' } }).ok).toBe(false)
  })
  it('rejects empty negative_hints and non-positive artist_max', () => {
    expect(validateStylePreset({ ...valid, negative_hints: [] }).ok).toBe(false)
    expect(validateStylePreset({ ...valid, artist_max: 0 }).ok).toBe(false)
  })
  it('nsfw presets must apply to anima only', () => {
    expect(validateStylePreset({ ...valid, rating: 'explicit' }).ok).toBe(false)
    expect(validateStylePreset({ ...valid, rating: 'explicit', applies_to: ['anima'] }).ok).toBe(true)
    expect(validateStylePreset({ ...valid, rating: 'sensitive', applies_to: ['anima'] }).ok).toBe(true)
  })
  it('rejects unknown category', () => {
    expect(validateStylePreset({ ...valid, category: 'wuxia' }).ok).toBe(false)
  })
  it('rating order is safe<sensitive<explicit', () => {
    expect(RATING_ORDER).toEqual<Rating[]>(['safe', 'sensitive', 'explicit'])
  })
})
