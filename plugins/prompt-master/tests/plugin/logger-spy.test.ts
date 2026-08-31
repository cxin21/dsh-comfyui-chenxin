import { describe, expect, it, vi } from 'vitest'
import { registerCompileTool } from '../../src/tools/prompt-compile.js'
import { registerExpandTool } from '../../src/tools/prompt-expand.js'
import { stubExec } from './helpers.js'

/** �?logger spy �?ctx stub（复�?helpers stub 模式；logger 用可选链访问，缺失时工具静默跳过�?*/
function spyCtx() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx: any = {
    tools: { register(def: any) { return () => {} } },
    llm: { stream: async function* () {} },
    logger,
    effect() {},
  }
  return { ctx, logger }
}

describe('tool logging (logger spy)', () => {
  it('prompt_compile logs entry + success summaries; never the prompt body', async () => {
    const { ctx, logger } = spyCtx()
    const def = registerCompileTool(ctx)
    const slots = {
      count_gender: ['1girl'],
      appearance: ['SECRET-APPEARANCE-BODY'],
      narrative: 'SECRET-NARRATIVE-BODY',
    }
    await def.execute({ target: 'anima', slots, variant: 'base' }, stubExec() as any)
    expect(logger.info.mock.calls.length).toBeGreaterThanOrEqual(1)
    const all = logger.info.mock.calls.map((c) => String(c[0])).join('\n')
    expect(all).toContain('prompt_compile')
    expect(all).toContain('target=anima')
    expect(all).toMatch(/�?ok=/)
    // 正文不落日志
    expect(all).not.toContain('SECRET-APPEARANCE-BODY')
    expect(all).not.toContain('SECRET-NARRATIVE-BODY')
  })

  it('prompt_compile works without a logger (optional chaining, stub env)', async () => {
    const ctx: any = {
      tools: { register() { return () => {} } },
      llm: { stream: async function* () {} },
    }
    const def = registerCompileTool(ctx)
    const out = await def.execute({ target: 'anima', slots: { count_gender: ['1girl'] }, variant: 'base' }, stubExec() as any)
    expect(String(out)).toContain('"ok"')
  })

  it('prompt_expand dry_run logs entry + success summary without the assembled body', async () => {
    const { ctx, logger } = spyCtx()
    const def = registerExpandTool(ctx, { temperature: 0.7 } as any)
    const out = await def.execute({ text: 'EXPAND-INPUT-MARKER', dry_run: true }, stubExec() as any)
    const all = logger.info.mock.calls.map((c) => String(c[0])).join('\n')
    expect(all).toContain('prompt_expand')
    expect(all).toContain('dry_run=true')
    expect(all).toMatch(/�?ok=true/)
    expect(all).not.toContain('EXPAND-INPUT-MARKER')
    expect(String(out)).toContain('debug')
  })
})
