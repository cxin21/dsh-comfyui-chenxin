import { describe, expect, it } from 'vitest'
import { CINEMA_LEXICON } from '../../../src/pe-framework/aesthetics/lexicon.js'

describe('cinema lexicon', () => {
  it('has non-empty structured categories with concrete terms', () => {
    for (const key of ['shots', 'lenses', 'camera_moves', 'lighting', 'grading', 'composition'] as const) {
      expect(CINEMA_LEXICON[key].length).toBeGreaterThan(3)
      for (const term of CINEMA_LEXICON[key]) expect(term.length).toBeGreaterThan(1)
    }
  })
})
