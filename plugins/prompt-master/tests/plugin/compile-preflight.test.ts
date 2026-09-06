import { describe, expect, it } from 'vitest'
import { registerCompileTool } from '../../src/tools/prompt-compile.js'
import { stubCtx, runTool } from './helpers.js'

const def = () => registerCompileTool(stubCtx() as any)

describe('prompt_compile preflight_only', () => {
  it('catches max_shots violation without compiling', async () => {
    const v = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'h3', preflight_only: true,
      shots: { duration_seconds: 5, shots: [{ what: 'a' }, { what: 'b' }, { what: 'c' }] },
    })))
    expect(v.ok).toBe(false)
    expect(v.audit.gates.some((g: any) => g.rule === 'max_shots')).toBe(true)
    expect(v.next_action).toBe('retry_input')
  })
  it('passes preflight for valid input with no result body', async () => {
    const v = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'h3', preflight_only: true,
      shots: { duration_seconds: 10, shots: [{ what: 'a' }, { what: 'b' }, { what: 'c' }] },
    })))
    expect(v.ok).toBe(true)
    expect(v.result).toBeUndefined()
  })
  // captain 指派（t3 范围缺口）：normal 编译路径也必须带 next_action，且基于合并后 gates 判定
  it('normal (non-preflight) compile path carries next_action from merged gates', async () => {
    const v = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'h3',
      shots: { duration_seconds: 5, shots: [{ what: 'a' }, { what: 'b' }, { what: 'c' }] },
    })))
    expect(v.ok).toBe(false)
    expect(v.audit.gates.some((g: any) => g.rule === 'max_shots')).toBe(true)
    expect(v.next_action).toBe('retry_input')
  })
})
