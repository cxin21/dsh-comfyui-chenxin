import { describe, expect, it, beforeEach } from 'vitest'
import { setCustomProfileSource, getCustomProfileSource } from '../../src/resolver/profiles/source.js'
import { getDefaultBuiltinProfiles, clearProfileCache } from '../../src/resolver/profiles/index.js'

beforeEach(() => setCustomProfileSource(null))

describe('custom profile source injection', () => {
  it('defaults to empty list', () => {
    clearProfileCache()
    expect(getDefaultBuiltinProfiles().length).toBeGreaterThan(0)
    expect(getDefaultBuiltinProfiles().filter((p) => p.id === 'my_custom')).toHaveLength(0)
  })

  it('merges injected custom profiles into the builtin registry', () => {
    setCustomProfileSource(() => [{ id: 'my_custom', profileJson: JSON.stringify({ id: 'my_custom', name: 'My', kind: 'expand', builtin: false, category: '自定义', description: 'x', tags: [], subjectDomains: [], enabled: true, outputFormat: 'prose' }) }])
    clearProfileCache()
    const p = getDefaultBuiltinProfiles().find((x) => x.id === 'my_custom')
    expect(p?.name).toBe('My')
  })

  it('tolerates a throwing source (returns [])', () => {
    const broken = getCustomProfileSource()
    expect(broken()).toEqual([])
    setCustomProfileSource(() => { throw new Error('db gone') })
    clearProfileCache()
    expect(getDefaultBuiltinProfiles().length).toBeGreaterThan(0)
  })
})