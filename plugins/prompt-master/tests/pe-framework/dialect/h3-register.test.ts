import { describe, expect, it, beforeEach } from 'vitest'
import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
import { normalizeH3Input, registerH3Dialect } from '../../../src/pe-framework/dialect/h3.js'

describe('H3 dialect registration', () => {
  beforeEach(() => { __resetDialectsForTests(); registerH3Dialect() })

  it('registers h3 with targetSlotHint t2v.prompt and auditOnlyOk', () => {
    const d = getDialect('h3')
    expect(d?.targetSlotHint).toBe('t2v.prompt')
    expect(d?.auditOnlyOk).toBe(true)
  })

  it('normalizeH3Input infers ref2va when references present', () => {
    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }], references: [{ who: 'x', image: 'p' }] } }, {})
    expect(r.stage).toBe('ref2va')
  })

  it('normalizeH3Input infers t2va when no references', () => {
    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }] } }, {})
    expect(r.stage).toBe('t2va')
  })

  it('normalizeH3Input error on missing shots', () => {
    expect(normalizeH3Input({}, {})?.error).toBeTruthy()
  })
})
