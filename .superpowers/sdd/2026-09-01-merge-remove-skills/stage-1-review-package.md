# Review package - 3cc4e64..6f86d8c

## Commits
``````

## Stat
``` .../pe-framework/anima-knowledge/catalog-build.ts  | 380 +++++++++++++++++++++
 plugins/prompt-master/src/plugin/index.ts          |   2 +
 plugins/prompt-master/src/tools/catalog-build.ts   |  74 ++++
 .../anima-knowledge/catalog-build.test.ts          | 331 ++++++++++++++++++
 .../tests/plugin/catalog-build.test.ts             | 152 +++++++++
 .../prompt-master/tests/plugin/registry.test.ts    |   4 +-
 6 files changed, 941 insertions(+), 2 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/catalog-build.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/catalog-build.ts
new file mode 100644
index 0000000..41cffb6
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/anima-knowledge/catalog-build.ts
@@ -0,0 +1,380 @@
+/**
+ * catalog-build.ts — anima-prompt-v1 `catalog build` 移植（4 阶段 skill-merge 的 Stage 1）。
+ *
+ * 源码忠实移植（source of truth）：
+ * - skills/anima-prompt-v1/anima_prompt_v1/catalog/builder.py（build 主链：临时文件构建 →
+ *   names/catalog_fts 填充 → VACUUM → 原子替换 → manifest 更新）
+ * - .../catalog/storage.py（CatalogStore.create_schema 目标 schema：
+ *   sources / records / names + catalog_fts FTS5）
+ * - .../catalog/facets.py（classify_category / normalize；normalize 复用
+ *   anima-catalog.normalizeTag —— 已确认与 facets.normalize 语义一致）
+ *
+ * 设计约束：
+ * - 零日志（工具层日志在 src/tools/catalog-build.ts）。
+ * - 构建打开自己的只读源连接 + 可写临时输出连接，**绝不触碰** anima-catalog.ts 的
+ *   只读缓存句柄；替换落盘后下一次 db() 经 G4 mtime 刷新自动切换到新文件。
+ * - 原子性：临时文件完整构建成功后 rename 替换（POSIX / 目标未被占用时）。
+ *   Windows 上目标被已打开 SQLite 句柄占用时 rename 报 EPERM（句柄未带
+ *   FILE_SHARE_DELETE），回退 copyFileSync 原地重写 —— 构建是同步代码，
+ *   事件循环内没有并发查询交错，进程内读者不可能观察到半成品；
+ *   G4 的 mtime 检查在下次 db() 时关闭陈旧句柄并重开。
+ */
+import { DatabaseSync } from 'node:sqlite'
+import { createHash } from 'node:crypto'
+import { closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, renameSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs'
+import { dirname, join, parse, relative, resolve } from 'node:path'
+import { normalizeTag } from '../dialect/anima-catalog.js'
+
+export interface CatalogBuildStats {
+  records: number
+  names: number
+  ftsRows: number
+}
+
+/** storage.py _TABLES —— 只有 virgin schema 幸存的表（concepts/facets/relations 已砍） */
+const TABLES = ['sources', 'records', 'names'] as const
+
+/** storage.py SCHEMA 逐条移植（FTS5 virtual table + 4 索引） */
+const SCHEMA = `
+CREATE TABLE sources (
+    source_id TEXT PRIMARY KEY,
+    name TEXT NOT NULL,
+    uri TEXT NOT NULL,
+    license TEXT NOT NULL,
+    snapshot_version TEXT NOT NULL,
+    fetched_at TEXT NOT NULL,
+    checksum TEXT NOT NULL,
+    raw_schema TEXT NOT NULL
+);
+CREATE TABLE records (
+    record_id TEXT PRIMARY KEY,
+    canonical_name TEXT NOT NULL,
+    prompt_form TEXT NOT NULL,
+    category TEXT NOT NULL,
+    description TEXT NOT NULL,
+    language_names TEXT NOT NULL,
+    confidence REAL,
+    source_ids TEXT NOT NULL,
+    provenance TEXT NOT NULL,
+    usage_count INTEGER NOT NULL,
+    deprecated INTEGER NOT NULL CHECK (deprecated IN (0, 1))
+);
+CREATE TABLE names (
+    name_id TEXT PRIMARY KEY,
+    record_id TEXT NOT NULL REFERENCES records(record_id),
+    value TEXT NOT NULL,
+    normalized_value TEXT NOT NULL,
+    name_type TEXT NOT NULL CHECK (name_type IN ('canonical', 'alias', 'translation', 'historical')),
+    language TEXT NOT NULL,
+    source_id TEXT NOT NULL REFERENCES sources(source_id)
+);
+CREATE VIRTUAL TABLE catalog_fts USING fts5(
+    name_id UNINDEXED,
+    record_id UNINDEXED,
+    value,
+    normalized_value,
+    tokenize='unicode61'
+);
+CREATE INDEX idx_records_canonical ON records(canonical_name);
+CREATE INDEX idx_records_category ON records(category);
+CREATE INDEX idx_names_normalized ON names(normalized_value);
+CREATE INDEX idx_names_record ON names(record_id);
+`
+
+/** builder.py sha256_file：流式 1MB 分块（同步，对齐 Python 逐块读） */
+export function sha256File(path: string): string {
+  const fd = openSync(path, 'r')
+  try {
+    const hash = createHash('sha256')
+    const buffer = Buffer.alloc(1024 * 1024)
+    let bytes = 0
+    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
+      hash.update(buffer.subarray(0, bytes))
+    }
+    return hash.digest('hex')
+  } finally {
+    closeSync(fd)
+  }
+}
+
+/** builder.py verify_manifest：content_filters===false 且 source/output 条目
+ *  checksum 为 64 位 hex 且与落盘文件实算一致（相对路径以 manifest 所在目录解析） */
+export function verifyManifest(manifestPath: string): boolean {
+  try {
+    const payload = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
+    if (payload.content_filters !== false) return false
+    const directory = resolve(dirname(manifestPath))
+    for (const key of ['source', 'output'] as const) {
+      const entry = payload[key]
+      if (typeof entry !== 'object' || entry === null) return false
+      const record = entry as Record<string, unknown>
+      const artifact = resolve(directory, String(record.path))
+      const checksum = record.checksum
+      if (typeof checksum !== 'string' || checksum.length !== 64) return false
+      if (!/^[0-9a-f]+$/i.test(checksum)) return false
+      if (!existsSync(artifact)) return false
+      if (sha256File(artifact) !== checksum.toLowerCase()) return false
+    }
+    return true
+  } catch {
+    return false
+  }
+}
+
+/** builder.py _clean_name：去两侧空白与下划线；保内部下划线 */
+function cleanName(value: string): string {
+  if (!value) return ''
+  return value.trim().replace(/^_+|_+$/g, '').trim()
+}
+
+/** facets.py _CATEGORY_MARKERS 逐条移植 */
+const CATEGORY_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
+  ['style', ['watercolor', 'watercolour', 'illustration', 'painting', 'sketch', 'manga', 'comic', 'render', 'cinematic']],
+  ['clothing', ['dress', 'coat', 'shirt', 'skirt', 'uniform', 'armor', 'armour', 'bodysuit', 'stockings', 'gloves', 'boots', 'shoes', 'jacket', 'pants', 'shorts', 'underwear', 'bikini', 'swimsuit', 'lingerie']],
+  ['hair', ['hair', 'ponytail', 'braid', 'bangs']],
+  ['appearance', ['eyes', 'eye', 'skin', 'face', 'breasts', 'chest', 'body', 'makeup', 'freckles', 'scar']],
+  ['expression', ['smile', 'frown', 'blush', 'crying', 'angry', 'serious']],
+  ['pose', ['standing', 'sitting', 'lying', 'kneeling', 'walking', 'running', 'pose']],
+  ['action', ['holding', 'waving', 'looking', 'fighting', 'shooting', 'touching', 'eating']],
+  ['composition', ['portrait', 'full_body', 'upper_body', 'close-up', 'closeup', 'wide_shot']],
+  ['camera', ['view', 'angle', 'depth_of_field', 'bokeh', 'lens']],
+  ['lighting', ['light', 'lighting', 'shadow', 'rim_light', 'sunlight', 'backlight']],
+  ['environment', ['sky', 'forest', 'street', 'room', 'station', 'city', 'beach', 'ruins']],
+  ['object', ['weapon', 'sword', 'gun', 'flower', 'book', 'vehicle']],
+  ['medium', ['photo', 'photorealistic', '3d', 'oil_painting']],
+  ['model', ['checkpoint', 'lora', 'embedding', 'trigger']],
+]
+
+/** facets.py classify_category：来源分类特判 → 归一化 canonical 上的标记匹配 → general */
+export function classifyCategory(canonical: string, sourceCategory: string): string {
+  if (sourceCategory === 'artist') return 'artist'
+  if (sourceCategory === 'copyright') return 'franchise'
+  if (sourceCategory === 'character') return 'character'
+  if (sourceCategory === 'quality') return 'quality'
+  if (sourceCategory === 'meta') return 'meta'
+  if (sourceCategory === 'safety') return 'nsfw'
+  const normalized = normalizeTag(canonical)
+  for (const [category, markers] of CATEGORY_MARKERS) {
+    for (const marker of markers) {
+      // re.search(rf"(?:^| ){re.escape(marker.replace('_',' '))}(?:$| )") 的移植
+      const pattern = '(?:^| )' + marker.replaceAll('_', ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$| )'
+      if (new RegExp(pattern).test(normalized)) return category
+    }
+  }
+  return 'general'
+}
+
+/** builder.py：with_suffix(output.suffix + ".tmp") —— tag-catalog.sqlite → tag-catalog.sqlite.tmp */
+function tempPathFor(outputPath: string): string {
+  const parsed = parse(outputPath)
+  return join(parsed.dir, parsed.name + (parsed.ext ? parsed.ext + '.tmp' : '.sqlite.tmp'))
+}
+
+/** builder.py _build_from_raw_tags：tags/aliases 源表快照 → 归并分组 → 主记录 + 别名重映射 */
+function buildFromRawTags(source: DatabaseSync, output: DatabaseSync, sourcePath: string): void {
+  const sourceChecksum = sha256File(sourcePath)
+  const aliasesRaw = source
+    .prepare('SELECT alias, tag_id, source FROM aliases ORDER BY tag_id, alias, source')
+    .all() as Array<{ alias: string; tag_id: number; source: string }>
+
+  const seen = new Map<string, [string, string]>()
+  for (const row of source.prepare('SELECT DISTINCT source, source_version FROM tags').all() as Array<{ source: string; source_version: string }>) {
+    seen.set(`${row.source}\u0000${row.source_version}`, [row.source, row.source_version])
+  }
+  for (const a of aliasesRaw) seen.set(`${a.source}\u0000unknown`, [a.source, 'unknown'])
+  const sourceRows = [...seen.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
+
+  const insertSource = output.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
+  for (const [name, version] of sourceRows) {
+    insertSource.run(`${name}:${version}`, name, '', 'unknown', version, '', sourceChecksum, 'tags.sqlite + aliases')
+  }
+  const sourceIds = new Map(sourceRows.map(([name, version]) => [`${name}:${version}`, `${name}:${version}`]))
+
+  const tags = source
+    .prepare('SELECT tag_id, canonical, anima_form, category, usage_count, source, source_version FROM tags ORDER BY tag_id')
+    .all() as Array<{
+    tag_id: number
+    canonical: string
+    anima_form: string
+    category: string
+    usage_count: number
+    source: string
+    source_version: string
+  }>
+
+  // 清洗 canonical 后按归一化形式分组：脏重复（bodysuit / bodysuit_、1girl / _1girl）
+  // 坍缩成一个 record，避免并行 score-1000 命中。
+  const groups = new Map<string, Array<{ tag_id: string; canonical: string; prompt_form: string; category: string; usage: number; source_id: string }>>()
+  for (const row of tags) {
+    const cleanCanonical = cleanName(row.canonical)
+    if (!cleanCanonical) continue
+    const norm = normalizeTag(cleanCanonical)
+    const promptForm = row.anima_form ? cleanName(row.anima_form) : ''
+    const sourceId = sourceIds.get(`${row.source}:${row.source_version}`) ?? `${row.source}:${row.source_version}`
+    const list = groups.get(norm)
+    const member = {
+      tag_id: String(row.tag_id),
+      canonical: cleanCanonical,
+      prompt_form: promptForm || cleanCanonical,
+      category: classifyCategory(cleanCanonical, row.category),
+      usage: Number(row.usage_count) || 0,
+      source_id: sourceId,
+    }
+    if (list) list.push(member)
+    else groups.set(norm, [member])
+  }
+
+  // 每组主记录：最高 usage → 最短 canonical → tag_id 字面（对齐 Python str 比较）；
+  // 被丢成员的 tag_id 重映射到主记录，别名得以存活。
+  const remap = new Map<string, string>()
+  const records: Array<{ tag_id: string; canonical: string; prompt_form: string; category: string; usage: number; source_id: string }> = []
+  for (const members of groups.values()) {
+    members.sort((a, b) => b.usage - a.usage || a.canonical.length - b.canonical.length || (a.tag_id < b.tag_id ? -1 : a.tag_id > b.tag_id ? 1 : 0))
+    const primary = members[0]
+    for (const member of members) remap.set(member.tag_id, primary.tag_id)
+    records.push(primary)
+  }
+
+  const insertRecord = output.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
+  for (const rec of records) {
+    // provenance sort_keys=True → raw_record_id 先于 source_id
+    const provenance = { raw_record_id: rec.tag_id, source_id: rec.source_id }
+    insertRecord.run(
+      rec.tag_id, rec.canonical, rec.prompt_form, rec.category, '', '[]', null,
+      JSON.stringify([rec.source_id]), JSON.stringify(provenance), rec.usage, 0,
+    )
+  }
+
+  // names：每条 record 一个 canonical，加别名（重映射后清洗去重）；与 canonical 撞
+  // 归一化形式的别名丢弃（canonical 胜）。
+  const canonicalNorms = new Set(groups.keys())
+  const names: Array<[string, string, string, string, string, string, string]> = []
+  for (const rec of records) {
+    names.push([`canonical:${rec.tag_id}`, rec.tag_id, rec.canonical, normalizeTag(rec.canonical), 'canonical', '', rec.source_id])
+  }
+  const aliasSeen = new Map<string, [string, string, string]>() // norm → (mapped_id, value, alias_source)
+  for (const a of aliasesRaw) {
+    const cleanAlias = cleanName(a.alias)
+    if (!cleanAlias) continue
+    const norm = normalizeTag(cleanAlias)
+    if (canonicalNorms.has(norm)) continue
+    const mappedId = remap.get(String(a.tag_id)) ?? String(a.tag_id)
+    if (!aliasSeen.has(norm)) aliasSeen.set(norm, [mappedId, cleanAlias, a.source])
+  }
+  const aliasByRecord = new Map<string, Array<[string, string, string]>>()
+  for (const [norm, [mappedId, value, aliasSource]] of aliasSeen) {
+    const list = aliasByRecord.get(mappedId)
+    const item: [string, string, string] = [norm, value, aliasSource]
+    if (list) list.push(item)
+    else aliasByRecord.set(mappedId, [item])
+  }
+  let index = 0
+  const insertName = output.prepare('INSERT INTO names VALUES (?, ?, ?, ?, ?, ?, ?)')
+  for (const [mappedId, items] of aliasByRecord) {
+    for (const [norm, value, aliasSource] of items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
+      index += 1
+      const sourceId = sourceIds.get(`${aliasSource}:unknown`) ?? `${aliasSource}:unknown`
+      names.push([`alias:${mappedId}:${index}`, mappedId, value, norm, 'alias', '', sourceId])
+    }
+  }
+  for (const n of names) insertName.run(...n)
+}
+
+/** builder.py _copy_normalized：幸存表整表拷贝；列集合不齐（legacy schema）→ 故意抛错 */
+function copyNormalized(source: DatabaseSync, output: DatabaseSync): void {
+  for (const table of TABLES) {
+    const columns = (source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
+    if (!columns.length) throw new Error(`source catalog missing required table: ${table}`)
+    const expected = (output.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
+    if (columns.join('\u0000') !== expected.join('\u0000')) {
+      throw new Error(`source table ${table} does not use the current schema`)
+    }
+    const rows = source.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.join(', ')}`).all()
+    const placeholders = columns.map(() => '?').join(', ')
+    const insert = output.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
+    for (const row of rows) insert.run(...Object.values(row))
+  }
+}
+
+/** builder.py build 主链 + 原子替换（详见文件头注释，Windows rename 回退说明） */
+export function buildCatalog(options: { sourcePath: string; outputPath: string; manifestPath?: string }): CatalogBuildStats {
+  const { sourcePath, outputPath } = options
+  if (!existsSync(sourcePath)) throw new Error(`catalog source not found: ${sourcePath}`)
+  if (resolve(sourcePath) === resolve(outputPath)) throw new Error('output must not overwrite source')
+  mkdirSync(dirname(outputPath), { recursive: true })
+  const temporary = tempPathFor(outputPath)
+  try {
+    unlinkSync(temporary)
+  } catch {
+    /* unlink(missing_ok=True) */
+  }
+  const source = new DatabaseSync(sourcePath, { readOnly: true })
+  const outputDb = new DatabaseSync(temporary)
+  try {
+    outputDb.exec('PRAGMA foreign_keys = ON')
+    outputDb.exec(SCHEMA)
+    const sourceTables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name))
+    outputDb.exec('BEGIN')
+    if (sourceTables.has('tags') && sourceTables.has('aliases')) buildFromRawTags(source, outputDb, sourcePath)
+    else copyNormalized(source, outputDb)
+    const ftsRows = outputDb
+      .prepare('SELECT name_id, record_id, value, normalized_value FROM names ORDER BY normalized_value, name_id')
+      .all() as Array<{ name_id: string; record_id: string; value: string; normalized_value: string }>
+    const insertFts = outputDb.prepare('INSERT INTO catalog_fts VALUES (?, ?, ?, ?)')
+    for (const r of ftsRows) insertFts.run(r.name_id, r.record_id, r.value, r.normalized_value)
+    outputDb.exec('COMMIT')
+    // VACUUM：node:sqlite DatabaseSync.exec('VACUUM') 在 Node 24 上可用（已验证）。
+    // 事务已提交 → VACUUM 在事务外执行（对齐 builder.py 的 commit 后再 VACUUM）。
+    outputDb.exec('VACUUM')
+  } finally {
+    source.close()
+    outputDb.close()
+  }
+  try {
+    // os.replace 移植：POSIX 直接替换；Windows 目标被已打开 SQLite 句柄占用（无
+    // FILE_SHARE_DELETE）时 rename 报 EPERM → 回退 copyFileSync 原地重写（同步构建，
+    // 进程内不可能交错读取；G4 mtime 刷新处理陈旧句柄）。
+    renameSync(temporary, outputPath)
+  } catch (e) {
+    copyFileSync(temporary, outputPath)
+  }
+  try {
+    unlinkSync(temporary)
+  } catch {
+    /* cleanup */
+  }
+  const stats = collectStats(outputPath)
+  if (options.manifestPath !== undefined) writeManifest(options.manifestPath, sourcePath, outputPath)
+  return stats
+}
+
+/** builder.py _stats：records / names / catalog_fts 三计数（只读重开输出文件） */
+function collectStats(outputPath: string): CatalogBuildStats {
+  const db = new DatabaseSync(outputPath, { readOnly: true })
+  try {
+    const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
+    return { records: count('records'), names: count('names'), ftsRows: count('catalog_fts') }
+  } finally {
+    db.close()
+  }
+}
+
+/** builder.py _write_manifest + _manifest_artifact_path（相对 manifest 目录；跨盘回退绝对路径） */
+function writeManifest(manifestPath: string, sourcePath: string, outputPath: string): void {
+  mkdirSync(dirname(manifestPath), { recursive: true })
+  const directory = resolve(dirname(manifestPath))
+  const payload = {
+    content_filters: false,
+    output: { path: manifestArtifactPath(outputPath, directory), checksum: sha256File(outputPath) },
+    source: { path: manifestArtifactPath(sourcePath, directory), checksum: sha256File(sourcePath) },
+  }
+  writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
+}
+
+function manifestArtifactPath(artifact: string, directory: string): string {
+  try {
+    return relative(directory, resolve(artifact))
+  } catch {
+    return resolve(artifact)
+  }
+}
\ No newline at end of file
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
index 8db593d..0f4c467 100644
--- a/plugins/prompt-master/src/plugin/index.ts
+++ b/plugins/prompt-master/src/plugin/index.ts
@@ -2,20 +2,21 @@ import z from '@deepseek-ai/schemastery'
 import type { Context } from '@deepseek-ai/cordis'
 import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
 import { registerExpandTool } from '../tools/prompt-expand.js'
 import { registerReverseTool } from '../tools/prompt-reverse.js'
 import { registerMinimaxTool } from '../tools/minimax-scenario.js'
 import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
 import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
 import { registerCompileTool } from '../tools/prompt-compile.js'
 import { registerCatalogSearchTool } from '../tools/catalog-search.js'
 import { registerCatalogRelationsTool } from '../tools/catalog-relations.js'
+import { registerCatalogBuildTool } from '../tools/catalog-build.js'
 import { registerAuditTool } from '../tools/prompt-audit.js'
 import { setCustomProfileSource } from '../resolver/profiles/source.js'
 import { setBuiltinFilter } from '../resolver/profiles/index.js'
 import { registerOverridesNamespace } from '../pe-framework/profiles/storage-v2.js'
 import '../pe-framework/dialect/anima.js'
 import '../pe-framework/dialect/h3.js'
 import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
 import { setPresetRoot } from '../pe-framework/resources/resolve.js'
 import { Config, type Config as ConfigShape } from './config.js'
 
@@ -57,14 +58,15 @@ export function apply(ctx: Context, config: ConfigShape) {
   ctx.effect(() => {
     const disposers: (() => void)[] = []
     disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
     disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
     disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
     disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope, overrides })))
     disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
     disposers.push(ctx.tools.register(registerCompileTool(ctx)))
     disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
     disposers.push(ctx.tools.register(registerCatalogRelationsTool(ctx, config)))
+    disposers.push(ctx.tools.register(registerCatalogBuildTool(ctx, config)))
     disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
     return () => { for (const d of disposers) d() }
   }, 'prompt-master.tools')
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/catalog-build.ts b/plugins/prompt-master/src/tools/catalog-build.ts
new file mode 100644
index 0000000..656eeb1
--- /dev/null
+++ b/plugins/prompt-master/src/tools/catalog-build.ts
@@ -0,0 +1,74 @@
+import { defineTool } from '@deepseek-ai/dsh-tools'
+import type { Context } from '@deepseek-ai/cordis'
+import { resolve as pathResolve } from 'node:path'
+import { buildCatalog } from '../pe-framework/anima-knowledge/catalog-build.js'
+import { resolveKnowledgePath } from '../pe-framework/resources/resolve.js'
+import type { Config } from '../plugin/config.js'
+
+type LogCtx = { logger?: { info?: (msg: string) => void } }
+const logInfo = (ctx: Context | null, msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
+
+function defaultSource(): string {
+  return resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tags.sqlite' })
+}
+function defaultOutput(): string {
+  return resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
+}
+function defaultManifest(): string {
+  return resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'manifest.json' })
+}
+
+/**
+ * catalog_build —— anima-prompt-v1 `catalog build` 动作的替代面（Stage 1 skill-merge）。
+ * 默认路径全部经 resolveKnowledgePath 推导（无硬编码）：Stage 2 把 knowledge 目录
+ * 迁到 assets/knowledge/ 时本工具无需改动。
+ * manifest 仅跟随默认就地重建（output == 默认 tag-catalog.sqlite）时更新；
+ * 自定义 output 不写 manifest，避免污染真实资产清单。
+ * 纯库零日志；本层只打 action 摘要。
+ */
+export function registerCatalogBuildTool(ctx: Context, _config: Config) {
+  return defineTool({
+    name: 'catalog_build',
+    description:
+      '从 tags.sqlite 重建 Anima tag-catalog（临时文件 → FTS5 填充 → VACUUM → 原子替换），' +
+      '替换后用 G4 mtime 刷新让 catalog_search 自动读新文件；默认同时重写 manifest.json。',
+    parameters: {
+      source: { type: 'string', description: '源 tags.sqlite 路径（默认 resolveKnowledgePath: skills/anima-prompt-v1/knowledge/tags.sqlite）' },
+      output: { type: 'string', description: '输出 tag-catalog.sqlite 路径（默认 resolveKnowledgePath: .../tag-catalog.sqlite）' },
+    },
+    output: {
+      schema: { type: 'string', description: 'Envelope JSON {ok, stats?, errors?}' },
+      render: (_a, v) => [{ type: 'text', text: v }],
+    },
+    async execute(args: { source?: string; output?: string }) {
+      const sourcePath = args.source?.trim() ? pathResolve(args.source) : defaultSource()
+      const writtenOutput = args.output?.trim() ? pathResolve(args.output) : defaultOutput()
+      const outputPath = writtenOutput
+      // manifest 仅当目标是默认 knowledge catalog（就地重建）时更新
+      const manifestPath = pathResolve(outputPath) === pathResolve(defaultOutput()) ? defaultManifest() : undefined
+      try {
+        const stats = buildCatalog({ sourcePath, outputPath, manifestPath })
+        logInfo(
+          ctx,
+          `[prompt-master] catalog_build action=build records=${stats.records} names=${stats.names} ftsRows=${stats.ftsRows} output=${outputPath}`,
+        )
+        return JSON.stringify({
+          ok: true,
+          stats,
+          source: sourcePath,
+          output: outputPath,
+          manifest: manifestPath ?? null,
+        })
+      } catch (e) {
+        const message = e instanceof Error ? e.message : String(e)
+        const code = /not found/i.test(message)
+          ? 'input_file_missing'
+          : /must not overwrite source/i.test(message)
+            ? 'argument_error'
+            : 'catalog_build_failed'
+        logInfo(ctx, `[prompt-master] catalog_build failed code=${code} ${message}`)
+        return JSON.stringify({ ok: false, errors: [{ code, message }] })
+      }
+    },
+  })
+}
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/anima-knowledge/catalog-build.test.ts b/plugins/prompt-master/tests/pe-framework/anima-knowledge/catalog-build.test.ts
new file mode 100644
index 0000000..2da5b95
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/anima-knowledge/catalog-build.test.ts
@@ -0,0 +1,331 @@
+import { describe, expect, it, afterEach, beforeAll } from 'vitest'
+import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { dirname, join, sep } from 'node:path'
+import { DatabaseSync } from 'node:sqlite'
+import {
+  buildCatalog,
+  classifyCategory,
+  sha256File,
+  verifyManifest,
+  type CatalogBuildStats,
+} from '../../../src/pe-framework/anima-knowledge/catalog-build.js'
+import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
+import { setCatalogPath, closeCatalog, searchCatalog, _testOnlyState } from '../../../src/pe-framework/dialect/anima-catalog.js'
+
+/**
+ * catalog-build —— builder.py 移植 纯库测试。
+ * Fixture-first：tiny tags.sqlite（真实 schema 形状，2 源 5 有效 tag + 3 alias）
+ * → build → 断言 stats / fts parity / 归并去重 / 别名重映射 / manifest。
+ * 真实 204MB 资产全量重建走 PM_RUN_REAL=1 opt-in smoke（vitest 30s 内装不下完整 build）。
+ */
+
+/** 真实 tags.sqlite 形状的最小 fixture（含验证专用脏数据）；可重复调用（drop 后重建） */
+function makeTagsSource(dbPath: string, extra?: Array<[number, string, string, string, number, string, string, string]>): void {
+  mkdirSync(dirname(dbPath), { recursive: true })
+  const db = new DatabaseSync(dbPath)
+  db.exec(`
+    DROP TABLE IF EXISTS aliases;
+    DROP TABLE IF EXISTS tags;
+    CREATE TABLE tags (
+      tag_id INTEGER PRIMARY KEY,
+      canonical TEXT NOT NULL UNIQUE,
+      anima_form TEXT NOT NULL,
+      category TEXT NOT NULL,
+      usage_count INTEGER NOT NULL,
+      source TEXT NOT NULL,
+      source_version TEXT NOT NULL,
+      verification_status TEXT NOT NULL
+    );
+    CREATE TABLE aliases (
+      alias TEXT NOT NULL,
+      tag_id INTEGER NOT NULL REFERENCES tags(tag_id),
+      source TEXT NOT NULL,
+      confidence REAL NOT NULL,
+      PRIMARY KEY(alias, tag_id)
+    );
+  `)
+  const insTag = db.prepare('INSERT INTO tags VALUES (?,?,?,?,?,?,?,?)')
+  insTag.run(1, '1girl', '1girl', 'general', 1000, 'danbooru', 'v1', 'danbooru_canonical')
+  // 脏重复：bodysuit_（低 usage）与 bodysuit（高 usage）归一化后坍缩成 record 3（主）
+  insTag.run(2, 'bodysuit_', 'bodysuit', 'clothing', 500, 'danbooru', 'v1', 'danbooru_canonical')
+  insTag.run(3, 'bodysuit', 'bodysuit', 'clothing', 900, 'danbooru', 'v1', 'danbooru_canonical')
+  // 脏下划线前缀 canonical
+  insTag.run(4, '_long_black_hair', 'long_black_hair', 'hair', 700, 'danbooru', 'v1', 'danbooru_canonical')
+  insTag.run(5, 'wave', 'wave', 'general', 4000, 'danbooru', 'v1', 'danbooru_canonical')
+  // 空 canonical → 被跳过，不入 records
+  insTag.run(6, '', '', 'general', 9, 'gelbooru_canonical', 'v1', 'gelbooru_canonical')
+  for (const row of extra ?? []) insTag.run(...row)
+  const insAlias = db.prepare('INSERT INTO aliases VALUES (?,?,?,?)')
+  insAlias.run('waving', 5, 'danbooru', 0.85)
+  // 撞 canonical 归一化形式的别名（bodysuit_ → bodysuit）→ 丢弃
+  insAlias.run('bodysuit_', 2, 'danbooru', 0.9)
+  insAlias.run('long hair', 4, 'danbooru', 0.8)
+  db.close()
+}
+
+function countOf(dbPath: string, table: string): number {
+  const db = new DatabaseSync(dbPath, { readOnly: true })
+  try {
+    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
+  } finally {
+    db.close()
+  }
+}
+
+let baseTmp: string
+
+beforeAll(() => {
+  baseTmp = mkdtempSync(join(tmpdir(), 'pm-catbuild-'))
+})
+
+afterEach(() => {
+  closeCatalog()
+  setCatalogPath(process.env.ANIMA_CATALOG_PATH ?? '')
+  delete (process.env as Record<string, string | undefined>).ANIMA_CATALOG_PATH
+  setPresetRoot(undefined)
+})
+
+describe('buildCatalog — tiny tags.sqlite fixture (raw-tags branch)', () => {
+  it('stats/records/names/fts 计数正确（归并去重 + 别名存活 + 空 canonical 跳过）', () => {
+    const dir = join(baseTmp, 'raw1')
+    const sourcePath = join(dir, 'tags.sqlite')
+    const outputPath = join(dir, 'tag-catalog.sqlite')
+    makeTagsSource(sourcePath)
+    const stats = buildCatalog({ sourcePath, outputPath })
+    expect(stats).toEqual({ records: 4, names: 6, ftsRows: 6 } satisfies CatalogBuildStats)
+    // fts parity：catalog_fts 行数 == names 行数
+    expect(countOf(outputPath, 'catalog_fts')).toBe(6)
+    expect(countOf(outputPath, 'records')).toBe(4)
+    expect(countOf(outputPath, 'names')).toBe(6)
+    // sources：alias 源补 unknown 版本 → (danbooru,unknown) (danbooru,v1) (gelbooru_canonical,v1)
+    expect(countOf(outputPath, 'sources')).toBe(3)
+    // 四表齐备（FTS5 另有 5 个 catalog_fts_* 内部影子表，不列入）
+    const tables = new DatabaseSync(outputPath, { readOnly: true })
+      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
+      .all()
+      .map((r) => (r as { name: string }).name)
+      .sort()
+    const expectedTables = ['catalog_fts', 'names', 'records', 'sources']
+    for (const t of expectedTables) expect(tables).toContain(t)
+    expect(tables.filter((t) => !t.startsWith('catalog_fts_'))).toEqual(expectedTables)
+  })
+
+  it('脏重复坍缩成主记录，别名重映射到主 record', () => {
+    const dir = join(baseTmp, 'raw2')
+    const outputPath = join(dir, 'tag-catalog.sqlite')
+    makeTagsSource(join(dir, 'tags.sqlite'))
+    buildCatalog({ sourcePath: join(dir, 'tags.sqlite'), outputPath })
+    const db = new DatabaseSync(outputPath, { readOnly: true })
+    try {
+      // bodysuit_ + bodysuit → 单 record（主 = usage 900 的 tag 3）
+      const bodysuit = db.prepare("SELECT record_id, canonical_name, prompt_form, category, usage_count FROM records WHERE canonical_name='bodysuit'").get() as {
+        record_id: string
+        canonical_name: string
+        prompt_form: string
+        category: string
+        usage_count: number
+      }
+      expect(bodysuit.record_id).toBe('3')
+      expect(bodysuit.prompt_form).toBe('bodysuit')
+      expect(bodysuit.category).toBe('clothing')
+      expect(bodysuit.usage_count).toBe(900)
+      // canonical 名带内部下划线保留（_long_black_hair → long_black_hair）
+      const longHair = db.prepare("SELECT canonical_name FROM records WHERE record_id='4'").get() as { canonical_name: string }
+      expect(longHair.canonical_name).toBe('long_black_hair')
+      // 别名：waving → record 5；long hair → record 4（重映射后存活）
+      const waving = db.prepare("SELECT record_id, normalized_value FROM names WHERE value='waving'").get() as { record_id: string }
+      expect(waving.record_id).toBe('5')
+      const longHairAlias = db.prepare("SELECT record_id FROM names WHERE value='long hair'").get() as { record_id: string }
+      expect(longHairAlias.record_id).toBe('4')
+      // 撞 canonical 的别名被丢弃：names 无 bodysuit_ 别名行
+      expect(db.prepare("SELECT COUNT(*) AS n FROM names WHERE name_type='alias'").get()).toEqual({ n: 2 })
+    } finally {
+      db.close()
+    }
+  })
+
+  it('FTS 可检索：build 产物 catalog_fts MATCH 命中原行', () => {
+    const dir = join(baseTmp, 'raw3')
+    const outputPath = join(dir, 'tag-catalog.sqlite')
+    makeTagsSource(join(dir, 'tags.sqlite'))
+    buildCatalog({ sourcePath: join(dir, 'tags.sqlite'), outputPath })
+    const db = new DatabaseSync(outputPath, { readOnly: true })
+    try {
+      const hits = db.prepare("SELECT record_id FROM catalog_fts WHERE catalog_fts MATCH 'waving'").all()
+      expect(hits.length).toBeGreaterThan(0)
+    } finally {
+      db.close()
+    }
+  })
+
+  it('manifest：build + manifestPath → manifest 重写且 verifyManifest 通过；篡改后失败', () => {
+    const dir = join(baseTmp, 'raw4')
+    const sourcePath = join(dir, 'tags.sqlite')
+    const outputPath = join(dir, 'tag-catalog.sqlite')
+    const manifestPath = join(dir, 'manifest.json')
+    makeTagsSource(sourcePath)
+    buildCatalog({ sourcePath, outputPath, manifestPath })
+    const payload = JSON.parse(readFileSync(manifestPath, 'utf8')) as { content_filters: boolean; source: { path: string; checksum: string }; output: { path: string; checksum: string } }
+    expect(payload.content_filters).toBe(false)
+    expect(payload.source.path).toBe('tags.sqlite')
+    expect(payload.output.path).toBe('tag-catalog.sqlite')
+    expect(payload.source.checksum).toBe(sha256File(sourcePath))
+    expect(payload.output.checksum).toBe(sha256File(outputPath))
+    expect(verifyManifest(manifestPath)).toBe(true)
+    // 篡改 output checksum → verify false
+    writeFileSync(manifestPath, JSON.stringify({ ...payload, output: { ...payload.output, checksum: '0'.repeat(64) } }), 'utf8')
+    expect(verifyManifest(manifestPath)).toBe(false)
+  })
+
+  it('错误分支：源不存在 / output 与 source 同路径', () => {
+    const dir = join(baseTmp, 'raw5')
+    const sourcePath = join(dir, 'tags.sqlite')
+    const outputPath = join(dir, 'tag-catalog.sqlite')
+    expect(() => buildCatalog({ sourcePath: join(dir, 'nope.sqlite'), outputPath })).toThrow(/not found/)
+    makeTagsSource(sourcePath)
+    expect(() => buildCatalog({ sourcePath, outputPath: sourcePath })).toThrow(/must not overwrite source/)
+    // 失败不落盘（无 output、无 temp 残留）
+    expect(existsSync(outputPath)).toBe(false)
+    expect(existsSync(outputPath + '.tmp')).toBe(false)
+  })
+})
+
+describe('classifyCategory / normalize（facets.py 移植）', () => {
+  it('来源分类特判映射', () => {
+    expect(classifyCategory('x', 'artist')).toBe('artist')
+    expect(classifyCategory('x', 'copyright')).toBe('franchise')
+    expect(classifyCategory('x', 'character')).toBe('character')
+    expect(classifyCategory('x', 'quality')).toBe('quality')
+    expect(classifyCategory('x', 'meta')).toBe('meta')
+    expect(classifyCategory('x', 'safety')).toBe('nsfw')
+  })
+  it('标记匹配（归一化后 ^/$/space 边界）', () => {
+    expect(classifyCategory('watercolor', 'general')).toBe('style')
+    expect(classifyCategory('1girl watercolor', 'general')).toBe('style')
+    expect(classifyCategory('long_black_hair', 'general')).toBe('hair')
+    expect(classifyCategory('full_body', 'general')).toBe('appearance') // facets 顺序：appearance('body') 在 composition 之前命中
+    expect(classifyCategory('depth_of_field', 'general')).toBe('camera')
+    expect(classifyCategory('standing pose', 'general')).toBe('pose')
+    expect(classifyCategory('holding a sword', 'general')).toBe('action')
+    expect(classifyCategory('blue_sky', 'general')).toBe('environment')
+    expect(classifyCategory('photorealistic', 'general')).toBe('medium')
+    expect(classifyCategory('something_else', 'general')).toBe('general')
+  })
+})
+
+describe('copyNormalized 分支（legacy tag-catalog 形状源）', () => {
+  const SCHEMA = `
+    CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL, uri TEXT NOT NULL, license TEXT NOT NULL, snapshot_version TEXT NOT NULL, fetched_at TEXT NOT NULL, checksum TEXT NOT NULL, raw_schema TEXT NOT NULL);
+    CREATE TABLE records (record_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, prompt_form TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, language_names TEXT NOT NULL, confidence REAL, source_ids TEXT NOT NULL, provenance TEXT NOT NULL, usage_count INTEGER NOT NULL, deprecated INTEGER NOT NULL CHECK (deprecated IN (0, 1)));
+    CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(record_id), value TEXT NOT NULL, normalized_value TEXT NOT NULL, name_type TEXT NOT NULL CHECK (name_type IN ('canonical', 'alias', 'translation', 'historical')), language TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(source_id));
+  `
+
+  function makeCatalogSource(dbPath: string, mutate?: (db: DatabaseSync) => void): void {
+    mkdirSync(dirname(dbPath), { recursive: true })
+    const db = new DatabaseSync(dbPath)
+    db.exec(SCHEMA)
+    db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)').run('src:1', 'src', '', '', '1', '', 'abc', 'raw')
+    db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('r1', 'smile', 'smile', 'general', '', '[]', null, '["src:1"]', '{}', 10, 0)
+    db.prepare('INSERT INTO names VALUES (?,?,?,?,?,?,?)').run('n1', 'r1', 'smile', 'smile', 'canonical', '', 'src:1')
+    if (mutate) mutate(db)
+    db.close()
+  }
+
+  it('与当前 schema 一致的 legacy 源 → 整表拷贝（无 tags/aliases → copy 分支）', () => {
+    const dir = join(baseTmp, 'copy1')
+    const sourcePath = join(dir, 'legacy-catalog.sqlite')
+    const outputPath = join(dir, 'tag-catalog.sqlite')
+    makeCatalogSource(sourcePath)
+    const stats = buildCatalog({ sourcePath, outputPath })
+    // sources/records/names 各 1 行；fts 填充 names
+    expect(stats).toEqual({ records: 1, names: 1, ftsRows: 1 })
+    const db = new DatabaseSync(outputPath, { readOnly: true })
+    try {
+      expect(db.prepare("SELECT canonical_name FROM records WHERE record_id='r1'").get()).toEqual({ canonical_name: 'smile' })
+      expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_fts WHERE catalog_fts MATCH 'smile'").get()).toEqual({ n: 1 })
+    } finally {
+      db.close()
+    }
+  })
+
+  it('列集合不齐 → 故意抛错（legacy schema 拒绝，不把死表带过来）', () => {
+    const dir = join(baseTmp, 'copy2')
+    const sourcePath = join(dir, 'legacy-catalog.sqlite')
+    const outputPath = join(dir, 'tag-catalog.sqlite')
+    makeCatalogSource(sourcePath, (db) => db.exec('ALTER TABLE records DROP COLUMN provenance'))
+    expect(() => buildCatalog({ sourcePath, outputPath })).toThrow(/does not use the current schema/)
+  })
+})
+
+describe('G4 交互：rebuild 后 catalog_search 自动读新文件（mtime 刷新，不动缓存句柄）', () => {
+  it('build → searchCatalog 返回新行；build 自身不触碰缓存句柄', () => {
+    const root = join(baseTmp, 'g4')
+    const sourcePath = join(root, 'skills', 'anima-prompt-v1', 'knowledge', 'tags.sqlite')
+    const outputPath = join(root, 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite')
+    setPresetRoot(root) // manifest 对账落到 tmp（无 manifest.json → fail-fast，不哈希真实 820MB 库）
+    makeTagsSource(sourcePath)
+
+    // build v1 → 打开缓存句柄
+    buildCatalog({ sourcePath, outputPath })
+    setCatalogPath(outputPath)
+    expect(searchCatalog('waving').map((h) => h.record_id)).toContain('5')
+    expect(_testOnlyState().dbGeneration).toBe(1)
+
+    // 追加新 tag 后 rebuild（同一 output 路径）
+    makeTagsSource(sourcePath, [[7, 'nekomimi', 'nekomimi', 'character', 10, 'danbooru', 'v1', 'danbooru_canonical']])
+    const stats = buildCatalog({ sourcePath, outputPath })
+    expect(stats.records).toBe(5)
+    // build 自身不能触碰缓存句柄（gen 不因 build 而变化）
+    expect(_testOnlyState().dbGeneration).toBe(1)
+
+    // 模拟真实重建必然带来的 mtime 位移（新 inode / NTFS 高精时间戳；显式 bump 去 flake）
+    const future = new Date(Date.now() + 60_000)
+    utimesSync(outputPath, future, future)
+
+    // 下一次查询：G4 mtime 刷新 → 关闭陈旧句柄重开 → 自动读新文件
+    const hits = searchCatalog('nekomimi', { mode: 'exact' })
+    expect(hits.map((h) => h.record_id)).toContain('7')
+    expect(_testOnlyState().dbGeneration).toBe(2)
+  })
+})
+
+// ---- 真实资产 opt-in smoke（PM_RUN_REAL=1；完整 build 1-3 分钟，超过 vitest 默认 30s）----
+
+function realPresetRoot(): string {
+  const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
+  const parts = here.split(/[\\/]/)
+  for (let i = 0; i < parts.length - 1; i++) {
+    if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') return parts.slice(0, i).join(sep)
+  }
+  throw new Error('cannot locate preset root from test location')
+}
+
+describe.skipIf(process.env.PM_RUN_REAL !== '1')('real tags.sqlite full rebuild (opt-in: PM_RUN_REAL=1)', () => {
+  it(
+    '204MB tags.sqlite → tmp tag-catalog：stats 规模 + fts parity + search 命中',
+    { timeout: 300_000 },
+    async () => {
+      const sourcePath = join(realPresetRoot(), 'skills', 'anima-prompt-v1', 'knowledge', 'tags.sqlite')
+      expect(existsSync(sourcePath)).toBe(true)
+      const dir = join(baseTmp, 'real-out')
+      const outputPath = join(dir, 'tag-catalog.sqlite')
+      const stats = buildCatalog({ sourcePath, outputPath })
+      expect(stats.records).toBeGreaterThan(1_000_000)
+      expect(stats.names).toBeGreaterThan(1_000_000)
+      expect(stats.ftsRows).toBe(stats.names)
+      expect(countOf(outputPath, 'catalog_fts')).toBe(stats.names)
+      // rebuild 产物可检索
+      setCatalogPath(outputPath)
+      expect(searchCatalog('1girl', { mode: 'exact' }).length).toBeGreaterThan(0)
+    },
+  )
+
+  afterEach(() => {
+    // searchCatalog 打开过 output 的缓存句柄（无 FILE_SHARE_DELETE）→ 先关句柄再删目录
+    closeCatalog()
+    setCatalogPath('')
+    const dir = join(baseTmp, 'real-out')
+    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
+  })
+})
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/plugin/catalog-build.test.ts b/plugins/prompt-master/tests/plugin/catalog-build.test.ts
new file mode 100644
index 0000000..eb67ccf
--- /dev/null
+++ b/plugins/prompt-master/tests/plugin/catalog-build.test.ts
@@ -0,0 +1,152 @@
+import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { DatabaseSync } from 'node:sqlite'
+import { registerCatalogBuildTool } from '../../src/tools/catalog-build.js'
+import { stubCtx, runTool } from './helpers.js'
+import { setPresetRoot } from '../../src/pe-framework/resources/resolve.js'
+import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'
+import { verifyManifest } from '../../src/pe-framework/anima-knowledge/catalog-build.js'
+
+const cfg = { temperature: 0.7 }
+const def = () => registerCatalogBuildTool(null as never, cfg as never)
+
+/** 真实 tags.sqlite 形状的最小结余 fixture（3 tag + 1 alias） */
+function seedTagsSource(dbPath: string): void {
+  const db = new DatabaseSync(dbPath)
+  db.exec(`
+    CREATE TABLE tags (
+      tag_id INTEGER PRIMARY KEY,
+      canonical TEXT NOT NULL UNIQUE,
+      anima_form TEXT NOT NULL,
+      category TEXT NOT NULL,
+      usage_count INTEGER NOT NULL,
+      source TEXT NOT NULL,
+      source_version TEXT NOT NULL,
+      verification_status TEXT NOT NULL
+    );
+    CREATE TABLE aliases (
+      alias TEXT NOT NULL,
+      tag_id INTEGER NOT NULL REFERENCES tags(tag_id),
+      source TEXT NOT NULL,
+      confidence REAL NOT NULL,
+      PRIMARY KEY(alias, tag_id)
+    );
+  `)
+  const insTag = db.prepare('INSERT INTO tags VALUES (?,?,?,?,?,?,?,?)')
+  insTag.run(1, '1girl', '1girl', 'general', 1000, 'danbooru', 'v1', 'danbooru_canonical')
+  insTag.run(2, 'wave', 'wave', 'general', 4000, 'danbooru', 'v1', 'danbooru_canonical')
+  insTag.run(3, 'long_black_hair', 'long_black_hair', 'hair', 700, 'danbooru', 'v1', 'danbooru_canonical')
+  db.prepare('INSERT INTO aliases VALUES (?,?,?,?)').run('waving', 2, 'danbooru', 0.85)
+  db.close()
+}
+
+let presetTmp: string
+let looseTmp: string
+
+beforeEach(() => {
+  presetTmp = mkdtempSync(join(tmpdir(), 'pm-catbtool-preset-'))
+  looseTmp = mkdtempSync(join(tmpdir(), 'pm-catbtool-loose-'))
+})
+
+afterEach(() => {
+  setPresetRoot(undefined)
+  closeCatalog()
+  rmSync(presetTmp, { recursive: true, force: true })
+  rmSync(looseTmp, { recursive: true, force: true })
+})
+
+describe('catalog_build tool', () => {
+  it('无参数默认：resolveKnowledgePath 推导源/输出/manifest，构建 + manifest 更新', async () => {
+    // 假 preset 布局：<tmp>/skills/anima-prompt-v1/knowledge/tags.sqlite
+    const knowledge = join(presetTmp, 'skills', 'anima-prompt-v1', 'knowledge')
+    mkdirSync(knowledge, { recursive: true })
+    seedTagsSource(join(knowledge, 'tags.sqlite'))
+    setPresetRoot(presetTmp)
+
+    const ctx = stubCtx()
+    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
+    const env = JSON.parse(String(await runTool(ctx, tool, {}))) as {
+      ok: boolean
+      stats: { records: number; names: number; ftsRows: number }
+      output: string
+      manifest: string | null
+    }
+    expect(env.ok).toBe(true)
+    expect(env.stats).toEqual({ records: 3, names: 4, ftsRows: 4 })
+    expect(env.output).toBe(join(knowledge, 'tag-catalog.sqlite'))
+    expect(env.manifest).toBe(join(knowledge, 'manifest.json'))
+    expect(existsSync(env.output)).toBe(true)
+    expect(existsSync(env.manifest as string)).toBe(true)
+    expect(verifyManifest(env.manifest as string)).toBe(true)
+
+    // 产物 FTS 可检索
+    const db = new DatabaseSync(env.output, { readOnly: true })
+    try {
+      expect((db.prepare("SELECT COUNT(*) AS n FROM catalog_fts WHERE catalog_fts MATCH 'waving'").get() as { n: number }).n).toBe(1)
+    } finally {
+      db.close()
+    }
+  })
+
+  it('显式 source/output（自定义路径）→ 不写真实 manifest（避免污染）', async () => {
+    const sourcePath = join(looseTmp, 'tags.sqlite')
+    const outputPath = join(looseTmp, 'custom', 'catalog.sqlite')
+    seedTagsSource(sourcePath)
+
+    const ctx = stubCtx()
+    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
+    const env = JSON.parse(String(await runTool(ctx, tool, { source: sourcePath, output: outputPath }))) as {
+      ok: boolean
+      stats: { records: number }
+      manifest: string | null
+    }
+    expect(env.ok).toBe(true)
+    expect(env.stats.records).toBe(3)
+    expect(env.manifest).toBeNull() // 自定义 output → 不更新 manifest
+    expect(existsSync(outputPath)).toBe(true)
+  })
+
+  it('显式 output 与默认一致 → 仍更新默认 manifest（就地重建语义）', async () => {
+    const knowledge = join(presetTmp, 'skills', 'anima-prompt-v1', 'knowledge')
+    mkdirSync(knowledge, { recursive: true })
+    seedTagsSource(join(knowledge, 'tags.sqlite'))
+    setPresetRoot(presetTmp)
+
+    const ctx = stubCtx()
+    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
+    const env = JSON.parse(String(await runTool(ctx, tool, { output: join(knowledge, 'tag-catalog.sqlite') }))) as {
+      ok: boolean
+      manifest: string | null
+    }
+    expect(env.ok).toBe(true)
+    expect(env.manifest).toBe(join(knowledge, 'manifest.json'))
+    expect(existsSync(env.manifest as string)).toBe(true)
+  })
+
+  it('源不存在 → Envelope ok:false + input_file_missing', async () => {
+    const ctx = stubCtx()
+    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
+    const env = JSON.parse(String(await runTool(ctx, tool, { source: join(looseTmp, 'missing.sqlite') }))) as {
+      ok: boolean
+      errors: Array<{ code: string; message: string }>
+    }
+    expect(env.ok).toBe(false)
+    expect(env.errors[0].code).toBe('input_file_missing')
+    expect(env.errors[0].message).toMatch(/not found/)
+  })
+
+  it('output 与 source 同路径 → Envelope ok:false + argument_error', async () => {
+    const sourcePath = join(looseTmp, 'same.sqlite')
+    seedTagsSource(sourcePath)
+    const ctx = stubCtx()
+    const tool = registerCatalogBuildTool(ctx as never, cfg as never)
+    const env = JSON.parse(String(await runTool(ctx, tool, { source: sourcePath, output: sourcePath }))) as {
+      ok: boolean
+      errors: Array<{ code: string }>
+    }
+    expect(env.ok).toBe(false)
+    expect(env.errors[0].code).toBe('argument_error')
+  })
+})
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/plugin/registry.test.ts b/plugins/prompt-master/tests/plugin/registry.test.ts
index f5cff5e..aadc3fd 100644
--- a/plugins/prompt-master/tests/plugin/registry.test.ts
+++ b/plugins/prompt-master/tests/plugin/registry.test.ts
@@ -22,23 +22,23 @@ function stubCtx() {
         expect(schema).toBeTruthy()
         return { get: () => ({ customProfiles: {} }), update: async () => {}, replace: async () => {} }
       },
     },
     effect(cb: any) { cb() },   // cordis 4 同步 effect（Task 2 已证）
   }
   return { ctx, registered }
 }
 
 describe('plugin registration', () => {
-  it('registers exactly the nine tools with native names', () => {
+  it('registers exactly the ten tools with native names', () => {
     const { ctx, registered } = stubCtx()
     apply(ctx, { temperature: 0.7 })
     const names = registered.map((d) => d.name).sort()
-    expect(names).toEqual(['catalog_relations', 'catalog_search', 'minimax_scenario', 'profile_list', 'prompt_audit', 'prompt_author', 'prompt_compile', 'prompt_expand', 'prompt_reverse'])
+    expect(names).toEqual(['catalog_build', 'catalog_relations', 'catalog_search', 'minimax_scenario', 'profile_list', 'prompt_audit', 'prompt_author', 'prompt_compile', 'prompt_expand', 'prompt_reverse'])
   })
 
   it('all outputs declare a string schema', () => {
     const { ctx, registered } = stubCtx()
     apply(ctx, { temperature: 0.7 })
     for (const d of registered) expect(d.output.schema).toMatchObject({ type: 'string' })
   })
 })
\ No newline at end of file
```
