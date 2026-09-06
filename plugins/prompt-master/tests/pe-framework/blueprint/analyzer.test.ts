import { describe, expect, it } from 'vitest'
import { analyzeIntent } from '../../../src/pe-framework/blueprint/analyzer.js'
import { textStream } from '../../plugin/helpers.js'

const v0Json = JSON.stringify({
  schema_version: 1, media: 'video',
  core: { concept: '打斗 CG 动画', negative: [] },
  media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
})

describe('analyzeIntent', () => {
  it('returns validated blueprint + missing list', async () => {
    const ctx = { llm: { async *stream() { for (const c of textStream(v0Json)) yield c } } } as any
    const r = await analyzeIntent(ctx, { provider: 'p', model: 'm' }, '三镜头打斗CG', { clarify: 'auto' })
    expect(r.blueprint.media).toBe('video')
    expect(Array.isArray(r.missing)).toBe(true)
    expect(r.clarify_questions).toBeUndefined()
  })
  it('clarify=ask with missing key dims returns clarify_questions', async () => {
    const ctx = { llm: { async *stream() { for (const c of textStream(v0Json)) yield c } } } as any
    const r = await analyzeIntent(ctx, { provider: 'p', model: 'm' }, '一个场景', { clarify: 'ask' })
    // v0Json 无 style → 关键缺失 → 产出澄清问题
    expect(r.clarify_questions?.length).toBeGreaterThan(0)
  })
})
