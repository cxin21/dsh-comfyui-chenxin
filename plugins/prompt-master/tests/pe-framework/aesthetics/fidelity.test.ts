import { describe, expect, it } from 'vitest'
import { checkFidelity } from '../../../src/pe-framework/aesthetics/check.js'

describe('checkFidelity (保真守卫)', () => {
  it('passes when user entities survive into blueprint', () => {
    const r = checkFidelity('银发剑客在黄昏荒原决斗', { schema_version: 1, media: 'video', core: { concept: '银发剑客黄昏荒原决斗', negative: [] } } as any)
    expect(r.pass).toBe(true)
  })
  it('flags when a user entity is dropped', () => {
    const r = checkFidelity('银发剑客在黄昏荒原决斗', { schema_version: 1, media: 'video', core: { concept: '两个武士打斗', negative: [] } } as any)
    expect(r.pass).toBe(false)
    expect(r.missingEntities.join()).toContain('银发剑客')
  })
})
