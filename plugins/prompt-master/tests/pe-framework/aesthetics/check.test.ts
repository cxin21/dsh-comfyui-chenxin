import { describe, expect, it } from 'vitest'
import { checkConcreteness } from '../../../src/pe-framework/aesthetics/check.js'

describe('checkConcreteness', () => {
  it('flags empty vague words', () => {
    const r = checkConcreteness({ schema_version: 1, media: 'image', core: { concept: 'beautiful amazing 高级感', negative: [] } } as any)
    expect(r.pass).toBe(false)
    expect(r.issues.length).toBeGreaterThan(0)
  })
  it('passes concrete nouns', () => {
    const r = checkConcreteness({ schema_version: 1, media: 'image', core: { concept: '黄昏荒原上的银发剑客，Panavision 35mm，伦勃朗光', negative: [] } } as any)
    expect(r.pass).toBe(true)
  })
})
