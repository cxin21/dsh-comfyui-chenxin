/**
 * Anima tag-catalog 查询层（P2 定案）。
 * 来源：comfyui-chenxin preset knowledge/tag-catalog.sqlite（FTS5 1.39M 行）+ catalog/search.py 匹配语义。
 * node:sqlite DatabaseSync 只读直读；canonical→alias→fuzzy 级联（mode auto）；'exact' = 不含 fuzzy 的精确级联。
 */
import { DatabaseSync } from 'node:sqlite'
import { statSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveKnowledgePath } from '../resources/resolve.js'
import { assertAnimaCatalog } from '../resources/manifest.js'

export interface CatalogHit {
  match_type: 'canonical' | 'alias' | 'fuzzy' | 'miss'
  prompt_form?: string
  record_id?: string
  usage_count?: number
  raw?: string
}

export interface CatalogQueryOptions {
  mode?: 'auto' | 'exact'
  limit?: number
}

export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'

const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })

let _db: DatabaseSync | null = null
/** 惰性解析（MF-1）：路径在 db() 打开时才解析，保证 setPresetRoot(config.presetRoot) 先于路径求值；
 *  模块求值期不再触碰文件系统（resolveKnowledgePath fallback 失败的 throw 不再发生在 import 时）。 */
let _dbPathOverride: string | null = process.env.ANIMA_CATALOG_PATH ?? null
let _manifestChecked = false
/** G4（Task 1）：句柄缓存 mtime 与 manifest 对账结果（mtime 变化 → close+reopen + 重新对账） */
let _lastMtimeMs = 0
let _dbGeneration = 0
let _manifestChecks = 0
let _lastManifest: { ok: boolean; reason?: string } | undefined

/** 最近一次 manifest 对账结果；undefined = 本进程尚未对账过 */
export function lastManifestCheck(): { ok: boolean; reason?: string } | undefined {
  return _lastManifest
}

/** 测试专用探针（brief 允许的降级断言方式）：mock statSync+node:sqlite 组合过于脆弱，
 *  改为直接暴露句柄存在性 / 缓存 mtime / 重开代数 / 对账次数，供 mtime→reopen 断言。 */
export function _testOnlyState(): { dbOpen: boolean; mtimeMs: number; dbGeneration: number; manifestChecks: number } {
  return { dbOpen: _db !== null, mtimeMs: _lastMtimeMs, dbGeneration: _dbGeneration, manifestChecks: _manifestChecks }
}

/** manifest 对账只跑一次；失败 console.warn 但不硬崩（资源层无 ctx.logger，spec §4.2）。
 *  在首次 db() 调用时执行（MF-1：从模块求值期移入惰性路径，先于任何 db 打开）：783MiB catalog 的
 *  sha256 在全量测试并行 IO 下会超过 vitest 单测 5s 超时，once-flag 保证每个进程只对账一次。
 *  G4：句柄因 mtime 变化被重开时 once-flag 复位 → 对账重跑，结果记入 lastManifestCheck()。 */
function verifyManifestOnce(): void {
  if (_manifestChecked) return
  _manifestChecked = true
  _manifestChecks++
  const r = assertAnimaCatalog()
  _lastManifest = r.ok ? { ok: true } : { ok: false, reason: r.reason }
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
  const path = catalogPath()
  let mtime = 0
  try { mtime = statSync(path).mtimeMs } catch { /* 打开前缺失由 DatabaseSync 抛出 */ }
  // G4：catalog 被 skill 重建（mtime 变化）→ 关闭陈旧句柄，重开并重新对账，无需进程重启
  if (_db && mtime !== _lastMtimeMs) {
    _db.close()
    _db = null
    _manifestChecked = false // 重新对账
  }
  if (!_db) {
    verifyManifestOnce()
    _db = new DatabaseSync(path, { readOnly: true })
    _lastMtimeMs = mtime
    _dbGeneration++
  }
  return _db
}

/** facets.normalize 移植：lowercase、underscores→spaces、collapse whitespace、strip */
export function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean).join(' ')
}

/** search.py _fts_query 移植：OR + prefix tokens（word-root discovery） */
export function ftsQuery(value: string): string {
  return normalizeTag(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => `"${part.replaceAll('"', '')}"*`)
    .join(' OR ')
}

function exactQuery(normalized: string, nameType: 'canonical' | 'alias', limit: number): CatalogHit[] {
  const rows = db()
    .prepare(
      "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM names n JOIN records r ON r.record_id=n.record_id WHERE n.normalized_value=? AND n.name_type=? ORDER BY r.usage_count DESC, r.record_id LIMIT ?",
    )
    .all(normalized, nameType, limit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
  return rows.map((r) => ({
    match_type: nameType,
    prompt_form: r.prompt_form,
    record_id: r.record_id,
    usage_count: r.usage_count,
    raw: r.matched_name,
  }))
}

function fuzzyQuery(value: string, limit: number): CatalogHit[] {
  const fts = ftsQuery(value)
  if (!fts) return []
  const rows = db()
    .prepare(
      "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM catalog_fts f JOIN names n ON n.name_id=f.name_id JOIN records r ON r.record_id=f.record_id WHERE catalog_fts MATCH ? ORDER BY bm25(catalog_fts), r.usage_count DESC LIMIT ?",
    )
    .all(fts, limit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
  return rows.map((r) => ({
    match_type: 'fuzzy',
    prompt_form: r.prompt_form,
    record_id: r.record_id,
    usage_count: r.usage_count,
    raw: r.matched_name,
  }))
}

/** 匹配语义对齐 catalog/search.py：auto=canonical→alias→fuzzy 级联；exact=canonical→alias（无 fuzzy） */
export function searchCatalog(tag: string, opts?: CatalogQueryOptions): CatalogHit[] {
  const normalized = normalizeTag(tag)
  const limit = opts?.limit === undefined ? 20 : opts.limit
  if (!normalized || limit < 1) return []
  const mode = opts?.mode === 'exact' ? 'exact' : 'auto'
  const modes = mode === 'exact' ? (['canonical', 'alias'] as const) : (['canonical', 'alias', 'fuzzy'] as const)
  for (const m of modes) {
    const hits = m === 'fuzzy' ? fuzzyQuery(tag, limit) : exactQuery(normalized, m, limit)
    if (hits.length) return hits.slice(0, limit)
  }
  return []
}

/** 单标签类别判定（canonical/alias/fuzzy/miss）——测试与前端分流用 */
export function classifyTag(tag: string): MatchKind {
  const normalized = normalizeTag(tag)
  if (!normalized) return 'miss'
  const dbc = db()
  const canonical = dbc.prepare("SELECT 1 FROM names WHERE normalized_value=? AND name_type='canonical'").get(normalized)
  if (canonical) return 'canonical'
  const alias = dbc.prepare("SELECT 1 FROM names WHERE normalized_value=? AND name_type='alias'").get(normalized)
  if (alias) return 'alias'
  const fq = ftsQuery(tag)
  if (fq) {
    const n = dbc.prepare('SELECT COUNT(*) AS n FROM catalog_fts WHERE catalog_fts MATCH ?').get(fq) as { n: number }
    if (n.n > 0) return 'fuzzy'
  }
  return 'miss'
}

/** relation-overlay 缺失 → 降级空视图 + advisory（B3 定案） */
export function overlayView(): { tags: Record<string, string> } {
  return { tags: {} }
}

export function overlayStatus(): 'available' | 'unavailable' {
  return existsSync(defaultOverlayPath()) ? 'available' : 'unavailable'
}

export const OVERLAY_ADVISORY = 'overlay_unavailable'

export function catalogMeta(): { file: string; sizeBytes: number; tables: string[]; fts: boolean } {
  const tables = db()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name)
  const fts = tables.includes('catalog_fts')
  let sizeBytes = 0
  const path = catalogPath()
  try {
    sizeBytes = statSync(path).size
  } catch {
    /* path may be a file: URI fallback */
  }
  return { file: path, sizeBytes, tables, fts }
}

/** 便捷 close（测试隔离用） */
export function closeCatalog(): void {
  if (_db) { _db.close(); _db = null }
}

/** 预设 knowledge 目录推导（供 config 接线） */
export function knowledgeDir(): string {
  return dirname(defaultCatalogPath())
}