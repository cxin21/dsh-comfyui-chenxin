import { describe, expect, it } from 'vitest'
import { MINIMAL_STYLES, applyStyle } from '../../../src/pe-framework/enrichment/style.js'
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'

const bp: BlueprintV1 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } }

describe('minimal style library', () => {
  it('has exactly 8 styles with non-empty fragments', () => {
    expect(MINIMAL_STYLES).toHaveLength(8)
    for (const s of MINIMAL_STYLES) {
      expect(s.prompt_fragments.image.length).toBeGreaterThan(0)
      expect(s.prompt_fragments.video.length).toBeGreaterThan(0)
    }
  })
  it('applyStyle at conformity 0 injects base style', () => {
    const out = applyStyle(bp, 'cinematic_real', 0)
    expect(out.core.style?.base).toContain('写实')
  })
  it('applyStyle unknown id returns unchanged', () => {
    const out = applyStyle(bp, 'nope', 0.6)
    expect(out).toBe(bp)
  })
})
