/**
 * catalog-build.ts — anima-prompt-v1 `catalog build` 移植（4 阶段 skill-merge 的 Stage 1）。
 *
 * 源码忠实移植（source of truth）：
 * - skills/anima-prompt-v1/anima_prompt_v1/catalog/builder.py（build 主链：临时文件构建 →
 *   names/catalog_fts 填充 → VACUUM → 原子替换 → manifest 更新）
 * - .../catalog/storage.py（CatalogStore.create_schema 目标 schema：
 *   sources / records / names + catalog_fts FTS5）
 * - .../catalog/facets.py（classify_category / normalize；normalize 复用
 *   anima-catalog.normalizeTag —— 已确认与 facets.normalize 语义一致）
 *
 * 设计约束：
 * - 零日志（工具层日志在 src/tools/catalog-build.ts）。
 * - 构建打开自己的只读源连接 + 可写临时输出连接，**绝不触碰** anima-catalog.ts 的
 *   只读缓存句柄；替换落盘后下一次 db() 经 G4 mtime 刷新自动切换到新文件。
 * - 原子性：临时文件完整构建成功后 rename 替换（POSIX / 目标未被占用时）。
 *   Windows 上目标被已打开 SQLite 句柄占用时 rename 报 EPERM / EBUSY（句柄未带
 *   FILE_SHARE_DELETE），仅这两个码回退 copyFileSync 原地重写 —— 构建是同步代码，
 *   事件循环内没有并发查询交错，进程内读者不可能观察到半成品；
 *   G4 的 mtime 检查在下次 db() 时关闭陈旧句柄并重开。
 *   其他 rename 错误（如 ACL 拒绝的 EACCES）直接上抛，不静默降级成原地重写。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, renameSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, relative, resolve } from 'node:path'
import { normalizeTag } from '../dialect/anima-catalog.js'

export interface CatalogBuildStats {
  records: number
  names: number
  ftsRows: number
}

/** storage.py _TABLES —— 只有 virgin schema 幸存的表（concepts/facets/relations 已砍） */
const TABLES = ['sources', 'records', 'names'] as const

/** storage.py SCHEMA 逐条移植（FTS5 virtual table + 4 索引） */
const SCHEMA = `
CREATE TABLE sources (
    source_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    uri TEXT NOT NULL,
    license TEXT NOT NULL,
    snapshot_version TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    checksum TEXT NOT NULL,
    raw_schema TEXT NOT NULL
);
CREATE TABLE records (
    record_id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    prompt_form TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    language_names TEXT NOT NULL,
    confidence REAL,
    source_ids TEXT NOT NULL,
    provenance TEXT NOT NULL,
    usage_count INTEGER NOT NULL,
    deprecated INTEGER NOT NULL CHECK (deprecated IN (0, 1))
);
CREATE TABLE names (
    name_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records(record_id),
    value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    name_type TEXT NOT NULL CHECK (name_type IN ('canonical', 'alias', 'translation', 'historical')),
    language TEXT NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(source_id)
);
CREATE VIRTUAL TABLE catalog_fts USING fts5(
    name_id UNINDEXED,
    record_id UNINDEXED,
    value,
    normalized_value,
    tokenize='unicode61'
);
CREATE INDEX idx_records_canonical ON records(canonical_name);
CREATE INDEX idx_records_category ON records(category);
CREATE INDEX idx_names_normalized ON names(normalized_value);
CREATE INDEX idx_names_record ON names(record_id);
`

/** builder.py sha256_file：流式 1MB 分块（同步，对齐 Python 逐块读） */
export function sha256File(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let bytes = 0
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

/** builder.py verify_manifest：content_filters===false 且 source/output 条目
 *  checksum 为 64 位 hex 且与落盘文件实算一致（相对路径以 manifest 所在目录解析） */
export function verifyManifest(manifestPath: string): boolean {
  try {
    const payload = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    if (payload.content_filters !== false) return false
    const directory = resolve(dirname(manifestPath))
    for (const key of ['source', 'output'] as const) {
      const entry = payload[key]
      if (typeof entry !== 'object' || entry === null) return false
      const record = entry as Record<string, unknown>
      const artifact = resolve(directory, String(record.path))
      const checksum = record.checksum
      if (typeof checksum !== 'string' || checksum.length !== 64) return false
      if (!/^[0-9a-f]+$/i.test(checksum)) return false
      if (!existsSync(artifact)) return false
      if (sha256File(artifact) !== checksum.toLowerCase()) return false
    }
    return true
  } catch {
    return false
  }
}

/** builder.py _clean_name：去两侧空白与下划线；保内部下划线 */
function cleanName(value: string): string {
  if (!value) return ''
  return value.trim().replace(/^_+|_+$/g, '').trim()
}

/** facets.py _CATEGORY_MARKERS 逐条移植 */
const CATEGORY_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['style', ['watercolor', 'watercolour', 'illustration', 'painting', 'sketch', 'manga', 'comic', 'render', 'cinematic']],
  ['clothing', ['dress', 'coat', 'shirt', 'skirt', 'uniform', 'armor', 'armour', 'bodysuit', 'stockings', 'gloves', 'boots', 'shoes', 'jacket', 'pants', 'shorts', 'underwear', 'bikini', 'swimsuit', 'lingerie']],
  ['hair', ['hair', 'ponytail', 'braid', 'bangs']],
  ['appearance', ['eyes', 'eye', 'skin', 'face', 'breasts', 'chest', 'body', 'makeup', 'freckles', 'scar']],
  ['expression', ['smile', 'frown', 'blush', 'crying', 'angry', 'serious']],
  ['pose', ['standing', 'sitting', 'lying', 'kneeling', 'walking', 'running', 'pose']],
  ['action', ['holding', 'waving', 'looking', 'fighting', 'shooting', 'touching', 'eating']],
  ['composition', ['portrait', 'full_body', 'upper_body', 'close-up', 'closeup', 'wide_shot']],
  ['camera', ['view', 'angle', 'depth_of_field', 'bokeh', 'lens']],
  ['lighting', ['light', 'lighting', 'shadow', 'rim_light', 'sunlight', 'backlight']],
  ['environment', ['sky', 'forest', 'street', 'room', 'station', 'city', 'beach', 'ruins']],
  ['object', ['weapon', 'sword', 'gun', 'flower', 'book', 'vehicle']],
  ['medium', ['photo', 'photorealistic', '3d', 'oil_painting']],
  ['model', ['checkpoint', 'lora', 'embedding', 'trigger']],
]

/** facets.py classify_category：来源分类特判 → 归一化 canonical 上的标记匹配 → general */
export function classifyCategory(canonical: string, sourceCategory: string): string {
  if (sourceCategory === 'artist') return 'artist'
  if (sourceCategory === 'copyright') return 'franchise'
  if (sourceCategory === 'character') return 'character'
  if (sourceCategory === 'quality') return 'quality'
  if (sourceCategory === 'meta') return 'meta'
  if (sourceCategory === 'safety') return 'nsfw'
  const normalized = normalizeTag(canonical)
  for (const [category, markers] of CATEGORY_MARKERS) {
    for (const marker of markers) {
      // re.search(rf"(?:^| ){re.escape(marker.replace('_',' '))}(?:$| )") 的移植
      const pattern = '(?:^| )' + marker.replaceAll('_', ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$| )'
      if (new RegExp(pattern).test(normalized)) return category
    }
  }
  return 'general'
}

/** builder.py：with_suffix(output.suffix + ".tmp") —— tag-catalog.sqlite → tag-catalog.sqlite.tmp */
function tempPathFor(outputPath: string): string {
  const parsed = parse(outputPath)
  return join(parsed.dir, parsed.name + (parsed.ext ? parsed.ext + '.tmp' : '.sqlite.tmp'))
}

/** builder.py _build_from_raw_tags：tags/aliases 源表快照 → 归并分组 → 主记录 + 别名重映射 */
function buildFromRawTags(source: DatabaseSync, output: DatabaseSync, sourcePath: string): void {
  const sourceChecksum = sha256File(sourcePath)
  const aliasesRaw = source
    .prepare('SELECT alias, tag_id, source FROM aliases ORDER BY tag_id, alias, source')
    .all() as Array<{ alias: string; tag_id: number; source: string }>

  const seen = new Map<string, [string, string]>()
  for (const row of source.prepare('SELECT DISTINCT source, source_version FROM tags').all() as Array<{ source: string; source_version: string }>) {
    seen.set(`${row.source}\u0000${row.source_version}`, [row.source, row.source_version])
  }
  for (const a of aliasesRaw) seen.set(`${a.source}\u0000unknown`, [a.source, 'unknown'])
  const sourceRows = [...seen.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))

  const insertSource = output.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const [name, version] of sourceRows) {
    insertSource.run(`${name}:${version}`, name, '', 'unknown', version, '', sourceChecksum, 'tags.sqlite + aliases')
  }
  const sourceIds = new Map(sourceRows.map(([name, version]) => [`${name}:${version}`, `${name}:${version}`]))

  const tags = source
    .prepare('SELECT tag_id, canonical, anima_form, category, usage_count, source, source_version FROM tags ORDER BY tag_id')
    .all() as Array<{
    tag_id: number
    canonical: string
    anima_form: string
    category: string
    usage_count: number
    source: string
    source_version: string
  }>

  // 清洗 canonical 后按归一化形式分组：脏重复（bodysuit / bodysuit_、1girl / _1girl）
  // 坍缩成一个 record，避免并行 score-1000 命中。
  const groups = new Map<string, Array<{ tag_id: string; canonical: string; prompt_form: string; category: string; usage: number; source_id: string }>>()
  for (const row of tags) {
    const cleanCanonical = cleanName(row.canonical)
    if (!cleanCanonical) continue
    const norm = normalizeTag(cleanCanonical)
    const promptForm = row.anima_form ? cleanName(row.anima_form) : ''
    const sourceId = sourceIds.get(`${row.source}:${row.source_version}`) ?? `${row.source}:${row.source_version}`
    const list = groups.get(norm)
    const member = {
      tag_id: String(row.tag_id),
      canonical: cleanCanonical,
      prompt_form: promptForm || cleanCanonical,
      category: classifyCategory(cleanCanonical, row.category),
      usage: Number(row.usage_count) || 0,
      source_id: sourceId,
    }
    if (list) list.push(member)
    else groups.set(norm, [member])
  }

  // 每组主记录：最高 usage → 最短 canonical → tag_id 字面（对齐 Python str 比较）；
  // 被丢成员的 tag_id 重映射到主记录，别名得以存活。
  const remap = new Map<string, string>()
  const records: Array<{ tag_id: string; canonical: string; prompt_form: string; category: string; usage: number; source_id: string }> = []
  for (const members of groups.values()) {
    members.sort((a, b) => b.usage - a.usage || a.canonical.length - b.canonical.length || (a.tag_id < b.tag_id ? -1 : a.tag_id > b.tag_id ? 1 : 0))
    const primary = members[0]
    for (const member of members) remap.set(member.tag_id, primary.tag_id)
    records.push(primary)
  }

  const insertRecord = output.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const rec of records) {
    // provenance sort_keys=True → raw_record_id 先于 source_id
    const provenance = { raw_record_id: rec.tag_id, source_id: rec.source_id }
    insertRecord.run(
      rec.tag_id, rec.canonical, rec.prompt_form, rec.category, '', '[]', null,
      JSON.stringify([rec.source_id]), JSON.stringify(provenance), rec.usage, 0,
    )
  }

  // names：每条 record 一个 canonical，加别名（重映射后清洗去重）；与 canonical 撞
  // 归一化形式的别名丢弃（canonical 胜）。
  const canonicalNorms = new Set(groups.keys())
  const names: Array<[string, string, string, string, string, string, string]> = []
  for (const rec of records) {
    names.push([`canonical:${rec.tag_id}`, rec.tag_id, rec.canonical, normalizeTag(rec.canonical), 'canonical', '', rec.source_id])
  }
  const aliasSeen = new Map<string, [string, string, string]>() // norm → (mapped_id, value, alias_source)
  for (const a of aliasesRaw) {
    const cleanAlias = cleanName(a.alias)
    if (!cleanAlias) continue
    const norm = normalizeTag(cleanAlias)
    if (canonicalNorms.has(norm)) continue
    const mappedId = remap.get(String(a.tag_id)) ?? String(a.tag_id)
    if (!aliasSeen.has(norm)) aliasSeen.set(norm, [mappedId, cleanAlias, a.source])
  }
  const aliasByRecord = new Map<string, Array<[string, string, string]>>()
  for (const [norm, [mappedId, value, aliasSource]] of aliasSeen) {
    const list = aliasByRecord.get(mappedId)
    const item: [string, string, string] = [norm, value, aliasSource]
    if (list) list.push(item)
    else aliasByRecord.set(mappedId, [item])
  }
  let index = 0
  const insertName = output.prepare('INSERT INTO names VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const [mappedId, items] of aliasByRecord) {
    for (const [norm, value, aliasSource] of items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      index += 1
      const sourceId = sourceIds.get(`${aliasSource}:unknown`) ?? `${aliasSource}:unknown`
      names.push([`alias:${mappedId}:${index}`, mappedId, value, norm, 'alias', '', sourceId])
    }
  }
  for (const n of names) insertName.run(...n)
}

/** builder.py _copy_normalized：幸存表整表拷贝；列集合不齐（legacy schema）→ 故意抛错 */
function copyNormalized(source: DatabaseSync, output: DatabaseSync): void {
  for (const table of TABLES) {
    const columns = (source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    if (!columns.length) throw new Error(`source catalog missing required table: ${table}`)
    const expected = (output.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    if (columns.join('\u0000') !== expected.join('\u0000')) {
      throw new Error(`source table ${table} does not use the current schema`)
    }
    const rows = source.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.join(', ')}`).all()
    const placeholders = columns.map(() => '?').join(', ')
    const insert = output.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
    for (const row of rows) insert.run(...Object.values(row))
  }
}

export interface BuildCatalogOptions {
  sourcePath: string
  outputPath: string
  manifestPath?: string
  /** 原子替换注入缝隙（M3 测试）：默认 node:fs renameSync；仅 EPERM/EBUSY 回退原地重写 */
  renameFn?: (oldPath: string, newPath: string) => void
}

/** builder.py build 主链 + 原子替换（详见文件头注释，Windows rename 回退说明） */
export function buildCatalog(options: BuildCatalogOptions): CatalogBuildStats {
  const { sourcePath, outputPath, renameFn = renameSync } = options
  if (!existsSync(sourcePath)) throw new Error(`catalog source not found: ${sourcePath}`)
  if (resolve(sourcePath) === resolve(outputPath)) throw new Error('output must not overwrite source')
  mkdirSync(dirname(outputPath), { recursive: true })
  const temporary = tempPathFor(outputPath)
  try {
    unlinkSync(temporary)
  } catch {
    /* unlink(missing_ok=True) */
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  const outputDb = new DatabaseSync(temporary)
  try {
    outputDb.exec('PRAGMA foreign_keys = ON')
    outputDb.exec(SCHEMA)
    const sourceTables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name))
    outputDb.exec('BEGIN')
    if (sourceTables.has('tags') && sourceTables.has('aliases')) buildFromRawTags(source, outputDb, sourcePath)
    else copyNormalized(source, outputDb)
    const ftsRows = outputDb
      .prepare('SELECT name_id, record_id, value, normalized_value FROM names ORDER BY normalized_value, name_id')
      .all() as Array<{ name_id: string; record_id: string; value: string; normalized_value: string }>
    const insertFts = outputDb.prepare('INSERT INTO catalog_fts VALUES (?, ?, ?, ?)')
    for (const r of ftsRows) insertFts.run(r.name_id, r.record_id, r.value, r.normalized_value)
    outputDb.exec('COMMIT')
    // VACUUM：node:sqlite DatabaseSync.exec('VACUUM') 在 Node 24 上可用（已验证）。
    // 事务已提交 → VACUUM 在事务外执行（对齐 builder.py 的 commit 后再 VACUUM）。
    outputDb.exec('VACUUM')
  } finally {
    source.close()
    outputDb.close()
  }
  try {
    // os.replace 移植：POSIX 直接替换；Windows 目标被已打开 SQLite 句柄占用（无
    // FILE_SHARE_DELETE）时 rename 报 EPERM / EBUSY → 仅这两个码回退 copyFileSync
    // 原地重写（同步构建，进程内不可能交错读取；G4 mtime 刷新处理陈旧句柄）。
    // 其他 rename 错误（如 ACL 拒绝的 EACCES）直接上抛，不静默降级成原地重写。
    renameFn(temporary, outputPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EBUSY') throw e
    copyFileSync(temporary, outputPath)
  }
  try {
    unlinkSync(temporary)
  } catch {
    /* cleanup */
  }
  const stats = collectStats(outputPath)
  if (options.manifestPath !== undefined) writeManifest(options.manifestPath, sourcePath, outputPath)
  return stats
}

/** builder.py _stats：records / names / catalog_fts 三计数（只读重开输出文件） */
function collectStats(outputPath: string): CatalogBuildStats {
  const db = new DatabaseSync(outputPath, { readOnly: true })
  try {
    const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return { records: count('records'), names: count('names'), ftsRows: count('catalog_fts') }
  } finally {
    db.close()
  }
}

/** builder.py _write_manifest + _manifest_artifact_path（相对 manifest 目录；跨盘回退绝对路径） */
function writeManifest(manifestPath: string, sourcePath: string, outputPath: string): void {
  mkdirSync(dirname(manifestPath), { recursive: true })
  const directory = resolve(dirname(manifestPath))
  const payload = {
    content_filters: false,
    output: { path: manifestArtifactPath(outputPath, directory), checksum: sha256File(outputPath) },
    source: { path: manifestArtifactPath(sourcePath, directory), checksum: sha256File(sourcePath) },
  }
  writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

function manifestArtifactPath(artifact: string, directory: string): string {
  try {
    return relative(directory, resolve(artifact))
  } catch {
    return resolve(artifact)
  }
}