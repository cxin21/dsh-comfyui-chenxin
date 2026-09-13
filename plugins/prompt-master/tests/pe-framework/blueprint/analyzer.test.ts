import { describe, expect, it } from 'vitest'
import { analyzeIntent, parseBlueprintJson, ANIMA_BLUEPRINT_PERSONA, ANIMA_BLUEPRINT_SCHEMA } from '../../../src/pe-framework/blueprint/analyzer.js'
import { BLUEPRINT_SUBAGENT_SYSTEM } from '../../../src/pe-framework/intent/subagent-provider.js'
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

/* ── M5-T2（D2/Q3）：ANIMA 蓝图 persona/schema + parseBlueprintJson expectedMedia 守卫 ── */
describe('M5-T2 D2: ANIMA blueprint persona/schema + expectedMedia guard', () => {
  const animaBpJson = JSON.stringify({
    schema_version: 1, media: 'image',
    core: { concept: '黄昏天台的少女', negative: [] },
    media_layer: { image: { count_gender: ['1girl'], pose_action: ['standing'], expression: ['smile'], scene_anchors: ['rooftop', 'sunset'] } },
  })

  it('ANIMA_BLUEPRINT_PERSONA 基座 = BLUEPRINT_SUBAGENT_SYSTEM 逐字前缀（跨模块漂移钉死；两模块不互相 import 防 ESM 环）', () => {
    expect(ANIMA_BLUEPRINT_PERSONA.startsWith(BLUEPRINT_SUBAGENT_SYSTEM)).toBe(true)
  })

  it('ANIMA_BLUEPRINT_SCHEMA 为 image 形态模板（media 固定 image，无 video/shots 面；含 D3 增补四字段）', () => {
    expect(ANIMA_BLUEPRINT_SCHEMA).toContain('"media": "image"')
    expect(ANIMA_BLUEPRINT_SCHEMA.includes('"shots"')).toBe(false)             // 模板不出现 video shots 面
    expect(ANIMA_BLUEPRINT_SCHEMA.includes('"total_duration_seconds"')).toBe(false)
    expect(ANIMA_BLUEPRINT_SCHEMA).toContain('"image"')                        // media_layer.image
    expect(ANIMA_BLUEPRINT_SCHEMA).toContain('count_gender')
    expect(ANIMA_BLUEPRINT_SCHEMA).toContain('pose_action')
    expect(ANIMA_BLUEPRINT_SCHEMA).toContain('expression')
    expect(ANIMA_BLUEPRINT_SCHEMA).toContain('scene_anchors')
    expect(ANIMA_BLUEPRINT_SCHEMA.includes('"rating"')).toBe(false)            // 安全数据确定性注入，schema 不承载
  })

  it('parseBlueprintJson expectedMedia 守卫：video 形蓝图 × expected image → media mismatch（可机检文案）', () => {
    expect(() => parseBlueprintJson(v0Json, { expectedMedia: 'image' })).toThrow(
      /blueprint media mismatch: expected image got video/,
    )
  })

  it('parseBlueprintJson expectedMedia 守卫：image 蓝图 × expected image → 通过（missing 照常计算）', () => {
    const r = parseBlueprintJson(animaBpJson, { expectedMedia: 'image' })
    expect(r.blueprint.media).toBe('image')
    expect(Array.isArray(r.missing)).toBe(true)
  })

  it('parseBlueprintJson expectedMedia 缺省 → 守卫不启用（analyzeBlueprintIncremental 等既有调用方零变化）', () => {
    const r = parseBlueprintJson(v0Json)
    expect(r.blueprint.media).toBe('video')
  })

  it('validateBlueprint 本体零改动回归：image 蓝图（无 video 分支）校验通过', () => {
    // 经 parseBlueprintJson 间接断言（validateBlueprint 由 analyzer 内部调用）
    const r = parseBlueprintJson(animaBpJson)
    expect(r.blueprint.media_layer.image?.count_gender).toEqual(['1girl'])
  })
})
