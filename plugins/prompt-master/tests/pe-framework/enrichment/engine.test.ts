import { describe, expect, it } from 'vitest'
import { enrichBlueprint } from '../../../src/pe-framework/enrichment/engine.js'
import { textStream, stubCtx } from '../../plugin/helpers.js'

const ctx = {
  llm: { async *stream() { for (const c of textStream('{"core":{"concept":"黄昏荒原上的剑客","negative":[{"target":"现代元素"}]}}')) yield c } },
} as any

const v0 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } } as any

describe('enrichBlueprint', () => {
  it('returns expanded blueprint + expansions audit trail', async () => {
    const out = await enrichBlueprint(ctx, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.blueprint.core.concept.length).toBeGreaterThan(0)
    expect(Array.isArray(out.expansions)).toBe(true)
  })

  it('injects all six CINEMA_LEXICON categories into the expansion persona (spec §7.1 ROI 补全)', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    const system = stb.llm.calls[0]?.system ?? ''
    for (const label of ['景别', '焦段', '运镜', '光线', '色彩分级', '构图']) {
      expect(system).toContain(label)
    }
    // t2 深化词也注入候选词库（可被 LLM 引用补全）
    expect(system).toContain('16mm')
    expect(system).toContain('背光')
    expect(system).toContain('胶片颗粒')
  })

  it('appends field_completeness advisory (non-blocking) when key dimension style|scene|emotion missing (spec §7.1)', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    expect(out.expansions).toContain('field_completeness:missing:style|scene|emotion')
    // 不阻断：patch 仍被应用
    expect(out.blueprint.core.concept).toBe('黄昏荒原上的剑客')
  })

  it('does not flag field_completeness when style is present', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.expansions.some((e) => e.startsWith('field_completeness'))).toBe(false)
  })
})
