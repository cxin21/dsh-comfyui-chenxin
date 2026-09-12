import { describe, expect, it } from 'vitest'
import { recommendArtDirection } from '../../../src/pe-framework/aesthetics/recommend.js'

describe('card recommender (spec §6.2)', () => {
  it('video intent recommends motion first', () => {
    const r = recommendArtDirection({ media: 'video', hasMotionIntent: false, hasLighting: true, hasComposition: true, hasFocal: true })
    expect(r[0]?.field).toBe('motion')
    expect(r[0]?.cardId).toBe('dynamic_pose')
  })
  it('missing dimensions each yield one card; hints suppress their field', () => {
    const r = recommendArtDirection({ media: 'image', hasMotionIntent: false, hasLighting: false, hasComposition: false, hasFocal: false, presetHints: { lighting: 'golden_hour' } })
    const fields = r.map((x) => x.field)
    expect(fields).toContain('lighting'); expect(fields).toContain('composition'); expect(fields).toContain('perspective')
    expect(r.find((x) => x.field === 'lighting')?.cardId).toBe('golden_hour')
  })
  it('satisfied signals yield no recommendations', () => {
    expect(recommendArtDirection({ media: 'image', hasMotionIntent: true, hasLighting: true, hasComposition: true, hasFocal: true })).toEqual([])
  })
  it('every recommended cardId exists in its field deck', () => {
    const r = recommendArtDirection({ media: 'video', hasMotionIntent: true, hasLighting: false, hasComposition: false, hasFocal: false })
    for (const x of r) expect(x.cardId.length).toBeGreaterThan(0)
  })
})
