import { describe, expect, it } from 'vitest'
import { buildAuditReport, isFatal, serializeReport } from '../../src/pe-framework/audit/index.js'

describe('audit report', () => {
  it('passed=true when no critical gates', () => {
    const r = buildAuditReport({ gates: [{ rule: 'x', target: 'h3', severity: 'minor', detail: '' }] })
    expect(r.passed).toBe(true)
  })
  it('passed=false when critical gate present', () => {
    const r = buildAuditReport({ gates: [{ rule: 'cut_timestamps', target: 'h3', severity: 'critical', detail: 'Shot 2 earlier than Shot 1' }] })
    expect(r.passed).toBe(false)
  })
  it('empty inputs default to empty arrays and undefined budget', () => {
    const r = buildAuditReport({})
    expect(r.gates).toEqual([])
    expect(r.assumptions).toEqual([])
    expect(r.advisories).toEqual([])
    expect(r.budget).toBeUndefined()
  })
  it('serialize is stable JSON', () => {
    const r = buildAuditReport({ gates: [] })
    expect(JSON.parse(serializeReport(r))).toEqual(r)
  })
  it('isFatal only flags critical', () => {
    expect(isFatal({ rule: 'a', target: 'anima', severity: 'critical', detail: '' })).toBe(true)
    expect(isFatal({ rule: 'b', target: 'anima', severity: 'important', detail: '' })).toBe(false)
  })
})