/**
 * Anima tag-catalog 查询层（P2 定案）。
 * 来源：comfyui-chenxin preset knowledge/tag-catalog.sqlite（FTS5 1.39M 行）+ catalog/search.py 匹配语义。
 * node:sqlite DatabaseSync 只读直读；canonical→alias→fuzzy 级联（mode auto）；'exact' = 不含 fuzzy 的精确级联。
 */
import { DatabaseSync } from 'node:sqlite'
import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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

const DEFAULT_CATALOG_PATH = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite'
const OVERLAY_PATH = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge/relation-overlay.sqlite'

let _db: DatabaseSync | null = null
let _dbPath = process.env.ANIMA_CATALOG_PATH ?? DEFAULT_CATALOG_PATH

export function catalogPath(): string {
  return _dbPath
}

export function setCatalogPath(path: string): void {
  if (_db) { _db.close(); _db = null }
  _dbPath = path
}

function db(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(_dbPath, { readOnly: true })
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
  return existsSync(OVERLAY_PATH) ? 'available' : 'unavailable'
}

export const OVERLAY_ADVISORY = 'overlay_unavailable'

export function catalogMeta(): { file: string; sizeBytes: number; tables: string[]; fts: boolean } {
  const tables = db()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name)
  const fts = tables.includes('catalog_fts')
  let sizeBytes = 0
  try {
    sizeBytes = statSync(_dbPath).size
  } catch {
    /* path may be a file: URI fallback */
  }
  return { file: _dbPath, sizeBytes, tables, fts }
}

/** 便捷 close（测试隔离用） */
export function closeCatalog(): void {
  if (_db) { _db.close(); _db = null }
}

/** 预设 knowledge 目录推导（供 config 接线） */
export function knowledgeDir(): string {
  return join('C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge')
}