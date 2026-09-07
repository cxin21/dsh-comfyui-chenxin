import { describe, expect, it } from 'vitest'
import { judgeBlueprint } from '../../../src/pe-framework/eval/judge.js'
import { textStream, stubCtx, errorStream } from '../../plugin/helpers.js'

const v1 = {
  schema_version: 1,
  media: 'video',
  core: {
    concept: '黄昏荒原上的剑客',
    style: { base: '写实电影', palette: '青橙色彩分级' },
    scene: { environment: '荒原', lighting: '黄金时刻' },
    negative: [],
  },
  media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } },
} as any

const intent = '剑客决斗'

describe('judgeBlueprint (LLM 评委, spec §13)', () => {
  it('scores the blueprint by rubric (coherence/fidelity/aesthetic) + overall + issues', async () => {
    const payload = '{"scores":{"coherence":7,"fidelity":8,"aesthetic":9},"overall":8,"issues":["镜头情绪衔接可再强化"]}'
    const stb = stubCtx({ stream: textStream(payload) })
    const out = await judgeBlueprint(stb as any, { provider: 'p', model: 'm' }, v1, intent)
    expect(out.scores.coherence).toBe(7)
    expect(out.scores.fidelity).toBe(8)
    expect(out.scores.aesthetic).toBe(9)
    expect(out.overall).toBe(8)
    expect(Array.isArray(out.issues)).toBe(true)
    expect(out.issues).toContain('镜头情绪衔接可再强化')
  })

  it('passes the blueprint and original intent into the LLM call', async () => {
    const payload = '{"scores":{"coherence":5,"fidelity":5,"aesthetic":5},"overall":5,"issues":[]}'
    const stb = stubCtx({ stream: textStream(payload) })
    await judgeBlueprint(stb as any, { provider: 'p', model: 'm' }, v1, intent)
    const system = stb.llm.calls[0]?.system ?? ''
    const user = stb.llm.calls[0]?.messages?.[0]?.content ?? ''
    expect(system).toContain('coherence')
    expect(system).toContain('fidelity')
    expect(system).toContain('aesthetic')
    expect(JSON.stringify(user)).toContain('黄昏荒原上的剑客')
    expect(JSON.stringify(user)).toContain(intent)
  })

  it('is an optional path: returns zero scores + advisory on LLM error, does not throw', async () => {
    const stb = stubCtx({ stream: errorStream('boom', 'E_TEST') })
    const out = await judgeBlueprint(stb as any, { provider: 'p', model: 'm' }, v1, intent)
    expect(out.scores).toEqual({ coherence: 0, fidelity: 0, aesthetic: 0 })
    expect(out.overall).toBe(0)
    expect(out.issues.some((i) => i.startsWith('judge_failed:'))).toBe(true)
  })

  it('is an optional path: returns zero scores + advisory on unparseable output, does not throw', async () => {
    const stb = stubCtx({ stream: textStream('not json at all') })
    const out = await judgeBlueprint(stb as any, { provider: 'p', model: 'm' }, v1, intent)
    expect(out.scores).toEqual({ coherence: 0, fidelity: 0, aesthetic: 0 })
    expect(out.overall).toBe(0)
    expect(out.issues.some((i) => i.startsWith('judge_failed:'))).toBe(true)
  })

  it('clamps out-of-range scores into [0, 10]', async () => {
    const payload = '{"scores":{"coherence":-3,"fidelity":99,"aesthetic":6.6},"overall":-1,"issues":[]}'
    const stb = stubCtx({ stream: textStream(payload) })
    const out = await judgeBlueprint(stb as any, { provider: 'p', model: 'm' }, v1, intent)
    expect(out.scores.coherence).toBe(0)
    expect(out.scores.fidelity).toBe(10)
    expect(out.scores.aesthetic).toBe(7)
    expect(out.overall).toBe(0)
  })
})
