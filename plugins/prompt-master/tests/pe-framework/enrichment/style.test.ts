import { describe, expect, it } from 'vitest'
import { MINIMAL_STYLES, applyStyle } from '../../../src/pe-framework/enrichment/style.js'
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'

const bp: BlueprintV1 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } }

/** 空泛词清单：spec §7.2「内容化治理」要求 prompt_fragments 用具体名词，不用空泛形容词 */
const VAGUE_WORDS = ['cinematic', 'beautiful', '大气', '电影感']

const requiredFields: (keyof (typeof MINIMAL_STYLES)[number])[] = [
  'id',
  'name',
  'prompt_fragments',
  'applies_to',
  'negative_hints',
]

describe('minimal style library', () => {
  it('has at least 10 styles (spec §17 Phase 2: 10+ style templates)', () => {
    expect(MINIMAL_STYLES.length).toBeGreaterThanOrEqual(10)
  })

  it('every style keeps the full v0 structure (id/name/prompt_fragments/applies_to/negative_hints)', () => {
    for (const s of MINIMAL_STYLES) {
      for (const f of requiredFields) {
        expect(s, `style ${s.id} missing field ${String(f)}`).toHaveProperty(f)
      }
      // prompt_fragments 双通道
      expect(s.prompt_fragments.image.length).toBeGreaterThan(0)
      expect(s.prompt_fragments.video.length).toBeGreaterThan(0)
      expect(s.applies_to.length).toBeGreaterThan(0)
      expect(s.negative_hints.length).toBeGreaterThan(0)
    }
  })

  it('every prompt fragment is concrete nouns, no vague words (cinematic/beautiful/大气/电影感)', () => {
    for (const s of MINIMAL_STYLES) {
      const image = s.prompt_fragments.image.toLowerCase()
      const video = s.prompt_fragments.video.toLowerCase()
      for (const w of VAGUE_WORDS) {
        expect(image, `style ${s.id} image contains vague word ${w}`).not.toContain(w)
        expect(video, `style ${s.id} video contains vague word ${w}`).not.toContain(w)
      }
    }
  })

  it('style ids are unique', () => {
    const ids = MINIMAL_STYLES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('applyStyle at conformity 0 injects base style', () => {
    const out = applyStyle(bp, 'cinematic_real', 0)
    expect(out.core.style?.base).toContain('写实')
  })

  it('applyStyle at conformity 0 injects fragment into shots', () => {
    const out = applyStyle(bp, 'cinematic_real', 0)
    expect(out.media_layer.video?.shots[0]?.action).toContain('Panavision')
  })

  it('applyStyle at conformity > 0 only references style, does not inject fragment', () => {
    const out = applyStyle(bp, 'cinematic_real', 0.6)
    expect(out.core.style?.base).toContain('写实')
    expect(out.media_layer.video?.shots[0]?.action).toBeUndefined()
  })

  it('applyStyle unknown id returns unchanged', () => {
    const out = applyStyle(bp, 'nope', 0.6)
    expect(out).toBe(bp)
  })

  it('applyStyle does not mutate the input blueprint', () => {
    const copy = structuredClone(bp)
    applyStyle(bp, 'cinematic_real', 0)
    expect(bp).toEqual(copy)
  })
})
