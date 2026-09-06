import { describe, expect, it } from 'vitest'
import { createSubagentIntentProvider, BLUEPRINT_SUBAGENT_SYSTEM } from '../../../src/pe-framework/intent/subagent-provider.js'

function makeFakeRun(outputText: string) {
  const run: any = {
    id: 'pm-slim-test',
    result: Promise.resolve({
      output: [{ type: 'text', text: outputText }],
      stopReason: 'completed',
    }),
    dispose: async () => {},
  }
  return run
}

const BLUEPRINT_V0 = JSON.stringify({
  schema_version: 1, media: 'video',
  core: { concept: '三镜头打斗CG', negative: [] },
  media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }] } },
})

describe('BLUEPRINT_SUBAGENT_SYSTEM（spec §14 intent 子代理瘦身）', () => {
  it('最小 system 不含 skill/tool 关键词（去掉技能目录/工具说明噪音）', () => {
    const s = BLUEPRINT_SUBAGENT_SYSTEM.toLowerCase()
    expect(s).not.toContain('skill')
    expect(s).not.toContain('tool')
  })

  it('蓝图请求（target=blueprint）走 BLUEPRINT_SUBAGENT_SYSTEM 并产出 blueprint（captain O12 补充）', async () => {
    let captured: any = null
    const run = makeFakeRun(BLUEPRINT_V0)
    const fn = createSubagentIntentProvider({
      subagents: { start: async (_p: string, request: any) => { captured = request; return run } },
      agent: { options: { delegationDepth: 0 } },
    } as any, { timeoutMs: 2000 })
    const draft = await fn({ target: 'blueprint', input: '三镜头打斗CG', round: 0 } as any)
    const c = String(captured.prompt?.[0]?.text ?? '')
    expect(c).toContain('你是一个创作蓝图分析引擎')
    expect(c).not.toContain('资深') // 不是原 persona
    expect(draft.blueprint?.media).toBe('video')
    expect(draft.blueprint?.media_layer.video?.shots).toHaveLength(1)
    expect(draft.missing).toContain('style') // 复用 analyzer 的缺失计算
  })

  it('旧 slots/shots 请求走原 persona（向后兼容）', async () => {
    let captured: any = null
    const run = makeFakeRun(JSON.stringify({ slots: { count_gender: ['1girl'] } }))
    const fn = createSubagentIntentProvider({
      subagents: { start: async (_p: string, request: any) => { captured = request; return run } },
      agent: { options: { delegationDepth: 0 } },
    } as any, { timeoutMs: 2000 })
    const draft = await fn({ target: 'anima', input: 'x', round: 0 } as any)
    const c = String(captured.prompt?.[0]?.text ?? '')
    expect(c).toContain('资深')
    expect(c).not.toContain('你是一个创作蓝图分析引擎')
    expect(draft.slots?.count_gender).toEqual(['1girl'])
  })
})
