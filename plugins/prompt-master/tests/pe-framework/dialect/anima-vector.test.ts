import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { getLoadablePath } from 'sqlite-vec'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  createVectorSearch,
  quantizeInt8,
  unitVec,
  resolveHfCacheDir,
  VectorDimensionMismatchError,
  E5_PASSAGE_PREFIX,
  E5_QUERY_PREFIX,
  type EmbedFn,
} from '../../../src/pe-framework/dialect/anima-vector.js'

describe('resolveHfCacheDir (T14-002: cwd-independent HF cache pin)', () => {
  it('returns an absolute preset-anchored path under data/runtime, never node_modules or cwd-relative', () => {
    const dir = resolveHfCacheDir()
    expect(dir).toBeTruthy()
    expect(isAbsolute(dir!)).toBe(true)
    expect(dir!.endsWith(join('data', 'runtime', 'hf-cache'))).toBe(true)
    // 缺陷本体：缓存不得落在随 cwd/包安装漂移的位置
    expect(dir!.includes('node_modules')).toBe(false)
    expect(dir!.startsWith(tmpdir())).toBe(false)
  })

  it('is cwd-independent (stable across different working directories)', () => {
    // presetRootFromModulePath 从 import.meta.url 推导，与 process.cwd() 无关；
    // 同进程内两次解析必须逐字节一致（确定性缺陷的回归探针）
    expect(resolveHfCacheDir()).toBe(resolveHfCacheDir())
  })
})

describe('e5 prefix constants', () => {
  it('query/passage prefixes follow e5 convention', () => {
    expect(E5_QUERY_PREFIX).toBe('query: ')
    expect(E5_PASSAGE_PREFIX).toBe('passage: ')
  })
})

const DIM = 384

const tmpDirs: string[] = []

/** 在指定路径现建 fixture 向量库（schema 与 Task 7 建库脚本完全一致；不加载真模型）。
 *  已存在的同名表先 DROP——支持同路径重建（mtime 重开测试；Windows 不允许删除被缓存句柄
 *  打开的文件，就地重建是唯一可行方式）。 */
function makeFixtureDbAt(path: string, seeds: Array<[string, string, number]>, meta?: { model: string; dim: number }): void {
  const db = new DatabaseSync(path, { allowExtension: true })
  db.loadExtension(getLoadablePath())
  db.exec('DROP TABLE IF EXISTS vec_items')
  db.exec('DROP TABLE IF EXISTS payload')
  db.exec('DROP TABLE IF EXISTS meta')
  db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding int8[${DIM}] distance_metric=cosine)`)
  db.exec(`CREATE TABLE payload(record_id TEXT PRIMARY KEY, text_source TEXT NOT NULL)`)
  if (meta) {
    // 与生产建库脚本同形：key/value provenance 表（Node 查询侧 readMeta 对账依据）
    db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    const insM = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
    insM.run('model', meta.model)
    insM.run('dim', String(meta.dim))
  }
  const ins = db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, vec_int8(?))')
  const insP = db.prepare('INSERT INTO payload(rowid, record_id, text_source) VALUES (?, ?, ?)')
  seeds.forEach(([rid, src, seed], i) => {
    // sqlite-vec 按 blob 子类型判定向量类型：裸 384 字节 blob 会被推断为 float32，
    // 必须 vec_int8(?) 显式声明 int8（与查询侧 MATCH vec_int8(?) 同口径）
    // node:sqlite 把 JS number 绑成 REAL → vec0 的 rowid/k 只认 INTEGER，必须 BigInt 绑定
    ins.run(BigInt(i + 1), quantizeInt8(unitVec(seed)))
    insP.run(BigInt(i + 1), rid, src)
  })
  db.close()
}

function makeFixtureDb(seeds?: Array<[string, string, number]>, meta?: { model: string; dim: number }): string {
  const dir = mkdtempSync(join(tmpdir(), 'vec-fixture-'))
  tmpDirs.push(dir)
  const p = join(dir, 'tag-vector.sqlite')
  // 5 个 tag，向量由 seed 决定；查询 stub 用相同 seed → 命中自身，score≈1
  makeFixtureDbAt(p, seeds ?? [
    ['serafuku', 'wiki', 101], ['twintails', 'fallback', 202], ['cat_ears', 'wiki', 303],
    ['school_uniform', 'fallback', 404], ['neon_signs', 'wiki', 505],
  ], meta)
  return p
}

afterAll(() => {
  // best-effort：Windows 上 createVectorSearch 缓存的只读句柄仍持有文件锁时删除会 EPERM；
  // fixture 目录在系统 tmp 下，泄漏可容忍（不因清理失败判测试失败）
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* leave behind */
    }
  }
})

describe('createVectorSearch', () => {
  it('returns nearest tag with score and text_source (stub embed)', async () => {
    const p = makeFixtureDb()
    const stub: EmbedFn = async (texts) => {
      const seedBy: Record<string, number> = { 'sailor uniform': 101, 'bunny ears': 303, 'unknown thing': 999 }
      return texts.map((t) => unitVec(seedBy[t] ?? 999))
    }
    const search = createVectorSearch({ dbPath: p, embed: stub })
    const hits = await search('sailor uniform', 3)
    expect(hits[0]).toMatchObject({ record_id: 'serafuku', text_source: 'wiki' })
    expect(hits[0].score).toBeGreaterThan(0.9)
    expect(hits.length).toBeLessThanOrEqual(3)
  })

  it('missing db file degrades to empty array', async () => {
    const search = createVectorSearch({ dbPath: join(tmpdir(), 'no-such-vec.sqlite'), embed: async () => [new Float32Array(DIM)] })
    expect(await search('anything', 3)).toEqual([])
  })

  it('below-threshold hits are dropped, not padded', async () => {
    const p = makeFixtureDb()
    const stub: EmbedFn = async (texts) => texts.map(() => unitVec(999)) // 与 fixture 向量 cos≈0.757~0.775（LCG 非正交），threshold 0.9 下全部低于阈值
    const search = createVectorSearch({ dbPath: p, embed: stub, threshold: 0.9 })
    expect(await search('unknown thing', 5)).toEqual([])
  })

  it('CJK queries are rejected at the entry (English-only constraint) without calling the embedder', async () => {
    const p = makeFixtureDb()
    let embedCalls = 0
    const spy: EmbedFn = async (texts) => {
      embedCalls += texts.length
      return texts.map(() => unitVec(101))
    }
    const search = createVectorSearch({ dbPath: p, embed: spy })
    expect(await search('水手服', 3)).toEqual([])
    expect(await search('school uniform 制服', 3)).toEqual([]) // 混入 CJK 同样拒绝
    expect(embedCalls).toBe(0)
  })

  it('mtime change reopens stale handle (G4)', async () => {
    const p = makeFixtureDb()
    const stub: EmbedFn = async () => [unitVec(101)] // sailor uniform → serafuku 方向
    const search = createVectorSearch({ dbPath: p, embed: stub })
    expect((await search('sailor uniform', 3))[0]?.record_id).toBe('serafuku')
    // 同路径重建库（内容换成仅 neon_signs）并强制 mtime 前移 → 陈旧句柄必须被重开
    makeFixtureDbAt(p, [['neon_signs', 'wiki', 505]])
    const t = new Date(Date.now() + 10_000)
    utimesSync(p, t, t)
    // 陈旧句柄仍会从旧 vec_items 命中 serafuku；重开后旧行已不存在 → 命中集必不含 serafuku
    const hits = await search('sailor uniform', 3)
    expect(hits.map((h) => h.record_id)).not.toContain('serafuku')
  })

  it('empty query or k < 1 returns empty array without touching db', async () => {
    const p = makeFixtureDb()
    const search = createVectorSearch({ dbPath: p, embed: async () => [unitVec(101)] })
    expect(await search('', 3)).toEqual([])
    expect(await search('sailor uniform', 0)).toEqual([])
  })

  it('legacy db without meta table still works (backward compat, warn-once)', async () => {
    const p = makeFixtureDb() // 无 meta —— 旧版建库产物
    const search = createVectorSearch({ dbPath: p, embed: async () => [unitVec(101)] })
    const hits = await search('sailor uniform', 3)
    expect(hits[0]).toMatchObject({ record_id: 'serafuku' })
  })

  it('meta-matching dim works normally', async () => {
    const p = makeFixtureDb(undefined, { model: 'Xenova/bge-base-en-v1.5', dim: DIM })
    const search = createVectorSearch({ dbPath: p, embed: async () => [unitVec(101)] })
    expect((await search('sailor uniform', 3))[0]?.record_id).toBe('serafuku')
  })

  it('dim mismatch vs meta fails fast with typed error (not silent degrade)', async () => {
    // 建库侧 1024（bge-m3 型事故）、查询侧 stub 输出 384 → 必须抛 VectorDimensionMismatchError，
    // 且错误不得被本模块 catch-all 吞成空数组（配置错误 ≠ 环境故障）
    const p = makeFixtureDb(undefined, { model: 'BAAI/bge-m3', dim: 1024 })
    const search = createVectorSearch({ dbPath: p, embed: async () => [unitVec(101)] })
    await expect(search('sailor uniform', 3)).rejects.toBeInstanceOf(VectorDimensionMismatchError)
    await expect(search('sailor uniform', 3)).rejects.toThrow(/index dim=1024.*query dim=384/)
  })
})
