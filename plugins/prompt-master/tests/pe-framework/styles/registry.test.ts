import { describe, expect, it } from 'vitest'
import { loadStylePresets, getStylePreset, listStylePresets, stylePresetCount } from '../../../src/pe-framework/styles/registry.js'

describe('style registry (spec §4.2)', () => {
  const loaded = loadStylePresets()

  it('loads 55 presets with no conflicts', () => {
    expect(loaded.advisories).toEqual([])
    expect(stylePresetCount()).toBe(55)
  })
  it('get by id returns preset; unknown returns undefined', () => {
    expect(getStylePreset('cinematic_real')?.category).toBe('photography')
    expect(getStylePreset('nb01_2024顶级画师混搭_rella_wlop')?.source).toBe('newbie-migrated')
    expect(getStylePreset('nope')).toBeUndefined()
  })
  it('rating filter: safe session never sees sensitive/explicit presets', () => {
    const safe = listStylePresets({ maxRating: 'safe' })
    expect(safe.every((p) => p.rating === 'safe')).toBe(true)
  })
  it('category + applies_to + query filters compose', () => {
    expect(listStylePresets({ category: 'anime' }).every((p) => p.category === 'anime')).toBe(true)
    expect(listStylePresets({ appliesTo: 'h3' }).every((p) => p.applies_to.includes('h3'))).toBe(true)
    expect(listStylePresets({ query: 'rella' }).length).toBeGreaterThanOrEqual(1)
  })
})
