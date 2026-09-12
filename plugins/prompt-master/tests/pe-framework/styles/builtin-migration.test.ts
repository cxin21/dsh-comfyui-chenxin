import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { MINIMAL_STYLES } from '../../../src/pe-framework/enrichment/style.js'
import { validateStylePreset } from '../../../src/pe-framework/styles/schema.js'

const dir = resolve(fileURLToPath(import.meta.url), '../../../../assets/style-presets')

describe('builtin migration (spec §4.4/§10)', () => {
  const byId = new Map(MINIMAL_STYLES.map((s) => [s.id, s]))
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('nb'))

  it('has one JSON per builtin style', () => {
    expect(files.length).toBe(MINIMAL_STYLES.length)
    for (const f of files) expect(byId.has(f.replace('.json', '')), f).toBe(true)
  })

  it('each builtin JSON validates and matches its TS source 1:1', () => {
    for (const f of files) {
      const raw = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      const r = validateStylePreset(raw)
      expect(r.ok, `${f}: ${r.ok ? '' : r.errors.join(';')}`).toBe(true)
      if (!r.ok) continue
      const src = byId.get(raw.id)!
      expect(raw.name).toBe(src.name)
      expect(raw.base ?? undefined).toBe(src.base ?? undefined)
      expect(raw.theme ?? undefined).toBe(src.theme ?? undefined)
      expect(raw.palette ?? undefined).toBe(src.palette ?? undefined)
      expect(raw.fragments.image).toBe(src.prompt_fragments.image)
      expect(raw.fragments.video).toBe(src.prompt_fragments.video)
      expect(raw.negative_hints).toEqual(src.negative_hints)
      expect(raw.artist_hints).toEqual(src.artistHints)
      expect(raw.rating).toBe('safe')
      expect(raw.applies_to).toEqual(src.applies_to)
      expect(raw.source).toBe('builtin-migrated')
      expect(raw.artist_max).toBe(3)
    }
  })
})
