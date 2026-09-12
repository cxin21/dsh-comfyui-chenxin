import { describe, expect, it } from 'vitest'
import { detectAestheticGates, AESTHETIC_ANCHOR_WORDS } from '../../../src/pe-framework/aesthetics/audit.js'
import { LIGHTING_BAN } from '../../../src/pe-framework/dialect/anima.js'

describe('aesthetic gates (spec §6.1)', () => {
  it('bare prompt triggers all four gates with card hints', () => {
    const gates = detectAestheticGates('masterpiece, best quality, score_7, 1girl, white dress')
    expect(gates.map((g) => g.id)).toEqual(expect.arrayContaining([
      'aesthetic_composition_missing', 'aesthetic_lighting_missing', 'aesthetic_palette_missing', 'aesthetic_focal_missing',
    ]))
    for (const g of gates) expect(g.cardIds.length).toBeGreaterThan(0)
  })
  it('fully anchored prompt triggers none', () => {
    const p = 'masterpiece, 1girl, rule of thirds, golden hour long shadows, warm amber tones, close-up, shallow depth of field'
    expect(detectAestheticGates(p)).toEqual([])
  })
  it('card tags themselves never trigger gates (ban-safe vocabulary)', () => {
    const p = 'cinematic lighting, dramatic shadows, rule of thirds, limited palette, close-up'
    expect(detectAestheticGates(p)).toEqual([])
  })
  it('gate cardField mapping follows spec §6.1 (composition/lighting/color/perspective)', () => {
    const gates = detectAestheticGates('masterpiece, best quality, 1girl, white dress')
    const m = Object.fromEntries(gates.map((g) => [g.id, g.cardField]))
    expect(m).toEqual({
      aesthetic_composition_missing: 'composition',
      aesthetic_lighting_missing: 'lighting',
      aesthetic_palette_missing: 'color',
      aesthetic_focal_missing: 'perspective',
    })
  })
  it('lighting anchor words are all LIGHTING_BAN-compliant (repair hints never inject banned terms)', () => {
    for (const w of AESTHETIC_ANCHOR_WORDS.lighting) {
      for (const b of LIGHTING_BAN) {
        expect(w.includes(b), `lighting anchor "${w}" hits LIGHTING_BAN term "${b}"`).toBe(false)
      }
    }
  })
})
