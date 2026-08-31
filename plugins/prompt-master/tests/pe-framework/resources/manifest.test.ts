import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
import { assertAnimaCatalog, assertH3Tokenizer } from '../../../src/pe-framework/resources/manifest.js'

let tmp: string

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function writeAnimaFixture(opts: { checksum?: string; omitChecksum?: boolean; omitManifest?: boolean; catalogContent?: string }): void {
  const knowledge = join(tmp, 'skills', 'anima-prompt-v1', 'knowledge')
  mkdirSync(knowledge, { recursive: true })
  writeFileSync(join(knowledge, 'tag-catalog.sqlite'), opts.catalogContent ?? 'fake-catalog-bytes')
  if (!opts.omitManifest) {
    const manifest: Record<string, unknown> = { content_filters: false, output: { path: 'tag-catalog.sqlite' } }
    if (!opts.omitChecksum) {
      ;(manifest.output as Record<string, unknown>).checksum = opts.checksum ?? sha256(join(knowledge, 'tag-catalog.sqlite'))
    }
    writeFileSync(join(knowledge, 'manifest.json'), JSON.stringify(manifest))
  }
}

function writeH3Fixture(opts: { snapshotId?: string; withTokenizer?: boolean; omitManifest?: boolean }): void {
  const knowledge = join(tmp, 'skills', 'minimax-h3-prompt', 'knowledge')
  mkdirSync(knowledge, { recursive: true })
  if (!opts.omitManifest) {
    writeFileSync(
      join(knowledge, 'manifest.json'),
      JSON.stringify({ schema_version: 1, snapshot_id: opts.snapshotId ?? 'h3-qwen3-vl' }),
    )
  }
  if (opts.withTokenizer !== false) writeFileSync(join(knowledge, 'tokenizer.json'), '{}')
}

describe('asset manifest verification', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pm-manifest-'))
    setPresetRoot(tmp)
  })
  afterEach(() => {
    setPresetRoot(undefined)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('anima: manifest checksum matches actual file → ok', () => {
    writeAnimaFixture({})
    expect(assertAnimaCatalog()).toEqual({ ok: true })
  })

  it('anima: checksum mismatch → ok:false with mismatch reason', () => {
    writeAnimaFixture({ checksum: 'deadbeef'.repeat(8), catalogContent: 'different-bytes' })
    const r = assertAnimaCatalog()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('mismatch')
  })

  it('anima: manifest missing → ok:false with unreadable reason', () => {
    writeAnimaFixture({ omitManifest: true })
    const r = assertAnimaCatalog()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('unreadable')
  })

  it('anima: manifest without checksum field → ok:false', () => {
    writeAnimaFixture({ omitChecksum: true })
    const r = assertAnimaCatalog()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('checksum')
  })

  it('h3: correct snapshot_id + tokenizer.json present → ok', () => {
    writeH3Fixture({})
    expect(assertH3Tokenizer()).toEqual({ ok: true })
  })

  it('h3: wrong snapshot_id → ok:false with mismatch reason', () => {
    writeH3Fixture({ snapshotId: 'wrong-snapshot' })
    const r = assertH3Tokenizer()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('mismatch')
  })

  it('h3: tokenizer.json missing → ok:false', () => {
    writeH3Fixture({ withTokenizer: false })
    const r = assertH3Tokenizer()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('mismatch')
  })

  it('h3: manifest missing → ok:false with unreadable reason', () => {
    writeH3Fixture({ omitManifest: true })
    const r = assertH3Tokenizer()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('unreadable')
  })
})
