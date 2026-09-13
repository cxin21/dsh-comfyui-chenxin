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

  // M2-T2（spec §4.3 备注）：h3 通道 negative_hints 忽略必须可观测——advisory 由 engine 层补
  //（applyStyle 不感知展示通道，与 style_preset_unknown 同一口径）。
  it('emits style_negative_hints_h3_ignored:<id> advisory for video blueprints with styled negative_hints', async () => {
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.advisories).toContain('style_negative_hints_h3_ignored:cinematic_real')
    // 仍不注入：core.negative 保持原样（空）
    expect(out.blueprint.core.negative ?? []).toEqual([])
  })

  it('emits no h3-ignored advisory for image blueprints (negative_hints merged as usual)', async () => {
    const imageV0 = { schema_version: 1, media: 'image', core: { concept: '剑客肖像', negative: [] }, media_layer: { image: {} } } as any
    const patch = '{"set":{"core":{"concept":"黄昏荒原上的剑客"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, imageV0, { styleId: 'cinematic_real', conformity: 1 })
    expect(out.advisories ?? []).not.toContain('style_negative_hints_h3_ignored:cinematic_real')
    expect((out.blueprint.core.negative ?? []).map((n: { target: string }) => n.target)).toContain('over-sharpened')
  })
})

// ─── M5-T3（设计稿 D6/R7）deepMerge 硬化：core.rating 信任边界 ───
// 契约：patch 应用前 strip patch.core.rating（set/裸部分蓝图/additions 全通道、嵌套全形态），
// 覆写企图出 advisory enrich_rating_overwrite_blocked；无覆写企图零行为变化。
describe('enrichBlueprint core.rating trust boundary (M5-T3 R7/D6)', () => {
  const ratedV0 = {
    schema_version: 1,
    media: 'image',
    core: { concept: '剑客肖像', rating: 'explicit', negative: [] },
    media_layer: { image: {} },
  } as any

  it('set 通道嵌套形态：恶意 set.core.rating 被 strip——v1 仍 explicit + advisory；同 patch 良性字段照常应用', async () => {
    const patch = '{"set":{"core":{"rating":"safe","concept":"被覆写概念"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
    // 只 strip rating 键：同 patch 的良性 core 扩写不受影响
    expect(out.blueprint.core.concept).toBe('被覆写概念')
  })

  it('裸部分蓝图形态（无 set 键，整个对象视为 set）：core.rating 覆写被 strip + advisory', async () => {
    const patch = '{"core":{"rating":"sensitive"}}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.blueprint.core.concept).toBe('剑客肖像')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
  })

  it('additions 通道：additions.core 写入按覆写企图整键阻断 + advisory（rating 载体节点不信任 additions 通道）', async () => {
    const patch = '{"set":{},"additions":{"core":{"rating":"safe"}}}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.blueprint.core.concept).toBe('剑客肖像')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
  })

  it('set.core 非对象（标量）：整键 strip + advisory（防整体顶掉 core 节点连带 rating）', async () => {
    const patch = '{"set":{"core":"generic"}}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.blueprint.core.concept).toBe('剑客肖像')
    expect(out.advisories).toContain('enrich_rating_overwrite_blocked')
  })

  it('无覆写企图零行为变化：良性 patch 无 advisory 且照常应用', async () => {
    const patch = '{"set":{"core":{"concept":"良性扩写"}},"expansions":[]}'
    const stb = stubCtx({ stream: textStream(patch) })
    const out = await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, ratedV0, {})
    expect(out.blueprint.core.concept).toBe('良性扩写')
    expect(out.blueprint.core.rating).toBe('explicit')
    expect(out.advisories ?? []).not.toContain('enrich_rating_overwrite_blocked')
  })
})

// ─── M5-T3（V8）buildExpansionPersona media 分支 ───
describe('enrichBlueprint persona media branch (M5-T3 V8)', () => {
  const patch = '{"set":{},"expansions":[]}'

  it('video 蓝图：video shot 五维密度规则保持原文', async () => {
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    const system = stb.llm.calls[0]?.system ?? ''
    expect(system).toContain('每个 video shot 的 action 必须完整覆盖 5 个维度')
  })

  it('image 蓝图：video shot 五维规则退场，改用 image 画面密度纪律（防诱导编造 video.shots）', async () => {
    const imageV0 = { schema_version: 1, media: 'image', core: { concept: '剑客肖像', negative: [] }, media_layer: { image: {} } } as any
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, imageV0, {})
    const system = stb.llm.calls[0]?.system ?? ''
    expect(system).not.toContain('每个 video shot 的 action')
    expect(system).toContain('画面细节密度（硬性，image）')
  })
})

// ─── M5-T3（D7）recommendations 推荐先验通道 ───
describe('enrichBlueprint recommendations (M5-T3 D7)', () => {
  const patch = '{"set":{},"expansions":[]}'

  it('recommendations → user 段【推荐先验】块，文案与 enrich/engine.ts buildUser 同源逐字', async () => {
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {
      recommendations: [{ field: 'lighting', cardId: 'rim_backlight', reason: '主体轮廓需要与背景分离' }],
    })
    // stubCtx 捕获的是 dsh-llm GenerateOptions：system 直挂顶层，user 文本在 messages[0].content[] 块内
    const user = JSON.stringify(stb.llm.calls[0]?.messages?.[0]?.content ?? '')
    expect(user).toContain('【推荐先验】艺术指导推荐器建议（你仍做最终设计决策，每类至多 1 张）：')
    expect(user).toContain('- lighting: rim_backlight（主体轮廓需要与背景分离）')
  })

  it('无 recommendations：user 段不出现【推荐先验】块', async () => {
    const stb = stubCtx({ stream: textStream(patch) })
    await enrichBlueprint(stb as any, { provider: 'p', model: 'm' }, v0, {})
    const user = JSON.stringify(stb.llm.calls[0]?.messages?.[0]?.content ?? '')
    expect(user).not.toContain('【推荐先验】')
  })
})
