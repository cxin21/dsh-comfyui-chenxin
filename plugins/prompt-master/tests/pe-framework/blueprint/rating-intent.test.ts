import { describe, expect, it } from 'vitest'
import { validateBlueprint, type BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'
import { analyzeBlueprintIncremental } from '../../../src/pe-framework/blueprint/analyzer.js'
import { textStream, stubCtx } from '../../plugin/helpers.js'

describe('blueprint rating (spec §5.1)', () => {
  it('accepts core.rating enum; rejects bad enum', () => {
    const base = { schema_version: 1, media: 'image', core: { concept: 'x', negative: [] } }
    expect(validateBlueprint({ ...base, core: { ...base.core, rating: 'explicit' } }).ok).toBe(true)
    expect(validateBlueprint({ ...base, core: { ...base.core, rating: 'r18' } }).ok).toBe(false)
  })
  it('missing rating stays valid (defaults safe downstream)', () => {
    expect(validateBlueprint({ schema_version: 1, media: 'image', core: { concept: 'x', negative: [] } }).ok).toBe(true)
  })
})

describe('analyzeBlueprintIncremental (spec §8)', () => {
  const oldBp: BlueprintV1 = {
    schema_version: 1,
    media: 'image',
    core: { concept: '黄昏海边的少女', negative: [] },
    media_layer: { image: { lighting_detail: 'golden hour' } },
  }
  const newBpJson = JSON.stringify({
    schema_version: 1,
    media: 'image',
    core: { concept: '黄昏海边的少女，回眸', negative: [] },
    media_layer: { image: { lighting_detail: 'golden hour' } },
  })

  it('persona anchors old blueprint with <old_blueprint> block; validated mock output passes through', async () => {
    const stb = stubCtx({ stream: textStream(newBpJson) })
    const out = await analyzeBlueprintIncremental(stb as any, { provider: 'p', model: 'm' }, oldBp, '让她回眸一笑')
    // ① persona 文本含 <old_blueprint> 与旧蓝图 concept 字符串
    const system = stb.llm.calls[0]?.system ?? ''
    expect(system).toContain('【增量锚定】')
    expect(system).toContain('<old_blueprint>')
    expect(system).toContain('黄昏海边的少女')
    // user 段携带本轮修改意图
    const user = JSON.stringify(stb.llm.calls[0]?.messages?.[0]?.content ?? '')
    expect(user).toContain('让她回眸一笑')
    // ② mock 返回的新蓝图经 validateBlueprint 后原样返回
    expect(validateBlueprint(out).ok).toBe(true)
    expect(out.core.concept).toBe('黄昏海边的少女，回眸')
    // ③ 透传：LLM 输出经校验后不增删改字段（最小 diff 由 persona 契约约束）
    expect(out.media_layer.image?.lighting_detail).toBe('golden hour')
  })

  it('invalid LLM blueprint output throws (fail-fast, no silent fallback)', async () => {
    const stb = stubCtx({ stream: textStream('{"schema_version":1,"core":{"concept":"x"}}') })
    await expect(
      analyzeBlueprintIncremental(stb as any, { provider: 'p', model: 'm' }, oldBp, '任意修改'),
    ).rejects.toThrow(/蓝图校验失败/)
  })
})
