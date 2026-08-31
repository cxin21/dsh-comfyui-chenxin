import { describe, expect, it, afterAll } from 'vitest'
import { searchCatalog, classifyTag, overlayView, overlayStatus, OVERLAY_ADVISORY, catalogMeta, closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

describe('anima catalog (anima-catalog.ts)', () => {
  it('canonical: silvery hair exact-match returns canonical hit with prompt_form', () => {
    const hits = searchCatalog('silvery hair')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].match_type).toBe('canonical')
    expect(hits[0].prompt_form).toBe('silvery hair')
  })

  it('alias: wave resolves to canonical waving via alias name type', () => {
    const hits = searchCatalog('wave')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].match_type).toBe('alias')
    expect(hits[0].prompt_form).toBe('waving')
  })

  it('fuzzy: silver hair cascades to fuzzy word-root matches', () => {
    const hits = searchCatalog('silver hair')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].match_type).toBe('fuzzy')
  })

  it('miss: gibberish yields empty results and miss classification', () => {
    expect(searchCatalog('zzzzzzzzq')).toEqual([])
    expect(classifyTag('zzzzzzzzq')).toBe('miss')
  })

  it('classifyTag distinguishes canonical/alias/fuzzy', () => {
    expect(classifyTag('long hair')).toBe('canonical')
    expect(classifyTag('grinning')).toBe('alias')
    expect(classifyTag('expression')).toBe('fuzzy')
  })

  it('limit respected', () => {
    expect(searchCatalog('silver hair', { limit: 1 }).length).toBe(1)
    expect(searchCatalog('silver hair', { limit: 0 })).toEqual([])
  })

  it('unknown mode tolerates as auto', () => {
    const hits = searchCatalog('silvery hair', { mode: 'bogus' as never })
    expect(hits[0].match_type).toBe('canonical')
  })

  it('exact mode skips fuzzy cascade', () => {
    expect(searchCatalog('silver hair', { mode: 'exact' })).toEqual([]) // 无 canonical/alias → 不落 fuzzy
    expect(searchCatalog('silvery hair', { mode: 'exact' })[0].match_type).toBe('canonical')
  })

  it('overlay degrade: absent overlay → empty view + advisory', () => {
    expect(overlayView()).toEqual({ tags: {} })
    expect(overlayStatus()).toBe('unavailable')
    expect(OVERLAY_ADVISORY).toBe('overlay_unavailable')
  })

  it('catalogMeta reports real file, tables and fts presence', () => {
    const meta = catalogMeta()
    expect(meta.sizeBytes).toBeGreaterThan(700 * 1024 * 1024)
    expect(meta.tables).toContain('records')
    expect(meta.tables).toContain('catalog_fts')
    expect(meta.fts).toBe(true)
  })

  afterAll(() => closeCatalog())
})