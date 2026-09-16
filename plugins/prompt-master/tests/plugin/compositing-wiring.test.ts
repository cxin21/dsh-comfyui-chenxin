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

afterEach(() => { setAuthorIntentProvider(null); setAuthorEnrichProvider(null) })

describe('compositing 接线（2026-09-16 定稿：anima 唯一路径，无双态/无 env）', () => {
  it('no subagents → writer fallback fail-open, envelope carries compositing observability', async () => {
    setAuthorIntentProvider(async () => ({ semantic: JSON.parse(SEMANTIC_JSON) as never, missing: [] }) as never)
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as never, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'off' })))
    expect(v.ok).toBe(true)
    expect(String(v.result.positive)).toContain('rating_')
    expect(v.observability.compositing).toMatchObject({ form: 'semantic', fallback_used: true })
    expect(v.advisories).toContain('writer_fallback_used')
    expect(v.advisories.some((a: string) => a.startsWith('pipeline_form_override'))).toBe(false)
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
    // 缺陷②回归锁：runEnrich（legacy brief 扩写）对 anima 零调用（spec §4 D2）
    expect(enrichCalls).toBe(0)
  })
  it('anima blueprint_id → 显式报错（semantic 增量 = T1R 项，不做静默旧路径）', async () => {
    setAuthorIntentProvider(async () => ({}) as never)
    const ctx = stubCtx()
    const def = registerAuthorTool(ctx as never, { temperature: 0.7 })
    await expect(runTool(ctx, def, { target: 'anima', input: 'x', blueprint_id: 'gen_x', judge_mode: 'off' })).rejects.toThrow(/blueprint_id 增量路径未接入 compositing/)
  })
})
