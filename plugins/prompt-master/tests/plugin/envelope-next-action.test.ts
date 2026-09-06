import { describe, expect, it } from 'vitest'
import { computeNextAction } from '../../src/pe-framework/render/envelope.js'

function stage(ok: boolean, gates: Array<{ rule: string; severity: string }>, advisories: string[]) {
  return { ok, gates, advisories, assumptions: [], result: {}, targetSlotHint: 't2v.prompt' } as any
}

describe('computeNextAction', () => {
  it('ok + no advisories → ok', () => {
    expect(computeNextAction(stage(true, [], []))).toBe('ok')
  })
  it('ok + advisories → advisory_only', () => {
    expect(computeNextAction(stage(true, [], ['joy_extra_filtered']))).toBe('advisory_only')
  })
  it('critical contract gate (max_shots) → retry_input with repair hint', () => {
    const s = stage(false, [{ rule: 'max_shots', severity: 'critical' }], [])
    expect(computeNextAction(s, { repairHints: [{ field: 'duration_seconds', fix: '改为 15（总时长）' }] })).toBe('retry_input')
  })
  it('non-ok but repaired=true → auto_repair', () => {
    const s = stage(false, [{ rule: 'parse_request', severity: 'critical' }], [])
    expect(computeNextAction(s, { repaired: true })).toBe('auto_repair')
  })
  it('loop_exhausted advisory + non-ok → manual', () => {
    const s = stage(false, [{ rule: 'shot_execution', severity: 'important' }], ['loop_exhausted:true'])
    expect(computeNextAction(s)).toBe('manual')
  })
})
