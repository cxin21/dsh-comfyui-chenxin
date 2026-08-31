import { describe, expect, it } from 'vitest'
import { registerExpandTool } from '../../src/tools/prompt-expand.js'
import { stubCtx, textStream, runTool } from './helpers.js'

const cfg = { temperature: 0.7 }
const expanded = (ctx: any) => registerExpandTool(ctx as never, cfg as never)

describe('prompt_expand', () => {
  it('throws when text is missing', async () => {
    const ctx = stubCtx()
    await expect(runTool(ctx, expanded(ctx), {})).rejects.toThrow('text is required')
  })

  it('dry_run returns assembled system/user without calling llm', async () => {
    const ctx = stubCtx()
    const v = JSON.parse(String(await runTool(ctx, expanded(ctx), { text: 'cat', dry_run: true })))
    expect(v.debug.system).toBeTruthy()
    expect(v.debug.user).toContain('cat')
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('calls llm with resolved route + system/user and returns text', async () => {
    const ctx = stubCtx({ stream: textStream('expanded ok') })
    const v = await runTool(ctx, expanded(ctx), { text: 'cat' })
    expect(ctx.llm.calls.length).toBe(1)
    const call = ctx.llm.calls[0]
    expect(call.provider).toBe('p') // R1: route from agent options (stubExec)
    expect(call.model).toBe('m')
    expect(call.system).toBeTruthy()
    expect(call.maxTokens).toBeGreaterThan(0)
    expect(String(v)).toContain('expanded ok')
  })

  it('passes system prompt with resolved profile', async () => {
    const ctx = stubCtx()
    await runTool(ctx, expanded(ctx), { text: 't' })
    expect(ctx.llm.calls[0].system).toBeTruthy()
  })

  it('rejects unknown profile', async () => {
    const ctx = stubCtx()
    await expect(runTool(ctx, expanded(ctx), { text: 't', profile: 'nope' })).rejects.toThrow(/Profile not found/)
  })
})