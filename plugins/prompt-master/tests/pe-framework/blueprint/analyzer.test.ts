import { describe, expect, it } from 'vitest'
import { analyzeIntent } from '../../../src/pe-framework/blueprint/analyzer.js'
import { textStream, stubCtx } from '../../plugin/helpers.js'

const v0Json = JSON.stringify({
  schema_version: 1, media: 'video',
  core: { concept: '打斗 CG 动画', negative: [] },
  media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
})

const refs = [{ type: 'image', label: '<Picture 1>', description: '青橙色调的日落荒原参考图' }]

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
  it('multi-modal: with refs, persona instructs reference aesthetic extraction into core fields + ref label stable', async () => {
    const stb = stubCtx({ stream: textStream(v0Json) })
    await analyzeIntent(stb as any, { provider: 'p', model: 'm' }, '三镜头打斗CG', { refs })
    const system = stb.llm.calls[0]?.system ?? ''
    const user = JSON.stringify(stb.llm.calls[0]?.messages?.[0]?.content ?? '')
    // 提取参考物美学特征进蓝图核心字段（LLM 引导，非确定性硬编码）
    expect(system).toContain('提取参考物美学特征')
    expect(system).toContain('scene.lighting')
    expect(system).toContain('core.style.palette')
    // refs 传入 user 消息 + 标签稳定
    expect(user).toContain('references 传入')
    expect(user).toContain('<Picture 1>')
  })
  it('multi-modal: blueprint lands reference aesthetic features + keeps ref tag stable', async () => {
    const withRefsJson = JSON.stringify({
      schema_version: 1, media: 'video',
      core: {
        concept: '打斗 CG 动画',
        scene: { environment: '荒漠', lighting: '参考图 <Picture 1> 的青橙黄昏光', atmosphere: '沙尘弥漫' },
        style: { palette: '参考图 <Picture 1> 的青橙对比' },
        negative: [],
      },
      media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }] } },
    })
    const ctx = { llm: { async *stream() { for (const c of textStream(withRefsJson)) yield c } } } as any
    const r = await analyzeIntent(ctx, { provider: 'p', model: 'm' }, '三镜头打斗CG', { refs })
    expect(r.blueprint.core.scene?.lighting).toContain('青橙')
    expect(r.blueprint.core.style?.palette).toContain('青橙')
    // 蓝图不承载 references 持久字段；<Picture N> 标签稳定保留（§8.1 澄清）
    expect(JSON.stringify(r.blueprint)).toContain('<Picture 1>')
    expect('references' in r.blueprint).toBe(false)
  })
  it('no refs: user message has no references section (Phase 1 unchanged)', async () => {
    const stb = stubCtx({ stream: textStream(v0Json) })
    await analyzeIntent(stb as any, { provider: 'p', model: 'm' }, '三镜头打斗CG')
    const user = JSON.stringify(stb.llm.calls[0]?.messages?.[0]?.content ?? '')
    expect(user).not.toContain('references 传入')
  })
})
