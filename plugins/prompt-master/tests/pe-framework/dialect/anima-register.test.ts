import { describe, expect, it, beforeEach } from 'vitest'
import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
import { registerAnimaDialect, validateAnimaSlots } from '../../../src/pe-framework/dialect/anima.js'

describe('Anima dialect registration', () => {
  beforeEach(() => { __resetDialectsForTests(); registerAnimaDialect() })

  it('registers anima with targetSlotHint t2i.prompt', () => {
    expect(getDialect('anima')?.targetSlotHint).toBe('t2i.prompt')
  })

  it('validateAnimaSlots rejects unknown key', () => {
    expect(validateAnimaSlots({ bogus_key: ['x'] })).toContain('bogus_key')
  })

  it('validateAnimaSlots rejects non-string-array slot', () => {
    expect(validateAnimaSlots({ appearance: 'long hair' })).toContain('string[]')
  })

  it('validateAnimaSlots accepts valid slots', () => {
    expect(validateAnimaSlots({ count_gender: ['1girl'], narrative: '描述' })).toBeUndefined()
  })

  it('validateAnimaSlots accepts brief extension fields (exclusions/qualityPrefix) — composition.py _coerce_brief contract', () => {
    expect(validateAnimaSlots({ count_gender: ['1girl'], exclusions: ['lowres', 'bad anatomy'], qualityPrefix: true })).toBeUndefined()
  })

  it('validateAnimaSlots rejects wrong-typed exclusions/qualityPrefix', () => {
    expect(validateAnimaSlots({ exclusions: 'lowres' })).toContain('string[]')
    expect(validateAnimaSlots({ qualityPrefix: 'yes' })).toContain('boolean')
  })
})
