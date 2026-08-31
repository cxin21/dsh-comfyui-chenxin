import { describe, expect, it, beforeEach } from 'vitest'
import { registerDialect, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'
import { assembleEnvelope } from '../../../src/pe-framework/render/envelope.js'

const fakeDialect: DialectContract = {
  id: 'anima', label: 'Fake', auditOnlyOk: true,
  normalize: () => ({ value: { a: 1 } }),
  compile: (v) => ({ positive: 'p', negative: 'n' }),
  audit: () => ({ gates: [] }),
  targetSlotHint: 't2i.prompt',
}

describe('runStage', () => {
  beforeEach(() => { __resetDialectsForTests() })

  it('dispatches to registered dialect and returns StageResult', () => {
    registerDialect(fakeDialect)
    const r = runStage({ target: 'anima' } as any)
    expect(r.ok).toBe(true)
    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
    expect(r.targetSlotHint).toBe('t2i.prompt')
    expect(r.trace?.stages.length).toBeGreaterThanOrEqual(4)
  })

  it('unregistered target → failed StageResult with dialect_not_available gate (no throw)', () => {
    const r = runStage({ target: 'sd' } as any)
    expect(r.ok).toBe(false)
    expect(r.gates[0].rule).toBe('dialect_not_available')
    expect(r.gates[0].severity).toBe('critical')
    expect(r.gates[0].target).toBe('sd')
    expect(r.targetSlotHint).toBe('generic.prompt')
  })

  it('normalize error → throws readable error', () => {
    registerDialect({ ...fakeDialect, normalize: () => ({ error: 'bad slots: unknown key x' }) })
    expect(() => runStage({ target: 'anima' } as any)).toThrow(/bad slots/)
  })

  it('auditOnly=true omits result body', () => {
    registerDialect(fakeDialect)
    const r = runStage({ target: 'anima', auditOnly: true } as any)
    expect(r.result).toEqual({})
  })

  it('budget present when dialect provides it', () => {
    registerDialect({ ...fakeDialect, budget: () => ({ counter: 'estimate', tokens: 1, max: 10, over: false }) })
    const r = runStage({ target: 'anima' } as any)
    expect(r.budget?.counter).toBe('estimate')
  })

  it('auditOnly throws when dialect.auditOnlyOk is false', () => {
    registerDialect({ ...fakeDialect, auditOnlyOk: false })
    expect(() => runStage({ target: 'anima', auditOnly: true } as any)).toThrow(/auditOnly/)
  })
})

describe('assembleEnvelope', () => {
  it('emits P1 envelope with ok/result/audit/advisories/target_slot_hint', () => {
    const s = JSON.parse(assembleEnvelope(
      { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: ['assumed:1'], targetSlotHint: 't2i.prompt' } as any,
      ['trail'],
    ))
    expect(s.ok).toBe(true)
    expect(s.result).toEqual({ x: 1 })
    expect(s.audit.passed).toBe(true)
    // Task 4 定案：audit 收敛为 {passed, gates, budget?}——assumptions/advisories 不再入 audit 对象
    expect(Object.keys(s.audit).sort()).toEqual(['gates', 'passed'])
    // MF-2：内核计算的 assumptions 必须到达 Envelope（顶层，与 advisories 并列）
    expect(s.assumptions).toEqual(['assumed:1'])
    expect(s.target_slot_hint).toBe('t2i.prompt')
    expect(s.advisories).toEqual(['a', 'trail'])
  })

  it('omits result when ok=false (audit_only semantics)', () => {
    const s = JSON.parse(assembleEnvelope(
      { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
    ))
    expect(s.ok).toBe(false)
    expect(s.result).toBeUndefined()
    expect(s.audit.passed).toBe(false)
  })
})
