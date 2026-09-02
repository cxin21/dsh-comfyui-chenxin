import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { registerCatalogBuildTool } from '../../src/tools/catalog-build.js'
import { stubCtx, runTool } from './helpers.js'
import { setPresetRoot } from '../../src/pe-framework/resources/resolve.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'
import { verifyManifest } from '../../src/pe-framework/anima-knowledge/catalog-build.js'

const cfg = { temperature: 0.7 }
const def = () => registerCatalogBuildTool(null as never, cfg as never)

/** 真实 tags.sqlite 形状的最小结余 fixture（3 tag + 1 alias） */
function seedTagsSource(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE tags (
      tag_id INTEGER PRIMARY KEY,
      canonical TEXT NOT NULL UNIQUE,
      anima_form TEXT NOT NULL,
      category TEXT NOT NULL,
      usage_count INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      verification_status TEXT NOT NULL
    );
    CREATE TABLE aliases (
      alias TEXT NOT NULL,
      tag_id INTEGER NOT NULL REFERENCES tags(tag_id),
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY(alias, tag_id)
    );
  `)
  const insTag = db.prepare('INSERT INTO tags VALUES (?,?,?,?,?,?,?,?)')
  insTag.run(1, '1girl', '1girl', 'general', 1000, 'danbooru', 'v1', 'danbooru_canonical')
  insTag.run(2, 'wave', 'wave', 'general', 4000, 'danbooru', 'v1', 'danbooru_canonical')
  insTag.run(3, 'long_black_hair', 'long_black_hair', 'hair', 700, 'danbooru', 'v1', 'danbooru_canonical')
  db.prepare('INSERT INTO aliases VALUES (?,?,?,?)').run('waving', 2, 'danbooru', 0.85)
  db.close()
}

let presetTmp: string
let looseTmp: string

beforeEach(() => {
  presetTmp = mkdtempSync(join(tmpdir(), 'pm-catbtool-preset-'))
  looseTmp = mkdtempSync(join(tmpdir(), 'pm-catbtool-loose-'))
})

afterEach(() => {
  setPresetRoot(undefined)
  closeCatalog()
  rmSync(presetTmp, { recursive: true, force: true })
  rmSync(looseTmp, { recursive: true, force: true })
})

describe('catalog_build tool', () => {
  it('无参数默认：resolveKnowledgePath 推导源/输出/manifest，构建 + manifest 更新', async () => {
    // 假 preset 布局：<tmp>/skills/anima-prompt-v1/knowledge/tags.sqlite
    const knowledge = join(presetTmp, 'skills', 'anima-prompt-v1', 'knowledge')
    mkdirSync(knowledge, { recursive: true })
    seedTagsSource(join(knowledge, 'tags.sqlite'))
    setPresetRoot(presetTmp)

    const ctx = stubCtx()
    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
    const env = JSON.parse(String(await runTool(ctx, tool, {}))) as {
      ok: boolean
      stats: { records: number; names: number; ftsRows: number }
      output: string
      manifest: string | null
    }
    expect(env.ok).toBe(true)
    expect(env.stats).toEqual({ records: 3, names: 4, ftsRows: 4 })
    expect(env.output).toBe(join(knowledge, 'tag-catalog.sqlite'))
    expect(env.manifest).toBe(join(knowledge, 'manifest.json'))
    expect(existsSync(env.output)).toBe(true)
    expect(existsSync(env.manifest as string)).toBe(true)
    expect(verifyManifest(env.manifest as string)).toBe(true)

    // 产物 FTS 可检索
    const db = new DatabaseSync(env.output, { readOnly: true })
    try {
      expect((db.prepare("SELECT COUNT(*) AS n FROM catalog_fts WHERE catalog_fts MATCH 'waving'").get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('显式 source/output（自定义路径）→ 不写真实 manifest（避免污染）', async () => {
    const sourcePath = join(looseTmp, 'tags.sqlite')
    const outputPath = join(looseTmp, 'custom', 'catalog.sqlite')
    seedTagsSource(sourcePath)

    const ctx = stubCtx()
    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
    const env = JSON.parse(String(await runTool(ctx, tool, { source: sourcePath, output: outputPath }))) as {
      ok: boolean
      stats: { records: number }
      manifest: string | null
    }
    expect(env.ok).toBe(true)
    expect(env.stats.records).toBe(3)
    expect(env.manifest).toBeNull() // 自定义 output → 不更新 manifest
    expect(existsSync(outputPath)).toBe(true)
  })

  it('显式 output 与默认一致 → 仍更新默认 manifest（就地重建语义）', async () => {
    const knowledge = join(presetTmp, 'skills', 'anima-prompt-v1', 'knowledge')
    mkdirSync(knowledge, { recursive: true })
    seedTagsSource(join(knowledge, 'tags.sqlite'))
    setPresetRoot(presetTmp)

    const ctx = stubCtx()
    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
    const env = JSON.parse(String(await runTool(ctx, tool, { output: join(knowledge, 'tag-catalog.sqlite') }))) as {
      ok: boolean
      manifest: string | null
    }
    expect(env.ok).toBe(true)
    expect(env.manifest).toBe(join(knowledge, 'manifest.json'))
    expect(existsSync(env.manifest as string)).toBe(true)
  })

  it('源不存在 → Envelope ok:false + input_file_missing', async () => {
    const ctx = stubCtx()
    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
    const env = JSON.parse(String(await runTool(ctx, tool, { source: join(looseTmp, 'missing.sqlite') }))) as {
      ok: boolean
      errors: Array<{ code: string; message: string }>
    }
    expect(env.ok).toBe(false)
    expect(env.errors[0].code).toBe('input_file_missing')
    expect(env.errors[0].message).toMatch(/not found/)
  })

  it('output 与 source 同路径 → Envelope ok:false + argument_error', async () => {
    const sourcePath = join(looseTmp, 'same.sqlite')
    seedTagsSource(sourcePath)
    const ctx = stubCtx()
    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
    const env = JSON.parse(String(await runTool(ctx, tool, { source: sourcePath, output: sourcePath }))) as {
      ok: boolean
      errors: Array<{ code: string }>
    }
    expect(env.ok).toBe(false)
    expect(env.errors[0].code).toBe('argument_error')
  })
})