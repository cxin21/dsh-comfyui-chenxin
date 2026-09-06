import { describe, expect, it } from 'vitest'
import { getDialectPackage } from '../../../src/pe-framework/dialect/package.js'
import '../../../src/pe-framework/dialect/h3.js'
import '../../../src/pe-framework/dialect/anima.js'

describe('dialect package declarations', () => {
  it('h3 declares capabilities from official constants', () => {
    const p = getDialectPackage('h3')!
    expect(p.capabilities.native_negative).toBe(false)
    expect(p.capabilities.duration_range).toEqual([4, 15])
    expect(p.capabilities.max_prompt_chars).toBe(7000)
    expect(p.capabilities.max_shots_formula).toBe('1 + floor((duration - 1) / 3)')
    expect(p.license?.id).toContain('MiniMax-H3')
  })
  it('anima declares native_negative true', () => {
    const p = getDialectPackage('anima')!
    expect(p.capabilities.native_negative).toBe(true)
  })
  it('unknown dialect → undefined', () => {
    expect(getDialectPackage('flux')).toBeUndefined()
  })
})
