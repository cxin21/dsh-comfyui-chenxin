import { describe, expect, it } from 'vitest'
import { validateBlueprint } from '../../../src/pe-framework/blueprint/schema.js'

describe('validateBlueprint', () => {
  it('accepts a minimal valid image blueprint', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'image',
      core: { concept: '黄昏荒原的剑客', aspect_ratio: '16:9', negative: [] },
      media_layer: { image: { lighting_detail: '黄金时刻' } },
    })
    expect(r.ok).toBe(true)
  })
  it('rejects missing concept', () => {
    const r = validateBlueprint({ schema_version: 1, media: 'video', core: {} })
    expect(r.ok).toBe(false)
    expect((r as { errors: string[] }).errors.join()).toContain('concept')
  })
  it('rejects bad aspect_ratio', () => {
    const r = validateBlueprint({ schema_version: 1, media: 'image', core: { concept: 'x', aspect_ratio: '5:7' } })
    expect(r.ok).toBe(false)
  })
  it('rejects video total_duration outside 4-15', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'video',
      core: { concept: 'x' },
      media_layer: { video: { total_duration_seconds: 30, shots: [{ beat: 'a' }] } },
    })
    expect(r.ok).toBe(false)
  })
  it('rejects media outside image|video|mixed', () => {
    // O5：计划 Task 2 自带用例未覆盖 media 非法值——schema.ts 实际报错含 'media must be one of image|video|mixed'
    const r = validateBlueprint({ schema_version: 1, media: 'landscape', core: { concept: 'x', negative: [] } })
    expect(r.ok).toBe(false)
    const errors = (r as { errors: string[] }).errors
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join()).toContain('media')
    expect(errors.join()).toContain('image|video|mixed')
  })
  it('rejects video.shots as empty array', () => {
    // O5：计划 Task 2 自带用例未覆盖 shots 空数组——schema.ts 实际报错含 'media_layer.video.shots must be a non-empty array'
    const r = validateBlueprint({
      schema_version: 1, media: 'video',
      core: { concept: 'x', negative: [] },
      media_layer: { video: { total_duration_seconds: 15, shots: [] } },
    })
    expect(r.ok).toBe(false)
    const errors = (r as { errors: string[] }).errors
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join()).toContain('shots')
  })
  it('rejects negative entry missing target (M5-DIAG2 真实会话 c07 崩溃根因——LLM 产物形状收口)', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'image',
      core: { concept: 'x', negative: [{ severity: 'soft' }, { target: '文字', severity: 'soft' }] },
      media_layer: { image: {} },
    })
    expect(r.ok).toBe(false)
    const errors = (r as { errors: string[] }).errors
    expect(errors.join()).toContain('core.negative[0].target')
  })
  it('rejects negative entry with invalid severity', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'image',
      core: { concept: 'x', negative: [{ target: '文字', severity: 'medium' }] },
      media_layer: { image: {} },
    })
    expect(r.ok).toBe(false)
    expect((r as { errors: string[] }).errors.join()).toContain("core.negative[0].severity must be 'soft'|'hard'")
  })
  it('accepts well-formed soft/hard negative entries', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'image',
      core: { concept: 'x', negative: [{ target: '文字', severity: 'soft' }, { target: '现代元素', severity: 'hard' }] },
      media_layer: { image: {} },
    })
    expect(r.ok).toBe(true)
  })
})
