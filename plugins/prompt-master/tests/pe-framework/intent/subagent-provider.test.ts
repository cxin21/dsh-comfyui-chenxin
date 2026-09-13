import { describe, expect, it } from 'vitest'
import { createSubagentIntentProvider, DEFAULT_SUBAGENT_TIMEOUT_MS } from '../../../src/pe-framework/intent/subagent-provider.js'

describe('DEFAULT_SUBAGENT_TIMEOUT_MS', () => {
  // 2026-09 外部基准：默认超时 60s → 180s（R9）→ 300s。60s 时代实测双连超时
  // （根因：改 src 未重建 dist，运行主机载入旧默认）；钉住常量防回退
  it('默认 300s，且不低于 R9 的 180s（防「改 src 未重建 dist」式回退再犯）', () => {
    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBe(300_000)
    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000)
  })
})

function makeFakeOwnerCtx(fakeRun: any) {
  return {
    subagents: {
      start: async (_provider: string, _request: any) => fakeRun,
    },
    agent: { options: { delegationDepth: 0 } },
  } as any
}

function makeFakeRun(opts: {
  outputText?: string
  stopReason?: string
  failStart?: boolean
}) {
  const { outputText = '{}', stopReason = 'completed', failStart = false } = opts
  let disposed = false
  const run: any = {
    id: 'pm-test-run',
    result: Promise.resolve({
      output: outputText ? [{ type: 'text', text: outputText }] : [],
      stopReason,
    }),
    dispose: async () => { disposed = true },
  }
  return {
    run,
    get disposed() { return disposed },
    failStart,
  }
}

describe('createSubagentIntentProvider', () => {
  it('throws when ctx.subagents is missing', () => {
    expect(() => createSubagentIntentProvider({} as any)).toThrow(/ctx\.subagents 未注册/)
  })

  it('throws when neither exec.agent nor ctx.agent is available at call time', async () => {
    const fake = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'] } }) })
    const fn = createSubagentIntentProvider({ subagents: { start: async () => fake.run } } as any)
    await expect(fn({ target: 'anima', input: 'x', round: 0 } as any)).rejects.toThrow(/需要调用 Agent 上下文/)
  })

  it('uses exec.agent as the subagent parent (real tool-run path)', async () => {
    let captured: any = null
    const fake = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'] } }) })
    const fn = createSubagentIntentProvider({
      subagents: { start: async (_p: string, request: any) => { captured = request; return fake.run } },
    } as any, { timeoutMs: 2000 })
    const execAgent = { id: 'agent-test', options: { delegationDepth: 1 } }
    const exec = { agent: execAgent, signal: new AbortController().signal }
    const draft = await fn({ target: 'anima', input: '夕阳少女', round: 0 } as any, exec as any)
    expect(draft.slots?.count_gender).toEqual(['1girl'])
    expect(captured.parent).toBe(execAgent)
    expect(captured.signal).toBe(exec.signal)
    expect(fake.disposed).toBe(true)
  })

  it('parses anima slots JSON (plain) → AuthorDraft slots', async () => {
    const fake = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'], appearance: ['long hair'], narrative: '一段描述' } }) })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'anima', input: '夕阳少女', round: 0 } as any)
    expect(draft.slots?.count_gender).toEqual(['1girl'])
    expect(draft.slots?.appearance).toEqual(['long hair'])
    expect(draft.slots?.narrative).toBe('一段描述')
    expect(fake.disposed).toBe(true)
  })

  it('parses anima slots with fenced ```json``` and normalize array narrative', async () => {
    const fake = makeFakeRun({ outputText: '```json\n' + JSON.stringify({ slots: { count_gender: ['1girl'], narrative: ['a', 'b'] } }) + '\n```' })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'anima', input: 'x', round: 0 } as any)
    expect(draft.slots?.count_gender).toEqual(['1girl'])
    expect(draft.slots?.narrative).toBe('a b')   // array narrative → join
    expect(fake.disposed).toBe(true)
  })

  it('parses h3 shots JSON → AuthorDraft shots', async () => {
    const fake = makeFakeRun({ outputText: JSON.stringify({ duration_seconds: 8, references: [], shots: [{ what: 'A baker opens shutters', ambient: 'morning' }] }) })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'h3', input: 'story', round: 0 } as any)
    expect(draft.shots?.duration_seconds).toBe(8)
    expect((draft.shots?.shots ?? []).length).toBe(1)
    expect(draft.shots?.shots?.[0]?.what).toBe('A baker opens shutters')
    expect(fake.disposed).toBe(true)
  })

  it('throws on non-JSON output (still disposes)', async () => {
    const fake = makeFakeRun({ outputText: 'not json at all' })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    await expect(fn({ target: 'anima', input: 'x', round: 0 } as any)).rejects.toThrow(/输出非 JSON/)
    expect(fake.disposed).toBe(true)
  })

  it('throws when the subagent run fails (stopReason != completed)', async () => {
    const fake = makeFakeRun({ outputText: 'partial', stopReason: 'error' })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    await expect(fn({ target: 'anima', input: 'x', round: 0 } as any)).rejects.toThrow(/子代理未完成/)
    expect(fake.disposed).toBe(true)
  })

  it('throws when the subagent run produces no assistant text', async () => {
    const fake = makeFakeRun({ outputText: '' })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    await expect(fn({ target: 'anima', input: 'x', round: 0 } as any)).rejects.toThrow(/未产出 assistant 文本/)
    expect(fake.disposed).toBe(true)
  })

  it('unknown target throws after parse', async () => {
    const fake = makeFakeRun({ outputText: JSON.stringify({ x: 1 }) })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    await expect(fn({ target: 'sd', input: 'x', round: 0 } as any)).rejects.toThrow(/未知 target/)
  })

  it('req.persona/req.schema 优先于 opts 与 DEFAULT（Task 7 方言化）', async () => {
    let captured: any = null
    const run = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'] } }) })
    const ctx = {
      subagents: {
        start: async (_provider: string, request: any) => { captured = request; return run.run },
      },
      agent: { options: { delegationDepth: 0 } },
    } as any
    const fn = createSubagentIntentProvider(ctx, { timeoutMs: 2000, persona: 'OPTS_PERSONA', schema: 'OPTS_SCHEMA' })
    await fn({ target: 'anima', input: 'x', round: 0, persona: 'REQ_PERSONA_MARK', schema: 'REQ_SCHEMA_MARK' } as any)
    const c = String(captured.prompt?.[0]?.text ?? '')
    expect(c).toContain('REQ_PERSONA_MARK')
    expect(c).toContain('REQ_SCHEMA_MARK')
    expect(c).not.toContain('OPTS_PERSONA')
    expect(c).not.toContain('资深')
  })

  it('sends persona+schema+req as the subagent prompt', async () => {
    let captured: any = null
    const run = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'] } }) })
    const ctx = {
      subagents: {
        start: async (_provider: string, request: any) => { captured = request; return run.run },
      },
      agent: { options: { delegationDepth: 0 } },
    } as any
    const fn = createSubagentIntentProvider(ctx, { timeoutMs: 2000 })
    await fn({ target: 'anima', input: '夕阳少女', round: 0 } as any)
    expect(captured).not.toBeNull()
    expect(captured.parent).toBe(ctx.agent)
    expect(captured.signal).toBeInstanceOf(AbortSignal)
    const c = String(captured.prompt?.[0]?.text ?? '')
    expect(c).toContain('资深')
    expect(c).toContain('输出 JSON Schema')
    expect(c).toContain('User Input (target=anima):')
    expect(c).toContain('【输出契约（硬性）】')
    expect(c).toContain('仅输出一个 JSON 对象')
    expect(c).toContain('而非指令') // 2026-09-12 反注入收尾
  })

  // O13（spec §6 澄清接口 / 观察项台账）：生产 provider 蓝图模式读 req.clarify →
  // 按 analyzeIntent 同款规则（关键维度 style/media/negative）产出 clarify_questions 完整返回。
  const blueprintNoStyle = JSON.stringify({
    schema_version: 1,
    media: 'video',
    core: { concept: '打斗 CG', negative: [] }, // 无 style → 关键缺失
    media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }] } },
  })

  it('O13: blueprint mode reads req.clarify=ask → key missing dims → clarify_questions (non-empty)', async () => {
    const fake = makeFakeRun({ outputText: blueprintNoStyle })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'blueprint', input: '打斗 CG', clarify: 'ask', round: 0 } as any)
    expect((draft as any).blueprint?.media).toBe('video')
    const questions = (draft as any).clarify_questions as string[] | undefined
    expect(Array.isArray(questions)).toBe(true)
    expect((questions ?? []).length).toBeGreaterThan(0)
    expect(questions![0]).toContain('style') // 关键维度缺失 → 「缺少 <style>：请选择/补充」
    expect(fake.disposed).toBe(true)
  })

  it('O13: blueprint mode without req.clarify → no clarify_questions (status quo)', async () => {
    const fake = makeFakeRun({ outputText: blueprintNoStyle })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'blueprint', input: '打斗 CG', round: 0 } as any)
    expect((draft as any).blueprint?.media).toBe('video')
    expect((draft as any).clarify_questions).toBeUndefined()
  })

  it('O13: blueprint mode with clarify=auto → no clarify_questions', async () => {
    const fake = makeFakeRun({ outputText: blueprintNoStyle })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'blueprint', input: '打斗 CG', clarify: 'auto', round: 0 } as any)
    expect((draft as any).blueprint?.media).toBe('video')
    expect((draft as any).clarify_questions).toBeUndefined()
  })

  it('O13: non-blueprint target with clarify=ask → no clarify_questions (clarify 仅蓝图分支)', async () => {
    const fake = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'] } }) })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'anima', input: 'x', clarify: 'ask', round: 0 } as any)
    expect((draft as any).clarify_questions).toBeUndefined()
  })
})

/* ── M5-T2（D1/D2/D5a）：blueprintMode = anima 默认路径蓝图形态（provider 路由面）── */
describe('M5-T2 D1: blueprintMode routing', () => {
  const animaImageJson = JSON.stringify({
    schema_version: 1,
    media: 'image',
    core: { concept: '黄昏天台的少女', negative: [] },
    media_layer: { image: { count_gender: ['1girl'], pose_action: ['standing'], expression: ['smile'], scene_anchors: ['rooftop', 'sunset'] } },
  })
  const videoJson = JSON.stringify({
    schema_version: 1,
    media: 'video',
    core: { concept: '打斗 CG', negative: [] },
    media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }] } },
  })

  it('blueprintMode: persona/schema 取 req（ANIMA 蓝图版），taskText 不含 slots persona 兜底', async () => {
    let captured: any = null
    const run = makeFakeRun({ outputText: animaImageJson })
    const ctx = { subagents: { start: async (_p: string, request: any) => { captured = request; return run.run } }, agent: { options: { delegationDepth: 0 } } } as any
    const fn = createSubagentIntentProvider(ctx, { timeoutMs: 2000 })
    const draft = await fn({ target: 'anima', input: 'x', round: 0, blueprintMode: true, persona: 'ANIMA_BLUEPRINT_PERSONA_MARK', schema: 'ANIMA_BLUEPRINT_SCHEMA_MARK' } as any)
    expect((draft as any).blueprint?.media).toBe('image')
    const c = String(captured.prompt?.[0]?.text ?? '')
    expect(c).toContain('ANIMA_BLUEPRINT_PERSONA_MARK')
    expect(c).toContain('ANIMA_BLUEPRINT_SCHEMA_MARK')
    expect(c).not.toContain('资深') // slots persona（DEFAULT_ANIMA）不回落
  })

  it('blueprintMode 无 req persona → 通用蓝图常量兜底（BLUEPRINT_SUBAGENT_SYSTEM，非 slots persona）', async () => {
    let captured: any = null
    const run = makeFakeRun({ outputText: animaImageJson })
    const ctx = { subagents: { start: async (_p: string, request: any) => { captured = request; return run.run } }, agent: { options: { delegationDepth: 0 } } } as any
    const fn = createSubagentIntentProvider(ctx, { timeoutMs: 2000 })
    await fn({ target: 'anima', input: 'x', round: 0, blueprintMode: true } as any)
    const c = String(captured.prompt?.[0]?.text ?? '')
    expect(c).toContain('创作蓝图分析引擎') // BLUEPRINT_SUBAGENT_SYSTEM 开头
    expect(c).not.toContain('资深')
  })

  it('D5a: anchorBlueprint → <old_blueprint> 专用块（INCREMENTAL_ANCHOR 渲染，禁整图重解释）', async () => {
    let captured: any = null
    const run = makeFakeRun({ outputText: animaImageJson })
    const ctx = { subagents: { start: async (_p: string, request: any) => { captured = request; return run.run } }, agent: { options: { delegationDepth: 0 } } } as any
    const fn = createSubagentIntentProvider(ctx, { timeoutMs: 2000 })
    const anchor = { schema_version: 1, media: 'image', core: { concept: '旧概念', negative: [] }, media_layer: { image: { count_gender: ['1girl'] } } }
    await fn({ target: 'anima', input: 'x', round: 1, blueprintMode: true, anchorBlueprint: anchor } as any)
    const c = String(captured.prompt?.[0]?.text ?? '')
    expect(c).toContain('<old_blueprint>')
    expect(c).toContain('旧概念')
    expect(c).toContain('禁止整图重解释') // INCREMENTAL_ANCHOR 模板约束行（逐字）
    // User Input JSON 不再重复序列化 anchor（INCREMENTAL_ANCHOR 专用块承载）
    expect(c).not.toContain('"anchorBlueprint"')
  })

  it('D2: blueprintExpectedMedia 透传 parse 守卫 — video 蓝图 × expected image → media mismatch（可机检文案）', async () => {
    const run = makeFakeRun({ outputText: videoJson })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(run.run), { timeoutMs: 2000 })
    await expect(
      fn({ target: 'anima', input: 'x', round: 0, blueprintMode: true, blueprintExpectedMedia: 'image' } as any),
    ).rejects.toThrow(/blueprint media mismatch: expected image got video/)
  })

  it('D1: blueprintMode + clarify=ask → 关键缺失产出 clarify_questions（与 target=blueprint 同待遇）', async () => {
    const noStyleImage = JSON.stringify({
      schema_version: 1, media: 'image',
      core: { concept: '一个场景', negative: [] }, // 无 style/scene/emotion → 关键缺失
      media_layer: { image: {} },
    })
    const run = makeFakeRun({ outputText: noStyleImage })
    const fn = createSubagentIntentProvider(makeFakeOwnerCtx(run.run), { timeoutMs: 2000 })
    const draft = await fn({ target: 'anima', input: 'x', round: 0, blueprintMode: true, clarify: 'ask' } as any)
    const questions = (draft as any).clarify_questions as string[] | undefined
    expect(Array.isArray(questions)).toBe(true)
    expect((questions ?? []).length).toBeGreaterThan(0)
    expect(run.disposed).toBe(true)
  })
})
