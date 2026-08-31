import { describe, expect, it } from 'vitest'
import { registerMinimaxTool } from '../../src/tools/minimax-scenario.js'
import { stubCtx, textStream, runTool } from './helpers.js'

const cfg = { temperature: 0.7 }
const def = (ctx: any) => registerMinimaxTool(ctx, cfg)

describe('minimax_scenario', () => {
  it('lists scenarios without calling llm', async () => {
    const ctx = stubCtx()
    const v = JSON.parse(String(await runTool(ctx, def(ctx), {})))
    expect(v.scenarios.length).toBeGreaterThan(0)
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('unknown scenario errors', async () => {
    const ctx = stubCtx()
    await expect(runTool(ctx, def(ctx), { scenario_id: 'nope' })).rejects.toThrow(/Scenario not found/)
  })

  it('dry_run returns assembled/budget without calling llm', async () => {
    const ctx = stubCtx()
    const v = JSON.parse(String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', dry_run: true })))
    expect(v.budget.text_tokens).toBeGreaterThan(0)
    expect(v.dry_run).toBe(true)
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('non-dry-run returns prompt + sections + budget with usage-derived tokens', async () => {
    const ctx = stubCtx({ stream: textStream('rendered prompt') })
    const v = JSON.parse(String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })))
    expect(typeof v.prompt).toBe('string')
    expect(String(v.prompt).length).toBeGreaterThan(0)
    expect(typeof v.sections).toBe('object') // 分节为键值对象（非数组）
    expect(v.budget).toBeTruthy()
    expect(ctx.llm.calls.length).toBe(1)
  })
})