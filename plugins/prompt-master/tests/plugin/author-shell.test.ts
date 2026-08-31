import { describe, expect, it } from 'vitest'
import { registerAuthorTool, isDialectReady } from '../../src/tools/prompt-author.js'
import { stubCtx, runTool } from './helpers.js'

const cfg = { temperature: 0.7 }

describe('prompt_author shell', () => {
  it('rejects unknown target', async () => {
    const def = registerAuthorTool(stubCtx() as any, cfg)
    await expect(runTool(stubCtx(), def, { input: 'x', target: 'flux' })).rejects.toThrow(/Unknown target/)
  })

  it('reports DIALECT_NOT_AVAILABLE for un-ported dialects (sd) with critical gate', async () => {
    const ctx = stubCtx()
    const v = JSON.parse(String(await runTool(ctx, registerAuthorTool(ctx as any, cfg), { input: 'x', target: 'sd' })))
    expect(v.ok).toBe(false)
    expect(v.audit.passed).toBe(false)
    expect(v.audit.gates[0].rule).toBe('dialect_not_available')
    expect(v.audit.gates[0].severity).toBe('critical')
  })

  it('readiness: anima/h3 ready, sd/generic pending (T13 state machine)', () => {
    expect(isDialectReady('anima')).toBe(true)
    expect(isDialectReady('h3')).toBe(true)
    expect(isDialectReady('sd')).toBe(false)
    expect(isDialectReady('generic')).toBe(false)
  })
})