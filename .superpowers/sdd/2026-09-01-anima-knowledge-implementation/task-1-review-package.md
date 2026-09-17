# Review package - 0fff169..7b56511

## Commits
``````

## Stat
``` .../src/pe-framework/dialect/anima-catalog.ts      | 34 ++++++++-
 .../dialect/anima-catalog-refresh.test.ts          | 82 ++++++++++++++++++++++
 2 files changed, 114 insertions(+), 2 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index 64e97df..b789694 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -25,45 +25,75 @@ export interface CatalogQueryOptions {
 export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'
 
 const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
 const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })
 
 let _db: DatabaseSync | null = null
 /** 惰性解析（MF-1）：路径在 db() 打开时才解析，保证 setPresetRoot(config.presetRoot) 先于路径求值；
  *  模块求值期不再触碰文件系统（resolveKnowledgePath fallback 失败的 throw 不再发生在 import 时）。 */
 let _dbPathOverride: string | null = process.env.ANIMA_CATALOG_PATH ?? null
 let _manifestChecked = false
+/** G4（Task 1）：句柄缓存 mtime 与 manifest 对账结果（mtime 变化 → close+reopen + 重新对账） */
+let _lastMtimeMs = 0
+let _dbGeneration = 0
+let _manifestChecks = 0
+let _lastManifest: { ok: boolean; reason?: string } | undefined
+
+/** 最近一次 manifest 对账结果；undefined = 本进程尚未对账过 */
+export function lastManifestCheck(): { ok: boolean; reason?: string } | undefined {
+  return _lastManifest
+}
+
+/** 测试专用探针（brief 允许的降级断言方式）：mock statSync+node:sqlite 组合过于脆弱，
+ *  改为直接暴露句柄存在性 / 缓存 mtime / 重开代数 / 对账次数，供 mtime→reopen 断言。 */
+export function _testOnlyState(): { dbOpen: boolean; mtimeMs: number; dbGeneration: number; manifestChecks: number } {
+  return { dbOpen: _db !== null, mtimeMs: _lastMtimeMs, dbGeneration: _dbGeneration, manifestChecks: _manifestChecks }
+}
 
 /** manifest 对账只跑一次；失败 console.warn 但不硬崩（资源层无 ctx.logger，spec §4.2）。
  *  在首次 db() 调用时执行（MF-1：从模块求值期移入惰性路径，先于任何 db 打开）：783MiB catalog 的
- *  sha256 在全量测试并行 IO 下会超过 vitest 单测 5s 超时，once-flag 保证每个进程只对账一次。 */
+ *  sha256 在全量测试并行 IO 下会超过 vitest 单测 5s 超时，once-flag 保证每个进程只对账一次。
+ *  G4：句柄因 mtime 变化被重开时 once-flag 复位 → 对账重跑，结果记入 lastManifestCheck()。 */
 function verifyManifestOnce(): void {
   if (_manifestChecked) return
   _manifestChecked = true
+  _manifestChecks++
   const r = assertAnimaCatalog()
+  _lastManifest = r.ok ? { ok: true } : { ok: false, reason: r.reason }
   if (!r.ok) console.warn(`[prompt-master] ${r.reason}：资产与 golden 基线不同，请 re-run fidelity capture`)
 }
 
 export function catalogPath(): string {
   return _dbPathOverride ?? defaultCatalogPath()
 }
 
 export function setCatalogPath(path: string): void {
   if (_db) { _db.close(); _db = null }
   // 空串 = 清除显式覆盖，回落到 env 优先级（level 0），再回落 defaultCatalogPath()
   _dbPathOverride = path || (process.env.ANIMA_CATALOG_PATH ?? null)
 }
 
 function db(): DatabaseSync {
+  const path = catalogPath()
+  let mtime = 0
+  try { mtime = statSync(path).mtimeMs } catch { /* 打开前缺失由 DatabaseSync 抛出 */ }
+  // G4：catalog 被 skill 重建（mtime 变化）→ 关闭陈旧句柄，重开并重新对账，无需进程重启
+  if (_db && mtime !== _lastMtimeMs) {
+    _db.close()
+    _db = null
+    _manifestChecked = false // 重新对账
+  }
   if (!_db) {
     verifyManifestOnce()
-    _db = new DatabaseSync(catalogPath(), { readOnly: true })
+    _db = new DatabaseSync(path, { readOnly: true })
+    _lastMtimeMs = mtime
+    _dbGeneration++
   }
   return _db
 }
 
 /** facets.normalize 移植：lowercase、underscores→spaces、collapse whitespace、strip */
 export function normalizeTag(value: string): string {
   return value.trim().toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean).join(' ')
 }
 
 /** search.py _fts_query 移植：OR + prefix tokens（word-root discovery） */
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts
new file mode 100644
index 0000000..d65a78c
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts
@@ -0,0 +1,82 @@
+import { describe, expect, it, afterEach } from 'vitest'
+import { mkdtempSync, writeFileSync, utimesSync, rmSync, statSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { DatabaseSync } from 'node:sqlite'
+import { setCatalogPath, closeCatalog, classifyTag, lastManifestCheck, _testOnlyState } from '../../../src/pe-framework/dialect/anima-catalog.js'
+
+/**
+ * G4 catalog handle refresh（Task 1）：
+ * - lastManifestCheck() 形状：undefined = 未对账过；{ok} = 对账结果可查询。
+ * - mtime 变化 → 关闭旧句柄 + 重新打开 + manifest 重新对账。
+ *
+ * mtime→reopen 的断言方式：mock statSync + node:sqlite 组合过于脆弱（vi.mock('node:fs')
+ * 会波及 fixture 构建本身），按 brief 允许的降级方案改用内部探针 `_testOnlyState()`
+ * （返回 {dbOpen, mtimeMs, dbGeneration, manifestChecks}）做确定性断言：
+ * dbGeneration 递增 = 句柄重开；manifestChecks 递增 = 重新对账。
+ */
+
+let tmpDir: string | null = null
+
+/** 最小可查询 catalog fixture：names/records/catalog_fts 缺失没关系，classifyTag 走到 db() 打开即可 */
+function makeTinyCatalog(): string {
+  tmpDir = mkdtempSync(join(tmpdir(), 'anima-catalog-refresh-'))
+  const dbPath = join(tmpDir, 'tag-catalog.sqlite')
+  const w = new DatabaseSync(dbPath)
+  w.exec('CREATE TABLE records (record_id TEXT PRIMARY KEY, prompt_form TEXT, usage_count INTEGER)')
+  w.exec("CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT, value TEXT, normalized_value TEXT, name_type TEXT)")
+  w.prepare('INSERT INTO records VALUES (?,?,?)').run('r1', '1girl', 100)
+  w.prepare('INSERT INTO names VALUES (?,?,?,?,?)').run('n1', 'r1', '1girl', '1girl', 'canonical')
+  w.close()
+  return dbPath
+}
+
+describe('G4 catalog refresh (mtime → close+reopen + manifest re-check)', () => {
+  afterEach(() => {
+    closeCatalog()
+    setCatalogPath('') // 回落默认（真实库），不污染其他测试文件的同进程状态
+    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null }
+  })
+
+  it('mtime change → reopens handle and re-checks manifest (probe assertion)', () => {
+    const dbPath = makeTinyCatalog()
+    setCatalogPath(dbPath)
+
+    expect(lastManifestCheck()).toBeUndefined() // 未对账过
+
+    classifyTag('1girl') // 首开 + 对账
+    const s1 = _testOnlyState()
+    expect(s1.dbOpen).toBe(true)
+    expect(s1.dbGeneration).toBe(1)
+    expect(s1.manifestChecks).toBe(1)
+    expect(s1.mtimeMs).toBeCloseTo(statSync(dbPath).mtimeMs, 0)
+    expect(lastManifestCheck()).toBeDefined()
+
+    // 模拟 catalog 重建：同一路径 mtime 变化
+    const future = new Date(Date.now() + 60_000)
+    utimesSync(dbPath, future, future)
+
+    classifyTag('1girl') // 应触发 close + reopen + 重新对账
+    const s2 = _testOnlyState()
+    expect(s2.dbOpen).toBe(true)
+    expect(s2.dbGeneration).toBe(2) // 句柄被重开
+    expect(s2.manifestChecks).toBe(2) // manifest 重新对账
+    expect(s2.mtimeMs).toBeCloseTo(future.getTime(), 0) // 缓存 mtime 已更新
+    expect(lastManifestCheck()).toBeDefined()
+
+    // mtime 未再变 → 不重开（幂等复用）
+    classifyTag('1girl')
+    const s3 = _testOnlyState()
+    expect(s3.dbGeneration).toBe(2)
+    expect(s3.manifestChecks).toBe(2)
+  })
+
+  it('lastManifestCheck shape on real catalog', () => {
+    setCatalogPath('') // 回落默认（真实库）
+    classifyTag('1girl') // 触发首开 + 对账
+    const s = lastManifestCheck()
+    expect(s).toBeDefined()
+    expect(typeof s!.ok).toBe('boolean')
+    if (!s!.ok) expect(typeof s!.reason).toBe('string')
+  })
+})
```
