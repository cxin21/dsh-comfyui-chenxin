import { describe, expect, it } from 'vitest'
import { checkConcreteness, checkShotDensity } from '../../../src/pe-framework/aesthetics/check.js'

describe('checkConcreteness', () => {
  it('flags empty vague words', () => {
    const r = checkConcreteness({ schema_version: 1, media: 'image', core: { concept: 'beautiful amazing 高级感', negative: [] } } as any)
    expect(r.pass).toBe(false)
    expect(r.issues.length).toBeGreaterThan(0)
  })
  it('passes concrete nouns', () => {
    const r = checkConcreteness({ schema_version: 1, media: 'image', core: { concept: '黄昏荒原上的银发剑客，Panavision 35mm，伦勃朗光', negative: [] } } as any)
    expect(r.pass).toBe(true)
  })
})

describe('checkShotDensity', () => {
  it('flags video shot whose action is a single short clause missing detail dims', () => {
    const bp = {
      schema_version: 1,
      media: 'video',
      core: { concept: '打斗', negative: [] },
      media_layer: {
        video: {
          total_duration_seconds: 15,
          shots: [
            { beat: '对峙', action: '两名女剑客持剑对峙', camera: '', shot_size: '' },
          ],
        },
      },
    } as any
    const r = checkShotDensity(bp)
    expect(r.issues.length).toBeGreaterThan(0)
  })
  it('passes video shot whose action covers subject+environment+lighting+camera+emotion', () => {
    const bp = {
      schema_version: 1,
      media: 'video',
      core: {
        concept: '打斗',
        negative: [],
        scene: { lighting: '黄昏侧逆光' },
      },
      media_layer: {
        video: {
          total_duration_seconds: 15,
          shots: [
            {
              beat: '对峙',
              action: '两名女剑客相距数米持剑对峙，衣摆与尘埃灰烬在风中翻飞，紧张凝滞的气氛，废墟都市中央',
              camera: '缓慢环绕推进',
              shot_size: '中景',
            },
          ],
        },
      },
    } as any
    const r = checkShotDensity(bp)
    expect(r.pass).toBe(true)
  })
  it('ignores image media (no shots to check)', () => {
    const r = checkShotDensity({ schema_version: 1, media: 'image', core: { concept: 'x', negative: [] } } as any)
    expect(r.pass).toBe(true)
  })
})
