/**
 * anima-knowledge/verify.ts — G3 目录健康深检（四项）：
 * ① checksum（manifest 对账，复用 resources/manifest 的 assertAnimaCatalog）
 * ② FTS 行数 == names 行数（计数平价）
 * ③ 4 表存在（records/names/catalog_fts/sources）
 * ④ schema 对齐（关键列存在性；表缺失时由 ③ 报错，此处只对存在的表做列对齐）
 * 每项独立 try/catch：单项失败不阻断其余检查（deep-check 契约）。
 */
import { queryCatalogInternal, catalogMeta } from '../dialect/anima-catalog.js'
import { assertAnimaCatalog } from '../resources/manifest.js'

export interface VerifyCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface VerifyResult {
  ok: boolean
  checks: VerifyCheck[]
}

export const EXPECTED_TABLES = ['records', 'names', 'catalog_fts', 'sources'] as const

/** 与 catalog/storage.py SCHEMA 对齐的关键列（存在性子集检查，非全列强校验） */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  records: ['record_id', 'canonical_name', 'prompt_form', 'category', 'usage_count', 'source_ids'],
  names: ['name_id', 'record_id', 'value', 'normalized_value', 'name_type'],
  sources: ['source_id', 'name'],
  catalog_fts: ['name_id', 'record_id', 'value', 'normalized_value'],
}

function runCheck(name: string, fn: () => string | undefined): VerifyCheck {
  try {
    const detail = fn()
    return detail === undefined ? { name, ok: true } : { name, ok: true, detail }
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

function countOf(table: string): number {
  return (queryCatalogInternal(`SELECT COUNT(*) AS n FROM ${table}`)[0] as { n: number }).n
}

export function verifyCatalog(): VerifyResult {
  const checks: VerifyCheck[] = [
    runCheck('checksum', () => {
      const r = assertAnimaCatalog()
      if (!r.ok) throw new Error(r.reason)
      return 'manifest sha256 matches file'
    }),
    runCheck('ftsParity', () => {
      const fts = countOf('catalog_fts')
      const names = countOf('names')
      if (fts !== names) throw new Error(`fts/names count mismatch (fts=${fts} names=${names})`)
      return `fts=${fts} == names=${names}`
    }),
    runCheck('tables', () => {
      const present = new Set(catalogMeta().tables)
      const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
      if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`)
      return `${EXPECTED_TABLES.length} tables present`
    }),
    runCheck('schema', () => {
      const present = new Set(catalogMeta().tables)
      const problems: string[] = []
      for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
        if (!present.has(table)) continue // 表缺失已由 tables 检查报告
        const actual = new Set(
          (queryCatalogInternal(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
        )
        const missingCols = required.filter((c) => !actual.has(c))
        if (missingCols.length) problems.push(`${table}: missing ${missingCols.join(', ')}`)
      }
      if (problems.length) throw new Error(`schema misaligned — ${problems.join('; ')}`)
      return 'required columns aligned'
    }),
  ]
  return { ok: checks.every((c) => c.ok), checks }
}
