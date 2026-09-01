import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
import { setCatalogPath, closeCatalog, queryCatalogInternal } from '../../../src/pe-framework/dialect/anima-catalog.js'
import { browseCatalog, catalogStats } from '../../../src/pe-framework/anima-knowledge/browse.js'
import { verifyCatalog } from '../../../src/pe-framework/anima-knowledge/verify.js'

describe('catalog browse/stats/verify — real catalog (read-only)', () => {
  it('browseCatalog limit=3 → 3 hits with record_id/prompt_form/usage_count', () => {
    const hits = browseCatalog({ limit: 3 })
    expect(hits).toHaveLength(3)
    for (const h of hits) {
      expect(h.match_type).toBe('canonical')
      expect(typeof h.record_id).toBe('string')
      expect(typeof h.prompt_form).toBe('string')
      expect(typeof h.usage_count).toBe('number')
    }
  })

  it('browseCatalog default limit=20', () => {
    expect(browseCatalog()).toHaveLength(20)
  })

  it('browseCatalog category filter → exactly the category rows (cross-checked via SQL)', () => {
    const top = queryCatalogInternal(
      'SELECT category, COUNT(*) AS n FROM records GROUP BY category ORDER BY COUNT(*) DESC LIMIT 1',
    )[0] as { category: string; n: number }
    expect(top.n).toBeGreaterThan(0)
    const hits = browseCatalog({ category: top.category, limit: 500 })
    expect(hits.length).toBe(Math.min(top.n, 500))
  })

  it('browseCatalog source filter → non-empty hits from that source', () => {
    const src = queryCatalogInternal(
      `SELECT s.name FROM sources s JOIN json_each((SELECT source_ids FROM records LIMIT 1)) je ON je.value = s.source_id LIMIT 1`,
    )[0] as { name: string }
    expect(src?.name).toBeTruthy()
    const hits = browseCatalog({ source: src.name, limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(5)
  })

  it('catalogStats → three counts > 0, records at 1M+ scale, ftsRows === names', () => {
    const s = catalogStats()
    expect(s.records).toBeGreaterThan(1_000_000)
    expect(s.names).toBeGreaterThan(1_000_000)
    expect(s.ftsRows).toBe(s.names)
  })

  it('verifyCatalog → ok:true with four passing checks', () => {
    const r = verifyCatalog()
    expect(r.checks.map((c) => c.name)).toEqual(['checksum', 'ftsParity', 'tables', 'schema'])
    expect(r.checks.every((c) => c.ok)).toBe(true)
    expect(r.ok).toBe(true)
  })
})

// ---- tmp 小库失败分支（fixture 模式对齐 tests/pe-framework/resources/manifest.test.ts）----

let tmp: string

function buildFixtureCatalog(dbPath: string, opts: { withFts?: boolean; ftsRows?: number; nameRows?: number }): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE records (record_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, prompt_form TEXT NOT NULL, category TEXT NOT NULL, usage_count INTEGER NOT NULL, source_ids TEXT NOT NULL);
    CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, name_type TEXT NOT NULL);
  `)
  db.prepare("INSERT INTO sources VALUES ('src-1', 'danbooru')").run()
  db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)").run('rec-1', 'smile', 'smile', 'general', 10, '["src-1"]')
  const insName = db.prepare("INSERT INTO names VALUES (?, 'rec-1', ?, ?, 'canonical')")
  insName.run('nm-1', 'smile', 'smile')
  const extra = opts.nameRows ?? 0
  for (let i = 0; i < extra; i++) insName.run(`nm-x${i}`, `name ${i}`, `name ${i}`)
  const nameIds = ['nm-1', ...Array.from({ length: extra }, (_, i) => `nm-x${i}`)]
  if (opts.withFts !== false) {
    db.exec(`CREATE VIRTUAL TABLE catalog_fts USING fts5(name_id UNINDEXED, record_id UNINDEXED, value, normalized_value)`)
    const insFts = db.prepare('INSERT INTO catalog_fts (name_id, record_id, value, normalized_value) VALUES (?, ?, ?, ?)')
    const rows = opts.ftsRows ?? nameIds.length
    for (let i = 0; i < rows; i++) insFts.run(nameIds[i] ?? `nm-ghost-${i}`, 'rec-1', 'v', 'v')
  }
  db.close()
}

function writeTmpFixture(opts: { withFts?: boolean; ftsRows?: number; nameRows?: number; withManifest?: boolean }): string {
  const knowledge = join(tmp, 'skills', 'anima-prompt-v1', 'knowledge')
  mkdirSync(knowledge, { recursive: true })
  const dbPath = join(knowledge, 'tag-catalog.sqlite')
  buildFixtureCatalog(dbPath, opts)
  if (opts.withManifest !== false) {
    writeFileSync(
      join(knowledge, 'manifest.json'),
      JSON.stringify({ content_filters: false, output: { path: 'tag-catalog.sqlite', checksum: createHash('sha256').update(readFileSync(dbPath)).digest('hex') } }),
    )
  }
  return dbPath
}

describe('catalog verify — tmp fixture failure branches', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pm-browse-verify-'))
    setPresetRoot(tmp)
    closeCatalog()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    setCatalogPath('')
    closeCatalog()
    setPresetRoot(undefined)
    warnSpy.mockRestore()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('missing catalog_fts table → ftsParity + tables checks fail, ok:false', () => {
    setCatalogPath(writeTmpFixture({ withFts: false }))
    const r = verifyCatalog()
    expect(r.ok).toBe(false)
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]))
    expect(byName.tables?.ok).toBe(false)
    expect(byName.tables?.detail).toContain('catalog_fts')
    expect(byName.ftsParity?.ok).toBe(false)
    expect(byName.checksum?.ok).toBe(true)
  })

  it('FTS row count != names count → ftsParity fails with detail', () => {
    setCatalogPath(writeTmpFixture({ withFts: true, ftsRows: 1, nameRows: 2 }))
    const r = verifyCatalog()
    const parity = r.checks.find((c) => c.name === 'ftsParity')
    expect(parity?.ok).toBe(false)
    expect(parity?.detail).toMatch(/fts=1/)
    expect(r.ok).toBe(false)
  })

  it('well-formed tmp catalog + matching manifest → all four checks pass', () => {
    setCatalogPath(writeTmpFixture({ withFts: true }))
    const r = verifyCatalog()
    expect(r.checks.every((c) => c.ok)).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('browse/stats work against tmp fixture', () => {
    setCatalogPath(writeTmpFixture({ withFts: true }))
    expect(browseCatalog({ limit: 1 })).toHaveLength(1)
    expect(browseCatalog({ source: 'danbooru', limit: 5 })).toHaveLength(1)
    expect(browseCatalog({ category: 'nonexistent', limit: 5 })).toHaveLength(0)
    expect(catalogStats()).toEqual({ records: 1, names: 1, ftsRows: 1 })
  })
})
