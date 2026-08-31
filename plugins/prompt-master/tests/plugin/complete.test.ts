import { describe, expect, it } from 'vitest'
import { complete } from '../../src/llm/complete.js'
import { resolveRoute } from '../../src/llm/route.js'
import { stubCtx, textStream, errorStream, abortedStream } from './helpers.js'

const opts = {
  provider: 'deepseek', model: 'deepseek-chat',
  system: 'SYS', user: 'USR', maxTokens: 512,
  signal: new AbortController().signal,
}

describe('complete', () => {
  it('assembles text and usage; passes system/user/maxTokens', async () => {
    const ctx = stubCtx({ stream: textStream('answer', { inputTokens: 10, outputTokens: 5 }) })
    const r = await complete(ctx as any, opts)
    expect(r.text).toBe('answer')
    expect(r.usage?.outputTokens).toBe(5)
    expect(ctx.llm.calls.length).toBe(1)
    const call = ctx.llm.calls[0]
    expect(call.provider).toBe('deepseek')
    expect(call.system).toBe('SYS')
    expect(call.maxTokens).toBe(512)
    expect(call.messages[0].source).toMatchObject({ kind: 'plugin', plugin: 'prompt-master' })
  })

  it('throws with code on error finish', async () => {
    const ctx = stubCtx({ stream: errorStream('boom', 'RATE_LIMIT') })
    await expect(complete(ctx as any, opts)).rejects.toMatchObject({ message: 'boom', code: 'RATE_LIMIT' })
  })

  it('throws on aborted finish', async () => {
    const ctx = stubCtx({ stream: abortedStream('cancelled') })
    await expect(complete(ctx as any, opts)).rejects.toMatchObject({ message: 'cancelled' })
  })
})

describe('resolveRoute (R1 三环：会话 route → agent options → 可操作错误)', () => {
  it('uses session route when present (优先于 options)', () => {
    const exec = {
      signal: new AbortController().signal,
      agent: {
        options: { provider: 'p', model: 'm' },
        session: { requestHeader: () => ({ config: { provider: 'rp', model: 'rm' } }) },
      },
    }
    expect(resolveRoute(exec)).toEqual({ provider: 'rp', model: 'rm' })
  })

  it('uses agent options when no session route', () => {
    const exec = {
      signal: new AbortController().signal,
      agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => undefined } },
    }
    expect(resolveRoute(exec)).toEqual({ provider: 'p', model: 'm' })
  })

  it('throws actionable error when both rings are empty (no hardcoded default)', () => {
    const exec = { signal: new AbortController().signal, agent: { options: {}, session: { requestHeader: () => undefined } } }
    expect(() => resolveRoute(exec)).toThrow(/请先在当前会话选择/)
    expect(() => resolveRoute({ signal: new AbortController().signal } as never)).toThrow(/请先在当前会话选择/)
  })
})