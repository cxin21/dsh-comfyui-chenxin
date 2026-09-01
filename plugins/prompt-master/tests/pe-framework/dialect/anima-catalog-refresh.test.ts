import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setCatalogPath, closeCatalog, classifyTag, lastManifestCheck, _testOnlyState } from '../../../src/pe-framework/dialect/anima-catalog.js'

/**
 * G4 catalog handle refresh（Task 1）：
 * - lastManifestCheck() 形状：undefined = 未对账过；{ok} = 对账结果可查询。
 * - mtime 变化 → 关闭旧句柄 + 重新打开 + manifest 重新对账。
 *
 * mtime→reopen 的断言方式：mock statSync + node:sqlite 组合过于脆弱（vi.mock('node:fs')
 * 会波及 fixture 构建本身），按 brief 允许的降级方案改用内部探针 `_testOnlyState()`
 * （返回 {dbOpen, mtimeMs, dbGeneration, manifestChecks}）做确定性断言：
 * dbGeneration 递增 = 句柄重开；manifestChecks 递增 = 重新对账。
 */

let tmpDir: string | null = null

/** 最小可查询 catalog fixture：names/records/catalog_fts 缺失没关系，classifyTag 走到 db() 打开即可 */
function makeTinyCatalog(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'anima-catalog-refresh-'))
  const dbPath = join(tmpDir, 'tag-catalog.sqlite')
  const w = new DatabaseSync(dbPath)
  w.exec('CREATE TABLE records (record_id TEXT PRIMARY KEY, prompt_form TEXT, usage_count INTEGER)')
  w.exec("CREATE TABLE names (name_id TEXT PRIMARY KEY, record_id TEXT, value TEXT, normalized_value TEXT, name_type TEXT)")
  w.prepare('INSERT INTO records VALUES (?,?,?)').run('r1', '1girl', 100)
  w.prepare('INSERT INTO names VALUES (?,?,?,?,?)').run('n1', 'r1', '1girl', '1girl', 'canonical')
  w.close()
  return dbPath
}

describe('G4 catalog refresh (mtime → close+reopen + manifest re-check)', () => {
  afterEach(() => {
    closeCatalog()
    setCatalogPath('') // 回落默认（真实库），不污染其他测试文件的同进程状态
    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null }
  })

  it('mtime change → reopens handle and re-checks manifest (probe assertion)', () => {
    const dbPath = makeTinyCatalog()
    setCatalogPath(dbPath)

    expect(lastManifestCheck()).toBeUndefined() // 未对账过

    classifyTag('1girl') // 首开 + 对账
    const s1 = _testOnlyState()
    expect(s1.dbOpen).toBe(true)
    expect(s1.dbGeneration).toBe(1)
    expect(s1.manifestChecks).toBe(1)
    expect(s1.mtimeMs).toBeCloseTo(statSync(dbPath).mtimeMs, 0)
    expect(lastManifestCheck()).toBeDefined()

    // 模拟 catalog 重建：同一路径 mtime 变化
    const future = new Date(Date.now() + 60_000)
    utimesSync(dbPath, future, future)

    classifyTag('1girl') // 应触发 close + reopen + 重新对账
    const s2 = _testOnlyState()
    expect(s2.dbOpen).toBe(true)
    expect(s2.dbGeneration).toBe(2) // 句柄被重开
    expect(s2.manifestChecks).toBe(2) // manifest 重新对账
    expect(s2.mtimeMs).toBeCloseTo(future.getTime(), 0) // 缓存 mtime 已更新
    expect(lastManifestCheck()).toBeDefined()

    // mtime 未再变 → 不重开（幂等复用）
    classifyTag('1girl')
    const s3 = _testOnlyState()
    expect(s3.dbGeneration).toBe(2)
    expect(s3.manifestChecks).toBe(2)
  })

  it('lastManifestCheck shape on real catalog', () => {
    setCatalogPath('') // 回落默认（真实库）
    classifyTag('1girl') // 触发首开 + 对账
    const s = lastManifestCheck()
    expect(s).toBeDefined()
    expect(typeof s!.ok).toBe('boolean')
    if (!s!.ok) expect(typeof s!.reason).toBe('string')
  })
})
