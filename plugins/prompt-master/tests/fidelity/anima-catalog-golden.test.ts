import { describe, expect, it, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { readGolden } from './harness.js'
import { searchCatalog, closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const FIXTURE_TAGS: Array<{ tag: string; safe: string; kind: string }> = [
  { tag: 'silvery hair', safe: 'silvery_hair', kind: 'canonical' },
  { tag: 'long hair', safe: 'long_hair', kind: 'canonical' },
  { tag: 'blue sky', safe: 'blue_sky', kind: 'canonical' },
  { tag: 'clouds', safe: 'clouds', kind: 'alias' },
  { tag: 'wave', safe: 'wave', kind: 'alias' },
  { tag: 'grinning', safe: 'grinning', kind: 'alias' },
  { tag: 'silver hair', safe: 'silver_hair', kind: 'fuzzy' },
  { tag: 'expression', safe: 'expression', kind: 'fuzzy' },
  { tag: 'zzzqnoise_x1', safe: 'zzzqnoise_x1', kind: 'fuzzy' },
  { tag: 'zzzzzzzzq', safe: 'zzzzzzzzq', kind: 'miss' },
  { tag: 'qwertyytrewq', safe: 'qwertyytrewq', kind: 'miss' },
  { tag: 'xyxwqvqww', safe: 'xyxwqvqww', kind: 'miss' },
]

describe('anima catalog golden double-run (contracts.md ④ 记录集相等)', () => {
  for (const { tag, safe, kind } of FIXTURE_TAGS) {
    it(`${kind}: ${tag} — TS hits match golden record set (record_id/prompt_form/usage_count/match identity)`, () => {
      const entry = readGolden(`anima-${safe}`)
      const goldenHits = (entry.pythonOutput as any).hits ?? []
      const tsHits = searchCatalog(tag, { limit: 5 })
      const actual = tsHits.map((h) => ({
        record_id: h.record_id,
        prompt_form: h.prompt_form,
        usage_count: h.usage_count,
        match_type: h.match_type,
        matched_name: h.raw,
      }))
      const expected = goldenHits.map((h: any) => ({
        record_id: h.record_id,
        prompt_form: h.prompt_form,
        usage_count: h.usage_count,
        match_type: h.match_type,
        matched_name: h.matched_name,
      }))
      expect(actual).toEqual(expected)
    })
  }

  it('golden files are sha256-self-consistent (M5)', () => {
    for (const { safe } of FIXTURE_TAGS) {
      const entry = readGolden(`anima-${safe}`)
      const sha = createHash('sha256').update(JSON.stringify(entry.pythonOutput)).digest('hex')
      expect(sha, `anima-${safe}`).toBe(entry.sha256)
    }
  })

  afterAll(() => closeCatalog())
})