import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { registerAuthorTool, setAuthorIntentProvider } from '../../src/tools/prompt-author.js'
import { stubCtx, runTool, textStream } from '../plugin/helpers.js'
import type { AuthorIntentFn } from '../../src/tools/prompt-author.js'
import fightIntent from './fixtures/fight-cg-intent.json' with { type: 'json' }

let calls = 0
const fakeProvider: AuthorIntentFn = async (req: any) => {
  calls++
  if (req.round === 0) return { blueprint: (fightIntent as any).v0, missing: ['style'] }
  return { blueprint: (fightIntent as any).v0, missing: [] }
}

describe('eval: fight CG case (session-34706f38 regression)', () => {
  beforeEach(() => { calls = 0; setAuthorIntentProvider(fakeProvider as any) })
  afterEach(() => { setAuthorIntentProvider(null) })

  it('completes with no CJK false positive, correct duration, non-manual next_action, ≤3 LLM calls', async () => {
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', input: '3个分镜每个5秒的打斗CG动画', style_id: 'cinematic_real', judge_mode: 'off' })))
    const shotExec = v.audit.gates.filter((g: any) => g.rule === 'shot_execution')
    expect(shotExec.every((g: any) => g.severity !== 'critical')).toBe(true)
    // duration_seconds=15 语义正确：3 shots 通过 max_shots、15 ∈ [4,15]（duration_range/max_shots 均为 critical 契约闸门，
    // ok=true 即证明两者通过——spec §13「3 镜×5 秒 → 传总时长 15」回归）
    expect(v.ok).toBe(true)
    expect(v.next_action).not.toBe('manual')
    expect(calls).toBeLessThanOrEqual(3)
  })
})
