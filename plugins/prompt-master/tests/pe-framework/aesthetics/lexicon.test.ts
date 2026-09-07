import { describe, expect, it } from 'vitest'
import { CINEMA_LEXICON } from '../../../src/pe-framework/aesthetics/lexicon.js'

/** 空泛词清单：spec §7.1「禁空泛词」对齐（cinematic/beautiful/amazing 等） */
const VAGUE_WORDS = ['cinematic', 'beautiful', 'amazing', '大气', '电影感']

const CATEGORIES = ['shots', 'lenses', 'camera_moves', 'lighting', 'grading', 'composition'] as const

describe('cinema lexicon', () => {
  it('keeps all six structured categories (spec §7.3)', () => {
    for (const key of CATEGORIES) {
      expect(CINEMA_LEXICON, `missing category ${key}`).toHaveProperty(key)
    }
  })

  it('each category has >= 8 concrete terms (Phase 2 deepening)', () => {
    for (const key of CATEGORIES) {
      expect(CINEMA_LEXICON[key].length, `category ${key} below 8`).toBeGreaterThanOrEqual(8)
    }
  })

  it('every term is a non-empty concrete noun, no vague words', () => {
    for (const key of CATEGORIES) {
      for (const term of CINEMA_LEXICON[key]) {
        expect(term.length).toBeGreaterThan(1)
        for (const w of VAGUE_WORDS) {
          expect(term.toLowerCase(), `category ${key} term "${term}" contains vague word ${w}`).not.toContain(w)
        }
      }
    }
  })

  it('terms within a category are unique', () => {
    for (const key of CATEGORIES) {
      const terms = CINEMA_LEXICON[key]
      expect(new Set(terms).size, `category ${key} has duplicates`).toBe(terms.length)
    }
  })
})
