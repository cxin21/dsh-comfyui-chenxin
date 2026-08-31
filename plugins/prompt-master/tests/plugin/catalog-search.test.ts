import { describe, expect, it, afterAll } from 'vitest'
import { registerCatalogSearchTool } from '../../src/tools/catalog-search.js'
import { stubCtx, runTool } from './helpers.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const cfg = { temperature: 0.7 }
const def = () => registerCatalogSearchTool(null as never, cfg as never)

describe('catalog_search', () => {
  it('canonical tag returns canonical hit with prompt_form', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silvery hair' })))
    expect(raw.hits[0].match_type).toBe('canonical')
    expect(raw.hits[0].prompt_form).toBe('silvery hair')
  })

  it('alias tag resolves canonical waving', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'wave' })))
    expect(raw.hits[0].match_type).toBe('alias')
    expect(raw.hits[0].prompt_form).toBe('waving')
  })

  it('fuzzy tag cascades without auto-substitution', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair' })))
    expect(raw.hits.length).toBeGreaterThan(0)
    expect(raw.hits[0].match_type).toBe('fuzzy')
  })

  it('miss tag returns empty hits with overlay status', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'zzzzzzzzq' })))
    expect(raw.hits).toEqual([])
    expect(raw.overlay.status).toBe('unavailable')
    expect(raw.overlay.advisory).toBe('overlay_unavailable')
  })

  it('limit respected and clamped to 1..20', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 1 })))
    expect(raw.hits.length).toBe(1)
    const raw2 = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 99 })))
    expect(raw2.hits.length).toBe(5)
  })

  it('unknown mode tolerates as auto', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silvery hair', mode: 'bogus' })))
    expect(raw.hits[0].match_type).toBe('canonical')
  })

  afterAll(() => closeCatalog())
})