import { describe, expect, it, afterEach, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  buildCatalog,
  classifyCategory,
  sha256File,
  verifyManifest,
  type CatalogBuildStats,
} from '../../../src/pe-framework/anima-knowledge/catalog-build.js'
import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
import { setCatalogPath, closeCatalog, searchCatalog, _testOnlyState } from '../../../src/pe-framework/dialect/anima-catalog.js'

/**
 * catalog-build —— builder.py 移植 纯库测试。
 * Fixture-first：tiny tags.sqlite（真实 schema 形状，2 源 5 有效 tag + 3 alias）
 * → build → 断言 stats / fts parity / 归并去重 / 别名重映射 / manifest。
 * 真实 204MB 资产全量重建走 PM_RUN_REAL=1 opt-in smoke（vitest 30s 内装不下完整 build）。
 */

/** 真实 tags.sqlite 形状的最小 fixture（含验证专用脏数据）；可重复调用（drop 后重建） */
function makeTagsSource(dbPath: string, extra?: Array<[number, string, string, string, number, string, string, string]>): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    DROP TABLE IF EXISTS aliases;
    DROP TABLE IF EXISTS tags;
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
  // 脏重复：bodysuit_（低 usage）与 bodysuit（高 usage）归一化后坍缩成 record 3（主）
  insTag.run(2, 'bodysuit_', 'bodysuit', 'clothing', 500, 'danbooru', 'v1', 'danbooru_canonical')
  insTag.run(3, 'bodysuit', 'bodysuit', 'clothing', 900, 'danbooru', 'v1', 'danbooru_canonical')
  // 脏下划线前缀 canonical
  insTag.run(4, '_long_black_hair', 'long_black_hair', 'hair', 700, 'danbooru', 'v1', 'danbooru_canonical')
  insTag.run(5, 'wave', 'wave', 'general', 4000, 'danbooru', 'v1', 'danbooru_canonical')
  // 空 canonical → 被跳过，不入 records
  insTag.run(6, '', '', 'general', 9, 'gelbooru_canonical', 'v1', 'gelbooru_canonical')
  for (const row of extra ?? []) insTag.run(...row)
  const insAlias = db.prepare('INSERT INTO aliases VALUES (?,?,?,?)')
  insAlias.run('waving', 5, 'danbooru', 0.85)
  // 撞 canonical 归一化形式的别名（bodysuit_ → bodysuit）→ 丢弃
  insAlias.run('bodysuit_', 2, 'danbooru', 0.9)
  insAlias.run('long hair', 4, 'danbooru', 0.8)
  db.close()
}

function countOf(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    db.close()
  }
}

let baseTmp: string

beforeAll(() => {
  baseTmp = mkdtempSync(join(tmpdir(), 'pm-catbuild-'))
})

afterEach(() => {
  closeCatalog()
  setCatalogPath(process.env.ANIMA_CATALOG_PATH ?? '')
  delete (process.env as Record<string, string | undefined>).ANIMA_CATALOG_PATH
  setPresetRoot(undefined)
})

describe('buildCatalog — tiny tags.sqlite fixture (raw-tags branch)', () => {
  it('stats/records/names/fts 计数正确（归并去重 + 别名存活 + 空 canonical 跳过）', () => {
    const dir = join(baseTmp, 'raw1')
    const sourcePath = join(dir, 'tags.sqlite')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    makeTagsSource(sourcePath)
    const stats = buildCatalog({ sourcePath, outputPath })
    expect(stats).toEqual({ records: 4, names: 6, ftsRows: 6 } satisfies CatalogBuildStats)
    // fts parity：catalog_fts 行数 == names 行数
    expect(countOf(outputPath, 'catalog_fts')).toBe(6)
    expect(countOf(outputPath, 'records')).toBe(4)
    expect(countOf(outputPath, 'names')).toBe(6)
    // sources：alias 源补 unknown 版本 → (danbooru,unknown) (danbooru,v1) (gelbooru_canonical,v1)
    expect(countOf(outputPath, 'sources')).toBe(3)
    // 四表齐备（FTS5 另有 5 个 catalog_fts_* 内部影子表，不列入）
    const tables = new DatabaseSync(outputPath, { readOnly: true })
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort()
    const expectedTables = ['catalog_fts', 'names', 'records', 'sources']
    for (const t of expectedTables) expect(tables).toContain(t)
    expect(tables.filter((t) => !t.startsWith('catalog_fts_'))).toEqual(expectedTables)
  })

  it('脏重复坍缩成主记录，别名重映射到主 record', () => {
    const dir = join(baseTmp, 'raw2')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    makeTagsSource(join(dir, 'tags.sqlite'))
    buildCatalog({ sourcePath: join(dir, 'tags.sqlite'), outputPath })
    const db = new DatabaseSync(outputPath, { readOnly: true })
    try {
      // bodysuit_ + bodysuit → 单 record（主 = usage 900 的 tag 3）
      const bodysuit = db.prepare("SELECT record_id, canonical_name, prompt_form, category, usage_count FROM records WHERE canonical_name='bodysuit'").get() as {
        record_id: string
        canonical_name: string
        prompt_form: string
        category: string
        usage_count: number
      }
      expect(bodysuit.record_id).toBe('3')
      expect(bodysuit.prompt_form).toBe('bodysuit')
      expect(bodysuit.category).toBe('clothing')
      expect(bodysuit.usage_count).toBe(900)
      // canonical 名带内部下划线保留（_long_black_hair → long_black_hair）
      const longHair = db.prepare("SELECT canonical_name FROM records WHERE record_id='4'").get() as { canonical_name: string }
      expect(longHair.canonical_name).toBe('long_black_hair')
      // 别名：waving → record 5；long hair → record 4（重映射后存活）
      const waving = db.prepare("SELECT record_id, normalized_value FROM names WHERE value='waving'").get() as { record_id: string }
      expect(waving.record_id).toBe('5')
      const longHairAlias = db.prepare("SELECT record_id FROM names WHERE value='long hair'").get() as { record_id: string }
      expect(longHairAlias.record_id).toBe('4')
      // 撞 canonical 的别名被丢弃：names 无 bodysuit_ 别名行
      expect(db.prepare("SELECT COUNT(*) AS n FROM names WHERE name_type='alias'").get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })

  it('FTS 可检索：build 产物 catalog_fts MATCH 命中原行', () => {
    const dir = join(baseTmp, 'raw3')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    makeTagsSource(join(dir, 'tags.sqlite'))
    buildCatalog({ sourcePath: join(dir, 'tags.sqlite'), outputPath })
    const db = new DatabaseSync(outputPath, { readOnly: true })
    try {
      const hits = db.prepare("SELECT record_id FROM catalog_fts WHERE catalog_fts MATCH 'waving'").all()
      expect(hits.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('manifest：build + manifestPath → manifest 重写且 verifyManifest 通过；篡改后失败', () => {
    const dir = join(baseTmp, 'raw4')
    const sourcePath = join(dir, 'tags.sqlite')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    const manifestPath = join(dir, 'manifest.json')
    makeTagsSource(sourcePath)
    buildCatalog({ sourcePath, outputPath, manifestPath })
    const payload = JSON.parse(readFileSync(manifestPath, 'utf8')) as { content_filters: boolean; source: { path: string; checksum: string }; output: { path: string; checksum: string } }
    expect(payload.content_filters).toBe(false)
    expect(payload.source.path).toBe('tags.sqlite')
    expect(payload.output.path).toBe('tag-catalog.sqlite')
    expect(payload.source.checksum).toBe(sha256File(sourcePath))
    expect(payload.output.checksum).toBe(sha256File(outputPath))
    expect(verifyManifest(manifestPath)).toBe(true)
    // 篡改 output checksum → verify false
    writeFileSync(manifestPath, JSON.stringify({ ...payload, output: { ...payload.output, checksum: '0'.repeat(64) } }), 'utf8')
    expect(verifyManifest(manifestPath)).toBe(false)
  })

  it('错误分支：源不存在 / output 与 source 同路径', () => {
    const dir = join(baseTmp, 'raw5')
    const sourcePath = join(dir, 'tags.sqlite')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    expect(() => buildCatalog({ sourcePath: join(dir, 'nope.sqlite'), outputPath })).toThrow(/not found/)
    makeTagsSource(sourcePath)
    expect(() => buildCatalog({ sourcePath, outputPath: sourcePath })).toThrow(/must not overwrite source/)
    // 失败不落盘（无 output、无 temp 残留）
    expect(existsSync(outputPath)).toBe(false)
    expect(existsSync(outputPath + '.tmp')).toBe(false)
  })
})

describe('rename fallback（仅 Windows 共享冲突 EPERM/EBUSY 回退原地重写；其他错误上抛）', () => {
  it.each(['EPERM', 'EBUSY'] as const)('rename 抛 %s → copyFileSync 回退：产物完整可读、行在、无 .tmp 残留', (code: 'EPERM' | 'EBUSY') => {
    const dir = join(baseTmp, 'fallback-' + code)
    const sourcePath = join(dir, 'tags.sqlite')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    makeTagsSource(sourcePath)

    const stats = buildCatalog({
      sourcePath,
      outputPath,
      renameFn: () => {
        const failed = code === 'EPERM' ? 'operation not permitted' : 'device or resource busy'
        throw Object.assign(new Error(`${code}: ${failed}, rename`), { code })
      },
    })
    // 回退落盘后统计与普通 build 一致；目标是可读 sqlite（countOf 打开即验证）且行在
    expect(stats).toEqual({ records: 4, names: 6, ftsRows: 6 })
    expect(countOf(outputPath, 'records')).toBe(4)
    expect(countOf(outputPath, 'names')).toBe(6)
    // 回退走完 cleanup：无临时文件残留
    expect(existsSync(outputPath + '.tmp')).toBe(false)
  })

  it('rename 抛非 EPERM/EBUSY（EACCES）→ 直接上抛，不回退、不落盘', () => {
    const dir = join(baseTmp, 'fallback-eacces')
    const sourcePath = join(dir, 'tags.sqlite')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    makeTagsSource(sourcePath)

    expect(() =>
      buildCatalog({
        sourcePath,
        outputPath,
        renameFn: () => {
          throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
        },
      }),
    ).toThrow(/EACCES/)
    // 目标不被半成品污染（rename 失败即中止，不写 output）
    expect(existsSync(outputPath)).toBe(false)
  })
})

describe('classifyCategory / normalize（facets.py 移植）', () => {
  it('来源分类特判映射', () => {
    expect(classifyCategory('x', 'artist')).toBe('artist')
    expect(classifyCategory('x', 'copyright')).toBe('franchise')
    expect(classifyCategory('x', 'character')).toBe('character')
    expect(classifyCategory('x', 'quality')).toBe('quality')
    expect(classifyCategory('x', 'meta')).toBe('meta')
    expect(classifyCategory('x', 'safety')).toBe('nsfw')
  })
  it('标记匹配（归一化后 ^/$/space 边界）', () => {
    expect(classifyCategory('watercolor', 'general')).toBe('style')
    expect(classifyCategory('1girl watercolor', 'general')).toBe('style')
    expect(classifyCategory('long_black_hair', 'general')).toBe('hair')
    expect(classifyCategory('full_body', 'general')).toBe('appearance') // facets 顺序：appearance('body') 在 composition 之前命中
    expect(classifyCategory('depth_of_field', 'general')).toBe('camera')
    expect(classifyCategory('standing pose', 'general')).toBe('pose')
    expect(classifyCategory('holding a sword', 'general')).toBe('action')
    expect(classifyCategory('blue_sky', 'general')).toBe('environment')
    expect(classifyCategory('photorealistic', 'general')).toBe('medium')
    expect(classifyCategory('something_else', 'general')).toBe('general')
  })
})

describe('copyNormalized 分支（legacy tag-catalog 形状源）', () => {
  const SCHEMA = `
    CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL, uri TEXT NOT NULL, license TEXT NOT NULL, snapshot_version TEXT NOT NULL, fetched_at TEXT NOT NULL, checksum TEXT NOT NULL, raw_schema TEXT NOT NULL);
    CREATE TABLE records (record_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, prompt_form TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, language_names TEXT NOT NULL, confidence REAL, source_ids TEXT NOT NULL, provenance TEXT NOT NULL, usage_count INTEGER NOT NULL, deprecated INTEGER NOT NULL CHECK (deprecated IN (0, 1)));
    CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(record_id), value TEXT NOT NULL, normalized_value TEXT NOT NULL, name_type TEXT NOT NULL CHECK (name_type IN ('canonical', 'alias', 'translation', 'historical')), language TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(source_id));
  `

  function makeCatalogSource(dbPath: string, mutate?: (db: DatabaseSync) => void): void {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(SCHEMA)
    db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)').run('src:1', 'src', '', '', '1', '', 'abc', 'raw')
    db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('r1', 'smile', 'smile', 'general', '', '[]', null, '["src:1"]', '{}', 10, 0)
    db.prepare('INSERT INTO names VALUES (?,?,?,?,?,?,?)').run('n1', 'r1', 'smile', 'smile', 'canonical', '', 'src:1')
    if (mutate) mutate(db)
    db.close()
  }

  it('与当前 schema 一致的 legacy 源 → 整表拷贝（无 tags/aliases → copy 分支）', () => {
    const dir = join(baseTmp, 'copy1')
    const sourcePath = join(dir, 'legacy-catalog.sqlite')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    makeCatalogSource(sourcePath)
    const stats = buildCatalog({ sourcePath, outputPath })
    // sources/records/names 各 1 行；fts 填充 names
    expect(stats).toEqual({ records: 1, names: 1, ftsRows: 1 })
    const db = new DatabaseSync(outputPath, { readOnly: true })
    try {
      expect(db.prepare("SELECT canonical_name FROM records WHERE record_id='r1'").get()).toEqual({ canonical_name: 'smile' })
      expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_fts WHERE catalog_fts MATCH 'smile'").get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('列集合不齐 → 故意抛错（legacy schema 拒绝，不把死表带过来）', () => {
    const dir = join(baseTmp, 'copy2')
    const sourcePath = join(dir, 'legacy-catalog.sqlite')
    const outputPath = join(dir, 'tag-catalog.sqlite')
    makeCatalogSource(sourcePath, (db) => db.exec('ALTER TABLE records DROP COLUMN provenance'))
    expect(() => buildCatalog({ sourcePath, outputPath })).toThrow(/does not use the current schema/)
  })
})

describe('G4 交互：rebuild 后 catalog_search 自动读新文件（mtime 刷新，不动缓存句柄）', () => {
  it('build → searchCatalog 返回新行；build 自身不触碰缓存句柄', () => {
    const root = join(baseTmp, 'g4')
    const sourcePath = join(root, 'skills', 'anima-prompt-v1', 'knowledge', 'tags.sqlite')
    const outputPath = join(root, 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite')
    setPresetRoot(root) // manifest 对账落到 tmp（无 manifest.json → fail-fast，不哈希真实 820MB 库）
    makeTagsSource(sourcePath)

    // build v1 → 打开缓存句柄
    buildCatalog({ sourcePath, outputPath })
    setCatalogPath(outputPath)
    expect(searchCatalog('waving').map((h) => h.record_id)).toContain('5')
    expect(_testOnlyState().dbGeneration).toBe(1)

    // 追加新 tag 后 rebuild（同一 output 路径）
    makeTagsSource(sourcePath, [[7, 'nekomimi', 'nekomimi', 'character', 10, 'danbooru', 'v1', 'danbooru_canonical']])
    const stats = buildCatalog({ sourcePath, outputPath })
    expect(stats.records).toBe(5)
    // build 自身不能触碰缓存句柄（gen 不因 build 而变化）
    expect(_testOnlyState().dbGeneration).toBe(1)

    // 模拟真实重建必然带来的 mtime 位移（新 inode / NTFS 高精时间戳；显式 bump 去 flake）
    const future = new Date(Date.now() + 60_000)
    utimesSync(outputPath, future, future)

    // 下一次查询：G4 mtime 刷新 → 关闭陈旧句柄重开 → 自动读新文件
    const hits = searchCatalog('nekomimi', { mode: 'exact' })
    expect(hits.map((h) => h.record_id)).toContain('7')
    expect(_testOnlyState().dbGeneration).toBe(2)
  })
})

// ---- 真实资产 opt-in smoke（PM_RUN_REAL=1；完整 build 1-3 分钟，超过 vitest 默认 30s）----

function realPresetRoot(): string {
  const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
  const parts = here.split(/[\\/]/)
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') return parts.slice(0, i).join(sep)
  }
  throw new Error('cannot locate preset root from test location')
}

describe.skipIf(process.env.PM_RUN_REAL !== '1')('real tags.sqlite full rebuild (opt-in: PM_RUN_REAL=1)', () => {
  it(
    '204MB tags.sqlite → tmp tag-catalog：stats 规模 + fts parity + search 命中',
    { timeout: 300_000 },
    async () => {
      const sourcePath = join(realPresetRoot(), 'assets', 'knowledge', 'anima-prompt-v1', 'tags.sqlite')
      expect(existsSync(sourcePath)).toBe(true)
      const dir = join(baseTmp, 'real-out')
      const outputPath = join(dir, 'tag-catalog.sqlite')
      const stats = buildCatalog({ sourcePath, outputPath })
      expect(stats.records).toBeGreaterThan(1_000_000)
      expect(stats.names).toBeGreaterThan(1_000_000)
      expect(stats.ftsRows).toBe(stats.names)
      expect(countOf(outputPath, 'catalog_fts')).toBe(stats.names)
      // rebuild 产物可检索
      setCatalogPath(outputPath)
      expect(searchCatalog('1girl', { mode: 'exact' }).length).toBeGreaterThan(0)
    },
  )

  afterEach(() => {
    // searchCatalog 打开过 output 的缓存句柄（无 FILE_SHARE_DELETE）→ 先关句柄再删目录
    closeCatalog()
    setCatalogPath('')
    const dir = join(baseTmp, 'real-out')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })
})