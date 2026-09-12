import { describe, expect, it } from 'vitest'
import { resolveRating, resolveEffectiveRating, RATING_SEEDS, RATING_NEGATIVE_ADDITIONS } from '../../../src/pe-framework/safety/rating.js'

describe('resolveRating (spec §5.2)', () => {
  it('explicit input wins over keywords', () => {
    expect(resolveRating('safe', 'nude girls')).toEqual({ rating: 'safe', source: 'input' })
  })
  it('keyword escalation to explicit and sensitive', () => {
    expect(resolveRating(undefined, 'she is nude')?.rating).toBe('explicit')
    expect(resolveRating(undefined, 'bikini at the beach')?.rating).toBe('sensitive')
    expect(resolveRating(undefined, 'nude bikini')?.rating).toBe('explicit') // 双命中取高
  })
  it('no signal stays safe without escalation', () => {
    expect(resolveRating(undefined, 'a knight on a hill')).toEqual({ rating: 'safe', source: 'keyword' })
  })
  it('policy tables are complete per rating', () => {
    expect(RATING_SEEDS.safe).toEqual(['safe'])
    expect(RATING_SEEDS.explicit).toEqual(['rating_explicit'])
    expect(RATING_NEGATIVE_ADDITIONS.sensitive).toContain('rating_explicit')
    expect(RATING_NEGATIVE_ADDITIONS.explicit).toContain('loli')
    expect(RATING_NEGATIVE_ADDITIONS.safe).toEqual([])
  })
  it('slots mapping: rating field > explicit bool > keywords', () => {
    expect(resolveEffectiveRating({ rating: 'sensitive', explicit: true })).toBe('sensitive')
    expect(resolveEffectiveRating({ explicit: true })).toBe('explicit')
    expect(resolveEffectiveRating({ detail_mood: ['nude'] })).toBe('explicit')
    expect(resolveEffectiveRating({})).toBe('safe')
  })
})
