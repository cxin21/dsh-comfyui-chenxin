/**
 * anima-knowledge/browse.ts — G3 目录浏览/统计（无查询词扫描面）。
 * 数据通道：anima-catalog 的 queryCatalogInternal（option a）——共享句柄缓存、
 * mtime 重开与 manifest 对账，本模块不自行打开 DatabaseSync。
 */
import { queryCatalogInternal } from '../dialect/anima-catalog.js'
import type { CatalogHit } from '../dialect/anima-catalog.js'

export interface BrowseOptions {
  category?: string
  source?: string
  limit?: number
}

const DEFAULT_LIMIT = 20

/** 无查询词扫描：records 按 usage_count 降序，可选 category / source（sources.name）过滤 */
export function browseCatalog(opts?: BrowseOptions): CatalogHit[] {
  const limit = opts?.limit === undefined ? DEFAULT_LIMIT : opts.limit
  if (limit < 1) return []
  const category = opts?.category?.trim() || null
  const source = opts?.source?.trim() || null
  const rows = queryCatalogInternal(
    `SELECT r.record_id, r.prompt_form, r.usage_count, r.canonical_name AS matched_name
     FROM records r
     WHERE (? IS NULL OR r.category = ?)
       AND (? IS NULL OR EXISTS (
         SELECT 1 FROM json_each(r.source_ids) je JOIN sources s ON s.source_id = je.value WHERE s.name = ?))
     ORDER BY r.usage_count DESC, r.record_id
     LIMIT ?`,
    [category, category, source, source, limit],
  ) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
  return rows.map((r) => ({
    match_type: 'canonical',
    prompt_form: r.prompt_form,
    record_id: r.record_id,
    usage_count: r.usage_count,
    raw: r.matched_name,
  }))
}

export interface CatalogStats {
  records: number
  names: number
  ftsRows: number
}

/** 三计数：records / names / catalog_fts 行数（1.37M / 1.39M / =names 量级） */
export function catalogStats(): CatalogStats {
  const count = (table: string): number => (queryCatalogInternal(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n
  return { records: count('records'), names: count('names'), ftsRows: count('catalog_fts') }
}
