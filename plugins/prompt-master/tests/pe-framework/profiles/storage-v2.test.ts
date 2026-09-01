import { describe, expect, it } from 'vitest'
import { listProfilesMerged, recastImportedProfile, validateImportPayload } from '../../../src/pe-framework/profiles/storage-v2.js'

const builtins = [
  { id: 'pe_a', name: 'A', kind: 'reverse', sort: 1 },
  { id: 'pe_b', name: 'B', kind: 'expand', sort: 2 },
]
const custom = [{ id: 'pe_custom_x', name: 'X', kind: 'expand', sort: 5 }]

describe('listProfilesMerged', () => {
  it('disabled builtin excluded', () => {
    const r = listProfilesMerged(builtins, custom, { pe_a: { enabled: false } })
    expect(r.map((p) => p.id)).not.toContain('pe_a')
    expect(r.map((p) => p.id)).toContain('pe_b')
  })
  it('override sort re-orders', () => {
    const r = listProfilesMerged(builtins, custom, { pe_b: { enabled: true, sort: 0 } })
    expect(r[0].id).toBe('pe_b')
  })
  it('stale override pointing to nonexistent builtin ignored', () => {
    const r = listProfilesMerged(builtins, [], { pe_ghost: { enabled: false } })
    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b'])
  })
  it('custom profiles merged after builtins (sort ordered)', () => {
    const r = listProfilesMerged(builtins, custom, {})
    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b', 'pe_custom_x'])
  })
})

describe('validateImportPayload', () => {
  it('rejects builtin id collision', () => {
    const r = validateImportPayload({ id: 'pe_a', name: 'X', kind: 'expand', systemPrompt: 's' }, ['pe_a'])
    expect(r.ok).toBe(false)
  })
  it('rejects missing systemPrompt', () => {
    expect(validateImportPayload({ name: 'X', kind: 'expand' }, []).ok).toBe(false)
  })
  it('rejects bad kind', () => {
    expect(validateImportPayload({ name: 'X', kind: 'bogus', systemPrompt: 's' }, []).ok).toBe(false)
  })
  it('accepts valid single profile', () => {
    const r = validateImportPayload({ name: 'X', kind: 'expand', systemPrompt: 's' }, [])
    expect(r.ok).toBe(true)
  })
})

describe('recastImportedProfile', () => {
  it('recasts id to pe_custom_+uuid and resets timestamps', () => {
    const out = recastImportedProfile({ id: 'pe_old', name: 'X', kind: 'expand', systemPrompt: 's', createdAt: 1, updatedAt: 1 })
    expect(out.id).toMatch(/^pe_custom_/)
    expect(out.id).not.toBe('pe_old')
    expect(out.createdAt).not.toBe(1)
  })
})
