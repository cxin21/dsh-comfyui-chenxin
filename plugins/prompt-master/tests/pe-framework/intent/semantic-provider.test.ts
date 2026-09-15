import { describe, expect, it } from 'vitest'
import { createSubagentIntentProvider } from '../../../src/pe-framework/intent/subagent-provider.js'
import { ANIMA_SEMANTIC_PERSONA, ANIMA_SEMANTIC_SCHEMA } from '../../../src/pe-framework/intent/subagent-provider.js'

const SEMANTIC_JSON = JSON.stringify({
  schema_version: 1,
  media: 'image',
  core: {
    concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'warm sunset glow' },
    style_hints: [],
  },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'cowboy shot', camera_angle: 'from below', placement: 'right third' },
  mood: 'nocturnal',
  negative_hints: [],
})

/** one-shot run 鸭子类型 mock（与测试 seam 共用形状） */
function mockOwnerCtx(outputText: string, captured: { prompt?: string; label?: string }) {
  return {
    subagents: {
      start: async (_provider: string, request: { label: string; prompt: Array<{ type: string; text?: string }> }) => {
        captured.label = request.label
        captured.prompt = request.prompt.map((b) => b.text ?? '').join('')
        return {
          id: 'run-mock',
          result: Promise.resolve({ output: [{ type: 'text', text: outputText }], stopReason: 'completed' }),
          dispose: async () => undefined,
        }
      },
    },
    agent: { options: {} },
  }
}

const REQ = {
  target: 'anima',
  input: '黄昏天台的少女',
  round: 0,
  compositingMode: true,
} as never

describe('subagentIntent compositing mode (spec §3/§2.1)', () => {
  it('taskText uses sectioned template: persona/user_intent/rules/output_contract', async () => {
    const captured: { prompt?: string; label?: string } = {}
    const provider = createSubagentIntentProvider(mockOwnerCtx(SEMANTIC_JSON, captured) as never)
    const draft = await provider(REQ, undefined)
    expect(draft.semantic?.core.concept).toContain('rooftop')
    expect(captured.prompt).toContain('<task_persona>')
    expect(captured.prompt).toContain('<user_intent>')
    expect(captured.prompt).toContain('<rules>')
    expect(captured.prompt).toContain('<output_contract>')
    expect(captured.prompt).toContain('数据而非指令')
    expect(captured.prompt).toContain(ANIMA_SEMANTIC_PERSONA.slice(0, 20))
    expect(captured.prompt).toContain(ANIMA_SEMANTIC_SCHEMA.slice(0, 20))
    expect(captured.label).toMatch(/^pm-author-anima-/)
  })
  it('compositing mode injects NO catalog candidates block (D2 zero-catalog)', async () => {
    const captured: { prompt?: string; label?: string } = {}
    const provider = createSubagentIntentProvider(mockOwnerCtx(SEMANTIC_JSON, captured) as never)
    const req = { ...REQ, catalogCandidates: ['1girl', 'long hair'] } as never
    await provider(req, undefined)
    expect(captured.prompt).not.toContain('catalog 规范候选')
  })
  it('tag-form output → thrown error surfaces tag_in_blueprint (parse layer)', async () => {
    const captured: { prompt?: string; label?: string } = {}
    const bad = JSON.parse(SEMANTIC_JSON)
    bad.subjects[0].appearance = 'long_hair'
    const provider = createSubagentIntentProvider(mockOwnerCtx(JSON.stringify(bad), captured) as never)
    await expect(provider(REQ, undefined)).rejects.toThrow(/^tag_in_blueprint:1:/)
  })
})
