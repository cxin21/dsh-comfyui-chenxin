import { describe, expect, it, beforeEach } from 'vitest'
import { registerDialect, getDialect, isDialectReady, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'

const base: DialectContract = {
  id: 'anima', label: 'Anima', auditOnlyOk: true,
  normalize: () => ({ value: {} }), compile: () => ({}), audit: () => ({ gates: [] }),
  targetSlotHint: 't2i.prompt',
}

describe('dialect registry', () => {
  beforeEach(() => { __resetDialectsForTests() })

  it('registers and retrieves a dialect', () => {
    registerDialect(base)
    expect(getDialect('anima')).toBe(base)
    expect(isDialectReady('anima')).toBe(true)
  })

  it('throws on duplicate registration (fail loud)', () => {
    registerDialect(base)
    expect(() => registerDialect({ ...base, label: 'dup' })).toThrow(/already registered/)
  })

  it('returns undefined for unregistered target', () => {
    expect(getDialect('sd')).toBeUndefined()
    expect(isDialectReady('sd')).toBe(false)
  })
})
