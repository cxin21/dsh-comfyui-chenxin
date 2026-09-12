import { describe, expect, it, afterAll } from 'vitest'
import { compileAnima, auditAnima } from '../../../src/pe-framework/dialect/anima.js'
import { searchCatalog, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'

const realSearch = (t: string) => searchCatalog(t, { limit: 5 })

const slots = (extra: Record<string, unknown>) => ({
  count_gender: ['1girl'], detail_mood: ['white dress'], ...extra,
}) as Parameters<typeof compileAnima>[0]

describe('rating integration (spec §5.3)', () => {
  it('safe: seed "safe", no additions, no legacy safety assumption', () => {
    const r = compileAnima(slots({}), { variant: 'base', search: realSearch })
    expect(r.positive).toContain('safe,')
    expect(r.negative).not.toContain('rating_explicit')
    expect(r.assumptions).not.toContain('safety_seed_injected:default_for_non_explicit_request')
  })
  it('sensitive: rating_sensitive seed + explicit blockers in negative', () => {
    const r = compileAnima(slots({ rating: 'sensitive' }), { variant: 'base', search: realSearch })
    expect(r.positive).toContain('rating_sensitive')
    expect(r.positive).not.toContain(' safe,')
    expect(r.negative).toContain('nude')
    expect(r.assumptions).toContain('rating_active:sensitive')
  })
  it('explicit bool alias maps to explicit tier; qualityPrefix=false still adds negative additions', () => {
    const r = compileAnima(slots({ explicit: true, qualityPrefix: false }), { variant: 'base', search: realSearch })
    expect(r.positive).toContain('rating_explicit')
    expect(r.negative).toContain('loli')
  })
  it('terminal boundary gate fires on compiled corpus', () => {
    const s = slots({ rating: 'explicit', appearance: ['loli'] })
    const r = compileAnima(s, { variant: 'base', search: realSearch })
    expect(r.phase_status.inspection).toBe('ADVISORY')
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', search: realSearch, slots: s })
    expect(gates.some((g) => g.rule === 'minor_content_conflict')).toBe(true)
  })
  afterAll(() => closeCatalog())
})
