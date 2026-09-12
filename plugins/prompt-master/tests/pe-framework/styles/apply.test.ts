import { describe, expect, it } from 'vitest'
import { applyStyle } from '../../../src/pe-framework/styles/apply.js'
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'

const bp: BlueprintV1 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } }

const CINEMATIC_PHRASES = ['IMAX film grain', 'anamorphic lens flare', 'teal and orange grading', 'golden hour ambience', 'shallow depth of field']

describe('applyStyleV2 (spec §4.3, registry-backed)', () => {
  it('applyStyle at conformity 0 injects base style', () => {
    const out = applyStyle(bp, 'cinematic_real', 0)
    expect(out.core.style?.base).toBe('photorealistic')
  })

  it('applyStyle at conformity 0 injects full fragment into shots', () => {
    const out = applyStyle(bp, 'cinematic_real', 0)
    expect(out.media_layer.video?.shots[0]?.action).toContain('shallow depth of field')
  })

  it('applyStyle writes artist_hints into core.style (media-agnostic)', () => {
    const out = applyStyle(bp, 'cinematic_real', 1)
    expect(out.core.style?.artist_hints).toEqual(['guweiz', 'wlop', 'ask (askzy)'])
  })

  it('applyStyle at 0<conformity<1 injects proportional complete phrases (3/5 at 0.6)', () => {
    const out = applyStyle(bp, 'cinematic_real', 0.6)
    expect(out.media_layer.video?.shots[0]?.action).toContain('IMAX film grain')
    expect(out.media_layer.video?.shots[0]?.action).toContain('anamorphic lens flare')
    expect(out.media_layer.video?.shots[0]?.action).toContain('teal and orange grading')
    expect(out.media_layer.video?.shots[0]?.action).not.toContain('golden hour ambience')
    expect(out.media_layer.video?.shots[0]?.action).not.toContain('shallow depth of field')
    expect(out.core.style?.base).toBe('photorealistic')
  })

  it('applyStyle at tiny 0<conformity<1 keeps at least 1 complete phrase', () => {
    const out = applyStyle(bp, 'cinematic_real', 0.05)
    expect(out.media_layer.video?.shots[0]?.action).toContain('IMAX film grain')
    const action = out.media_layer.video?.shots[0]?.action ?? ''
    for (const part of action.split(/[，,]/)) {
      const t = part.trim()
      if (t.length === 0) continue
      expect(CINEMATIC_PHRASES).toContain(t)
    }
  })

  it('applyStyle at conformity >= 1 only references style, does not inject fragment', () => {
    const out = applyStyle(bp, 'cinematic_real', 1)
    expect(out.core.style?.base).toBe('photorealistic')
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

  it('wires negative_hints into core.negative as soft constraints on image (anima channel), dedup case-insensitive', () => {
    const imageBp: BlueprintV1 = { schema_version: 1, media: 'image', core: { concept: '剑客肖像', negative: [{ target: 'Amateur Photography', severity: 'soft' }] }, media_layer: { image: {} } }
    const out = applyStyle(imageBp, 'cinematic_real', 1)
    const targets = (out.core.negative ?? []).map((n) => n.target)
    expect(targets.filter((t) => t.toLowerCase() === 'amateur photography')).toHaveLength(1)
    expect(targets).toContain('over-sharpened')
  })

  // M2-T2（spec §4.3 备注）：h3 方言无 negative 通道——video 蓝图不并入 negative_hints
  //（M1 行为是把 soft 负向静默写进 video 蓝图 core.negative，下游 h3 投影永不消费 = 静默丢弃）。
  it('video blueprint (h3 channel) skips negative_hints merge — no silent drop into unconsumed channel', () => {
    const out = applyStyle(bp, 'cinematic_real', 0.6)
    expect(bp.media).toBe('video')
    expect(out.core.negative ?? []).toEqual([])
    // 风格其余注入行为不变（对照：artist_hints 仍写入）
    expect(out.core.style?.artist_hints).toEqual(['guweiz', 'wlop', 'ask (askzy)'])
  })
  it('caps artist_hints at preset artist_max', () => {
    const out = applyStyle(bp, 'nb01_2024顶级画师混搭_rella_wlop', 1)
    expect(out.core.style?.artist_hints).toHaveLength(3) // artist_max=3, 候选 5
  })
  it('conformity >= 1 keeps reference-only semantics (no fragment injection)', () => {
    const out = applyStyle(bp, 'cinematic_real', 1)
    expect(out.media_layer.video?.shots[0]?.action ?? '').not.toContain('IMAX')
  })
})
