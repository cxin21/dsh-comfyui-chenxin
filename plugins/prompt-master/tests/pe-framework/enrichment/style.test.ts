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

  it('applyStyle at conformity 0 injects full fragment into shots', () => {
    const out = applyStyle(bp, 'cinematic_real', 0)
    // cinematic_real video fragment 5 短语，全量注入 → 含最后一短语
    expect(out.media_layer.video?.shots[0]?.action).toContain('青橙色彩分级')
  })

  it('applyStyle at 0<conformity<1 injects proportional complete phrases (3/5 at 0.6)', () => {
    const out = applyStyle(bp, 'cinematic_real', 0.6)
    // round(0.6×5)=3 → 前 3 个完整短语注入
    expect(out.media_layer.video?.shots[0]?.action).toContain('IMAX 胶片质感')
    expect(out.media_layer.video?.shots[0]?.action).toContain('Panavision C 系 35mm f4')
    expect(out.media_layer.video?.shots[0]?.action).toContain('伦勃朗光')
    // 第 4/5 短语不注入（比例注入完整短语，不截断、不溢出）
    expect(out.media_layer.video?.shots[0]?.action).not.toContain('黄昏黄金时刻')
    expect(out.media_layer.video?.shots[0]?.action).not.toContain('青橙色彩分级')
    // core.style 仍写入（参考）
    expect(out.core.style?.base).toContain('写实')
  })

  it('applyStyle at tiny 0<conformity<1 keeps at least 1 complete phrase', () => {
    const out = applyStyle(bp, 'cinematic_real', 0.05)
    expect(out.media_layer.video?.shots[0]?.action).toContain('IMAX 胶片质感')
    // 绝不产生半句话：注入内容必为完整短语的以「，」分隔的头部
    const action = out.media_layer.video?.shots[0]?.action ?? ''
    for (const part of action.split('，')) {
      const t = part.trim()
      if (t.length === 0) continue
      expect(['IMAX 胶片质感', 'Panavision C 系 35mm f4', '伦勃朗光', '黄昏黄金时刻', '青橙色彩分级']).toContain(t)
    }
  })

  it('applyStyle at conformity >= 1 only references style, does not inject fragment', () => {
    const out = applyStyle(bp, 'cinematic_real', 1)
    expect(out.core.style?.base).toContain('写实')
    expect(out.media_layer.video?.shots[0]?.action).toBeUndefined()
    const out2 = applyStyle(bp, 'cinematic_real', 1.5)
    expect(out2.media_layer.video?.shots[0]?.action).toBeUndefined()
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
