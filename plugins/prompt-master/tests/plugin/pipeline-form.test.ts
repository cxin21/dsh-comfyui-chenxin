import { describe, expect, it, afterEach } from 'vitest'
import { registerAuthorTool, setAuthorIntentProvider, setAuthorEnrichProvider } from '../../src/tools/prompt-author.js'
import { stubCtx, runTool, textStream } from './helpers.js'

const SEMANTIC_JSON = JSON.stringify({
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'lantern light along the corridor' },
    style_hints: [],
  },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal',
  negative_hints: [],
})

afterEach(() => { delete process.env.PM_PIPELINE_FORM; setAuthorIntentProvider(null); setAuthorEnrichProvider(null) })

describe('PM_PIPELINE_FORM switch (spec §9 D8)', () => {
  it('compositing form: no subagents → writer fallback fail-open, envelope carries compositing observability', async () => {
    process.env.PM_PIPELINE_FORM = 'compositing'
    setAuthorIntentProvider(async () => ({ semantic: JSON.parse(SEMANTIC_JSON) as never, missing: [] }) as never)
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })))
    expect(v.ok).toBe(true)
    expect(String(v.result.positive)).toContain('rating_')
    expect(v.observability.compositing).toMatchObject({ form: 'semantic', fallback_used: true })
    expect(v.advisories).toContain('writer_fallback_used')
    expect(v.advisories).toContain('pipeline_form_override:compositing')
  })
  it('invalid form value → fail-fast with the value named', async () => {
    process.env.PM_PIPELINE_FORM = 'bogus'
    setAuthorIntentProvider(async () => ({}) as never)
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, { temperature: 0.7 })
    await expect(runTool(ctx, def, { target: 'anima', input: 'x', judge_mode: 'off' })).rejects.toThrow(/PM_PIPELINE_FORM 非法值: bogus/)
  })
  it('legacy form (env 显式 legacy): blueprint path still wired', async () => {
    process.env.PM_PIPELINE_FORM = 'legacy'
    setAuthorIntentProvider(async () => ({
      blueprint: {
        schema_version: 1, media: 'video',
        core: { concept: '三镜头打斗CG', negative: [] },
        media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
      } as never, missing: [],
    }) as never)
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', input: '三镜头打斗CG', judge_mode: 'off' })))
    expect(v.ok).toBe(true)
    expect(v.observability.compositing).toBeUndefined()
  })
  it('default (no env) → compositing（T13 缺省翻转）', async () => {
    setAuthorIntentProvider(async () => ({ semantic: JSON.parse(SEMANTIC_JSON) as never, missing: [] }) as never)
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })))
    expect(v.ok).toBe(true)
    expect(v.observability.compositing).toMatchObject({ form: 'semantic' })
    expect(v.advisories.some((a: string) => a.startsWith('pipeline_form_override'))).toBe(false) // 未显式设置 → 无 override advisory
  })
  it('compositing 接线回归锁（真实会话冒烟双缺陷）：provider 收到 compositingMode 且**无 persona/schema 踩踏**；legacy runEnrich 零调用', async () => {
    const seen: Array<Record<string, unknown>> = []
    setAuthorIntentProvider((async (req: unknown) => { seen.push(req as Record<string, unknown>); return { semantic: JSON.parse(SEMANTIC_JSON) as never, missing: [] } }) as never)
    let enrichCalls = 0
    setAuthorEnrichProvider((async () => { enrichCalls++; return '{}' }) as never)
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, { temperature: 0.7 })
    await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })
    expect(seen.length).toBe(1)
    expect(seen[0].compositingMode).toBe(true)
    // 缺陷①回归锁：persona/schema 键必须缺省——provider 内部落 ANIMA_SEMANTIC_* 常量，
    // registry slots persona（ANIMA_PERSONA）不得踩踏（真实会话实证 schema_version 校验失败根因）
    expect('persona' in seen[0]).toBe(false)
    expect('schema' in seen[0]).toBe(false)
    expect(seen[0].blueprintMode).toBeUndefined()
    // 缺陷②回归锁：runEnrich（legacy brief 扩写）在 compositing 态零调用（spec §4 D2）
    expect(enrichCalls).toBe(0)
  })
})
