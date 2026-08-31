import { describe, expect, it } from 'vitest'
import { createSubagentIntentProvider } from '../../../src/pe-framework/intent/subagent-provider.js'

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
    expect(c).toContain('仅输出 JSON')
  })
})
