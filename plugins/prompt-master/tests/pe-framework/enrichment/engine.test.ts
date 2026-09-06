import { describe, expect, it } from 'vitest'
import { enrichBlueprint } from '../../../src/pe-framework/enrichment/engine.js'
import { textStream } from '../../plugin/helpers.js'

const ctx = {
  llm: { async *stream() { for (const c of textStream('{"core":{"concept":"黄昏荒原上的剑客","negative":[{"target":"现代元素"}]}}')) yield c } },
} as any

describe('enrichBlueprint', () => {
  it('returns expanded blueprint + expansions audit trail', async () => {
    const v0 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } } as any
    const out = await enrichBlueprint(ctx, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.blueprint.core.concept.length).toBeGreaterThan(0)
    expect(Array.isArray(out.expansions)).toBe(true)
  })
})
