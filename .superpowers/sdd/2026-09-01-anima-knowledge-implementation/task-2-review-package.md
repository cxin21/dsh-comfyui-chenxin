# Review package - 7b56511..24e1874

## Commits
``````

## Stat
``` .../src/pe-framework/anima-knowledge/browse.ts     |  52 +++++++
 .../src/pe-framework/anima-knowledge/verify.ts     |  81 +++++++++++
 .../src/pe-framework/dialect/anima-catalog.ts      |   6 +
 .../anima-knowledge/browse-verify.test.ts          | 154 +++++++++++++++++++++
 4 files changed, 293 insertions(+)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/browse.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/browse.ts
new file mode 100644
index 0000000..0467c5a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/anima-knowledge/browse.ts
@@ -0,0 +1,52 @@
+/**
+ * anima-knowledge/browse.ts — G3 目录浏览/统计（无查询词扫描面）。
+ * 数据通道：anima-catalog 的 queryCatalogInternal（option a）——共享句柄缓存、
+ * mtime 重开与 manifest 对账，本模块不自行打开 DatabaseSync。
+ */
+import { queryCatalogInternal } from '../dialect/anima-catalog.js'
+import type { CatalogHit } from '../dialect/anima-catalog.js'
+
+export interface BrowseOptions {
+  category?: string
+  source?: string
+  limit?: number
+}
+
+const DEFAULT_LIMIT = 20
+
+/** 无查询词扫描：records 按 usage_count 降序，可选 category / source（sources.name）过滤 */
+export function browseCatalog(opts?: BrowseOptions): CatalogHit[] {
+  const limit = opts?.limit === undefined ? DEFAULT_LIMIT : opts.limit
+  if (limit < 1) return []
+  const category = opts?.category?.trim() || null
+  const source = opts?.source?.trim() || null
+  const rows = queryCatalogInternal(
+    `SELECT r.record_id, r.prompt_form, r.usage_count, r.canonical_name AS matched_name
+     FROM records r
+     WHERE (? IS NULL OR r.category = ?)
+       AND (? IS NULL OR EXISTS (
+         SELECT 1 FROM json_each(r.source_ids) je JOIN sources s ON s.source_id = je.value WHERE s.name = ?))
+     ORDER BY r.usage_count DESC, r.record_id
+     LIMIT ?`,
+    [category, category, source, source, limit],
+  ) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
+  return rows.map((r) => ({
+    match_type: 'canonical',
+    prompt_form: r.prompt_form,
+    record_id: r.record_id,
+    usage_count: r.usage_count,
+    raw: r.matched_name,
+  }))
+}
+
+export interface CatalogStats {
+  records: number
+  names: number
+  ftsRows: number
+}
+
+/** 三计数：records / names / catalog_fts 行数（1.37M / 1.39M / =names 量级） */
+export function catalogStats(): CatalogStats {
+  const count = (table: string): number => (queryCatalogInternal(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n
+  return { records: count('records'), names: count('names'), ftsRows: count('catalog_fts') }
+}
diff --git a/plugins/prompt-master/src/pe-framework/anima-knowledge/verify.ts b/plugins/prompt-master/src/pe-framework/anima-knowledge/verify.ts
new file mode 100644
index 0000000..bdb2966
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/anima-knowledge/verify.ts
@@ -0,0 +1,81 @@
+/**
+ * anima-knowledge/verify.ts — G3 目录健康深检（四项）：
+ * ① checksum（manifest 对账，复用 resources/manifest 的 assertAnimaCatalog）
+ * ② FTS 行数 == names 行数（计数平价）
+ * ③ 4 表存在（records/names/catalog_fts/sources）
+ * ④ schema 对齐（关键列存在性；表缺失时由 ③ 报错，此处只对存在的表做列对齐）
+ * 每项独立 try/catch：单项失败不阻断其余检查（deep-check 契约）。
+ */
+import { queryCatalogInternal, catalogMeta } from '../dialect/anima-catalog.js'
+import { assertAnimaCatalog } from '../resources/manifest.js'
+
+export interface VerifyCheck {
+  name: string
+  ok: boolean
+  detail?: string
+}
+
+export interface VerifyResult {
+  ok: boolean
+  checks: VerifyCheck[]
+}
+
+export const EXPECTED_TABLES = ['records', 'names', 'catalog_fts', 'sources'] as const
+
+/** 与 catalog/storage.py SCHEMA 对齐的关键列（存在性子集检查，非全列强校验） */
+const REQUIRED_COLUMNS: Record<string, string[]> = {
+  records: ['record_id', 'canonical_name', 'prompt_form', 'category', 'usage_count', 'source_ids'],
+  names: ['name_id', 'record_id', 'value', 'normalized_value', 'name_type'],
+  sources: ['source_id', 'name'],
+  catalog_fts: ['name_id', 'record_id', 'value', 'normalized_value'],
+}
+
+function runCheck(name: string, fn: () => string | undefined): VerifyCheck {
+  try {
+    const detail = fn()
+    return detail === undefined ? { name, ok: true } : { name, ok: true, detail }
+  } catch (e) {
+    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) }
+  }
+}
+
+function countOf(table: string): number {
+  return (queryCatalogInternal(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n
+}
+
+export function verifyCatalog(): VerifyResult {
+  const checks: VerifyCheck[] = [
+    runCheck('checksum', () => {
+      const r = assertAnimaCatalog()
+      if (!r.ok) throw new Error(r.reason)
+      return 'manifest sha256 matches file'
+    }),
+    runCheck('ftsParity', () => {
+      const fts = countOf('catalog_fts')
+      const names = countOf('names')
+      if (fts !== names) throw new Error(`fts/names count mismatch (fts=${fts} names=${names})`)
+      return `fts=${fts} == names=${names}`
+    }),
+    runCheck('tables', () => {
+      const present = new Set(catalogMeta().tables)
+      const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
+      if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`)
+      return `${EXPECTED_TABLES.length} tables present`
+    }),
+    runCheck('schema', () => {
+      const present = new Set(catalogMeta().tables)
+      const problems: string[] = []
+      for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
+        if (!present.has(table)) continue // 表缺失已由 tables 检查报告
+        const actual = new Set(
+          (queryCatalogInternal(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
+        )
+        const missingCols = required.filter((c) => !actual.has(c))
+        if (missingCols.length) problems.push(`${table}: missing ${missingCols.join(', ')}`)
+      }
+      if (problems.length) throw new Error(`schema misaligned — ${problems.join('; ')}`)
+      return 'required columns aligned'
+    }),
+  ]
+  return { ok: checks.every((c) => c.ok), checks }
+}
diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index b789694..90152f4 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -188,19 +188,25 @@ export function catalogMeta(): { file: string; sizeBytes: number; tables: string
   let sizeBytes = 0
   const path = catalogPath()
   try {
     sizeBytes = statSync(path).size
   } catch {
     /* path may be a file: URI fallback */
   }
   return { file: path, sizeBytes, tables, fts }
 }
 
+/** G3（Task 2）anima-knowledge browse/stats/verify 的最小内部 SQL 通道（brief option a）：
+ *  复用句柄缓存 + mtime 重开 + manifest 对账，不导出 _db 本体。只读 SELECT 用。 */
+export function queryCatalogInternal(sql: string, params: readonly (string | number | null)[] = []): unknown[] {
+  return db().prepare(sql).all(...params)
+}
+
 /** 便捷 close（测试隔离用） */
 export function closeCatalog(): void {
   if (_db) { _db.close(); _db = null }
 }
 
 /** 预设 knowledge 目录推导（供 config 接线） */
 export function knowledgeDir(): string {
   return dirname(defaultCatalogPath())
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/anima-knowledge/browse-verify.test.ts b/plugins/prompt-master/tests/pe-framework/anima-knowledge/browse-verify.test.ts
new file mode 100644
index 0000000..8dec6ff
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/anima-knowledge/browse-verify.test.ts
@@ -0,0 +1,154 @@
+import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
+import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { createHash } from 'node:crypto'
+import { DatabaseSync } from 'node:sqlite'
+import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
+import { setCatalogPath, closeCatalog, queryCatalogInternal } from '../../../src/pe-framework/dialect/anima-catalog.js'
+import { browseCatalog, catalogStats } from '../../../src/pe-framework/anima-knowledge/browse.js'
+import { verifyCatalog } from '../../../src/pe-framework/anima-knowledge/verify.js'
+
+describe('catalog browse/stats/verify — real catalog (read-only)', () => {
+  it('browseCatalog limit=3 → 3 hits with record_id/prompt_form/usage_count', () => {
+    const hits = browseCatalog({ limit: 3 })
+    expect(hits).toHaveLength(3)
+    for (const h of hits) {
+      expect(h.match_type).toBe('canonical')
+      expect(typeof h.record_id).toBe('string')
+      expect(typeof h.prompt_form).toBe('string')
+      expect(typeof h.usage_count).toBe('number')
+    }
+  })
+
+  it('browseCatalog default limit=20', () => {
+    expect(browseCatalog()).toHaveLength(20)
+  })
+
+  it('browseCatalog category filter → exactly the category rows (cross-checked via SQL)', () => {
+    const top = queryCatalogInternal(
+      'SELECT category, COUNT(*) AS n FROM records GROUP BY category ORDER BY COUNT(*) DESC LIMIT 1',
+    )[0] as { category: string; n: number }
+    expect(top.n).toBeGreaterThan(0)
+    const hits = browseCatalog({ category: top.category, limit: 500 })
+    expect(hits.length).toBe(Math.min(top.n, 500))
+  })
+
+  it('browseCatalog source filter → non-empty hits from that source', () => {
+    const src = queryCatalogInternal(
+      `SELECT s.name FROM sources s JOIN json_each((SELECT source_ids FROM records LIMIT 1)) je ON je.value = s.source_id LIMIT 1`,
+    )[0] as { name: string }
+    expect(src?.name).toBeTruthy()
+    const hits = browseCatalog({ source: src.name, limit: 5 })
+    expect(hits.length).toBeGreaterThan(0)
+    expect(hits.length).toBeLessThanOrEqual(5)
+  })
+
+  it('catalogStats → three counts > 0, records at 1M+ scale, ftsRows === names', () => {
+    const s = catalogStats()
+    expect(s.records).toBeGreaterThan(1_000_000)
+    expect(s.names).toBeGreaterThan(1_000_000)
+    expect(s.ftsRows).toBe(s.names)
+  })
+
+  it('verifyCatalog → ok:true with four passing checks', () => {
+    const r = verifyCatalog()
+    expect(r.checks.map((c) => c.name)).toEqual(['checksum', 'ftsParity', 'tables', 'schema'])
+    expect(r.checks.every((c) => c.ok)).toBe(true)
+    expect(r.ok).toBe(true)
+  })
+})
+
+// ---- tmp 小库失败分支（fixture 模式对齐 tests/pe-framework/resources/manifest.test.ts）----
+
+let tmp: string
+
+function buildFixtureCatalog(dbPath: string, opts: { withFts?: boolean; ftsRows?: number; nameRows?: number }): void {
+  const db = new DatabaseSync(dbPath)
+  db.exec(`
+    CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL);
+    CREATE TABLE records (record_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, prompt_form TEXT NOT NULL, category TEXT NOT NULL, usage_count INTEGER NOT NULL, source_ids TEXT NOT NULL);
+    CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, name_type TEXT NOT NULL);
+  `)
+  db.prepare("INSERT INTO sources VALUES ('src-1', 'danbooru')").run()
+  db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)").run('rec-1', 'smile', 'smile', 'general', 10, '["src-1"]')
+  const insName = db.prepare("INSERT INTO names VALUES (?, 'rec-1', ?, ?, 'canonical')")
+  insName.run('nm-1', 'smile', 'smile')
+  const extra = opts.nameRows ?? 0
+  for (let i = 0; i < extra; i++) insName.run(`nm-x${i}`, `name ${i}`, `name ${i}`)
+  const nameIds = ['nm-1', ...Array.from({ length: extra }, (_, i) => `nm-x${i}`)]
+  if (opts.withFts !== false) {
+    db.exec(`CREATE VIRTUAL TABLE catalog_fts USING fts5(name_id UNINDEXED, record_id UNINDEXED, value, normalized_value)`)
+    const insFts = db.prepare('INSERT INTO catalog_fts (name_id, record_id, value, normalized_value) VALUES (?, ?, ?, ?)')
+    const rows = opts.ftsRows ?? nameIds.length
+    for (let i = 0; i < rows; i++) insFts.run(nameIds[i] ?? `nm-ghost-${i}`, 'rec-1', 'v', 'v')
+  }
+  db.close()
+}
+
+function writeTmpFixture(opts: { withFts?: boolean; ftsRows?: number; nameRows?: number; withManifest?: boolean }): string {
+  const knowledge = join(tmp, 'skills', 'anima-prompt-v1', 'knowledge')
+  mkdirSync(knowledge, { recursive: true })
+  const dbPath = join(knowledge, 'tag-catalog.sqlite')
+  buildFixtureCatalog(dbPath, opts)
+  if (opts.withManifest !== false) {
+    writeFileSync(
+      join(knowledge, 'manifest.json'),
+      JSON.stringify({ content_filters: false, output: { path: 'tag-catalog.sqlite', checksum: createHash('sha256').update(readFileSync(dbPath)).digest('hex') } }),
+    )
+  }
+  return dbPath
+}
+
+describe('catalog verify — tmp fixture failure branches', () => {
+  let warnSpy: ReturnType<typeof vi.spyOn>
+
+  beforeEach(() => {
+    tmp = mkdtempSync(join(tmpdir(), 'pm-browse-verify-'))
+    setPresetRoot(tmp)
+    closeCatalog()
+    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
+  })
+  afterEach(() => {
+    setCatalogPath('')
+    closeCatalog()
+    setPresetRoot(undefined)
+    warnSpy.mockRestore()
+    rmSync(tmp, { recursive: true, force: true })
+  })
+
+  it('missing catalog_fts table → ftsParity + tables checks fail, ok:false', () => {
+    setCatalogPath(writeTmpFixture({ withFts: false }))
+    const r = verifyCatalog()
+    expect(r.ok).toBe(false)
+    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]))
+    expect(byName.tables?.ok).toBe(false)
+    expect(byName.tables?.detail).toContain('catalog_fts')
+    expect(byName.ftsParity?.ok).toBe(false)
+    expect(byName.checksum?.ok).toBe(true)
+  })
+
+  it('FTS row count != names count → ftsParity fails with detail', () => {
+    setCatalogPath(writeTmpFixture({ withFts: true, ftsRows: 1, nameRows: 2 }))
+    const r = verifyCatalog()
+    const parity = r.checks.find((c) => c.name === 'ftsParity')
+    expect(parity?.ok).toBe(false)
+    expect(parity?.detail).toMatch(/fts=1/)
+    expect(r.ok).toBe(false)
+  })
+
+  it('well-formed tmp catalog + matching manifest → all four checks pass', () => {
+    setCatalogPath(writeTmpFixture({ withFts: true }))
+    const r = verifyCatalog()
+    expect(r.checks.every((c) => c.ok)).toBe(true)
+    expect(r.ok).toBe(true)
+  })
+
+  it('browse/stats work against tmp fixture', () => {
+    setCatalogPath(writeTmpFixture({ withFts: true }))
+    expect(browseCatalog({ limit: 1 })).toHaveLength(1)
+    expect(browseCatalog({ source: 'danbooru', limit: 5 })).toHaveLength(1)
+    expect(browseCatalog({ category: 'nonexistent', limit: 5 })).toHaveLength(0)
+    expect(catalogStats()).toEqual({ records: 1, names: 1, ftsRows: 1 })
+  })
+})
```
