/**
 * Anima tag-catalog 查询层（P2 定案）。
 * 来源：comfyui-chenxin preset knowledge/tag-catalog.sqlite（FTS5 1.39M 行）+ catalog/search.py 匹配语义。
 * node:sqlite DatabaseSync 只读直读；级联匹配：
 * - searchCatalogSync（同步双入口，spec §3.2）：canonical→alias→artistRegistry→fuzzy（mode auto）；
 *   'exact' = 不含 fuzzy 的精确级联——永不触发 semantic 层（grounding/F2/存在性判定专用）。
 * - searchCatalog（异步公共入口，spec §3.2）：同步级联结果之上，仅 mode='auto' 且前级全空时
 *   末位追加 semantic 向量层（enhancement：任何故障降级为空，不阻塞前四级）。
 */
import { DatabaseSync } from 'node:sqlite'
import { statSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveKnowledgePath } from '../resources/resolve.js'
import { assertAnimaCatalog } from '../resources/manifest.js'
import { openOverlayDb, overlayPath as overlayLibraryPath } from '../anima-knowledge/relations.js'
import { createVectorSearch, type SemanticHit } from './anima-vector.js'

export interface CatalogHit {
  match_type: 'canonical' | 'alias' | 'fuzzy' | 'semantic' | 'miss'
  prompt_form?: string
  record_id?: string
  usage_count?: number
  raw?: string
  /** M4 T1：来源标记——仅 overlay artist registry 命中携带 'overlay_artist_registry'；
   *  catalog 原生命中不带此字段（undefined = 真实 catalog 记录）。 */
  source?: string
  /** semantic 层专有（spec §3.2）：score = 1 - 向量距离（余弦相似度）；text_source = 建库文本来源 */
  score?: number
  text_source?: 'wiki' | 'fallback'
}

export interface CatalogQueryOptions {
  /** G7：auto/exact 级联之外支持单级直查（canonical/alias/fuzzy） */
  mode?: 'auto' | 'exact' | 'canonical' | 'alias' | 'fuzzy'
  limit?: number
  /** G7：records.category 白名单（下划线/空格等价归一） */
  categories?: string[]
  /** G7：source 白名单（names.source_id 精确匹配 ∪ records.source_ids 包含匹配）。
   *  overlay accepted 别名命中同样受 categories/sources 过滤（目标端解析走 records JOIN）。 */
  sources?: string[]
}

export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'

const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })

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

/* ── semantic 层 seam（spec §3.2/§6）：惰性装配，测试可注入/禁用（null=禁用语义层）──
 * 增强层纪律：装配失败 → null（语义层静默缺席），前四级级联永不受阻；查询期零网络
 * （向量库缺失时 createVectorSearch 的查询闭包自降级为空，模型永不加载）。 */
let vectorSearch: ((q: string, k: number) => Promise<SemanticHit[]>) | null | undefined

/** 测试/调用方注入 seam：传 null 显式禁用语义层（此后 getVectorSearch 恒为 null，不再惰性装配） */
export function setVectorSearch(s: ((q: string, k: number) => Promise<SemanticHit[]>) | null): void {
  vectorSearch = s
}

function getVectorSearch(): ((q: string, k: number) => Promise<SemanticHit[]>) | null {
  if (vectorSearch === undefined) {
    try {
      vectorSearch = createVectorSearch()
    } catch {
      vectorSearch = null
    }
  }
  return vectorSearch
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

/** G7 过滤子句：categories / sources → WHERE 片段 + 参数（全部参数化，无注入面） */
function filterClause(categories?: string[], sources?: string[]): { sql: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  if (categories?.length) {
    const values = new Set<string>()
    for (const raw of categories) {
      const trimmed = raw.trim().toLowerCase()
      if (!trimmed) continue
      values.add(trimmed)
      values.add(trimmed.replaceAll(' ', '_'))
      values.add(trimmed.replaceAll('_', ' '))
    }
    const list = [...values]
    if (list.length) {
      clauses.push(`r.category IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
  }
  if (sources?.length) {
    const clean = sources.map((s) => s.trim()).filter(Boolean)
    if (clean.length) {
      // 每个 source 两个匹配面：names.source_id 精确 ∪ records.source_ids（JSON 数组文本）带引号包含
      clauses.push(`(n.source_id IN (${clean.map(() => '?').join(',')}) OR (${clean.map(() => 'r.source_ids LIKE ?').join(' OR ')}))`)
      params.push(...clean)
      params.push(...clean.map((s) => `%"${s.replaceAll('"', '')}"%`))
    }
  }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params }
}

function exactQuery(normalized: string, nameType: 'canonical' | 'alias', limit: number, categories?: string[], sources?: string[]): CatalogHit[] {
  const filter = filterClause(categories, sources)
  const rows = db()
    .prepare(
      "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM names n JOIN records r ON r.record_id=n.record_id WHERE n.normalized_value=? AND n.name_type=?" + filter.sql + " ORDER BY r.usage_count DESC, r.record_id LIMIT ?",
    )
    .all(normalized, nameType, ...filter.params, limit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
  return rows.map((r) => ({
    match_type: nameType,
    prompt_form: r.prompt_form,
    record_id: r.record_id,
    usage_count: r.usage_count,
    raw: r.matched_name,
  }))
}

/* ── F3（三期 Task 1）：fuzzy 候选噪声过滤（确定性，零 LLM）──
 * 真实会话暴露 fuzzy 候选混入 `@willowsoft`/`@classicalbluess`/`skinny` 等噪声：
 * ① 剔除 '@' 开头的用户名型候选；② 剔除与原查询字符 Jaccard 重合率 < 0.4 的候选。
 * 过滤后不足 limit 就少给，不凑数；在 fuzzyQuery 输出前统一生效（所有消费点受益）。 */

/** 字符重合率阈值（Jaccard：|q∩c| / |q∪c|，空白不计） */
export const FUZZY_CANDIDATE_MIN_OVERLAP = 0.4

/** 候选与原查询的字符重合率（归一化去空格后的字符多重集 Jaccard；任一侧为空 → 0）。
 *  用多重集而非集合：`rim light` vs `rimworld` 集合版恰在 0.4 边界漏过，多重集版 0.33 被剔。 */
export function charOverlap(query: string, candidate: string): number {
  const q = normalizeTag(query).replace(/\s+/g, '').split('').sort()
  const c = normalizeTag(candidate).replace(/\s+/g, '').split('').sort()
  if (!q.length || !c.length) return 0
  let inter = 0
  let j = 0
  for (const ch of q) {
    while (j < c.length && c[j] < ch) j++
    if (j < c.length && c[j] === ch) { inter++; j++ }
  }
  return inter / (q.length + c.length - inter)
}

/** F3 过滤：剔 '@' 开头候选与重合率 <0.4 候选；不凑数 */
export function filterFuzzyCandidates(query: string, hits: CatalogHit[]): CatalogHit[] {
  return hits.filter((h) => {
    const display = h.prompt_form ?? h.raw ?? ''
    if (!display) return false
    if (display.trim().startsWith('@')) return false
    return charOverlap(query, display) >= FUZZY_CANDIDATE_MIN_OVERLAP
  })
}

function fuzzyQuery(value: string, limit: number, categories?: string[], sources?: string[]): CatalogHit[] {
  const fts = ftsQuery(value)
  if (!fts) return []
  const filter = filterClause(categories, sources)
  const sql =
    "SELECT r.record_id, r.prompt_form, r.usage_count, n.value AS matched_name FROM catalog_fts f JOIN names n ON n.name_id=f.name_id JOIN records r ON r.record_id=f.record_id WHERE catalog_fts MATCH ?" + filter.sql + " ORDER BY bm25(catalog_fts), r.usage_count DESC LIMIT ?"
  // F3：输出前噪声过滤（'@' 用户名型 + 字符重合率 <0.4）。SQL LIMIT 先于过滤截断会挤掉有效候选，
  // 故单次 4× 超额取数再过滤、截回 limit；仍不足就少给，不凑数（不做迭代重取——FTS 全量打分成本高）。
  const project = (r: { record_id: string; prompt_form: string; usage_count: number; matched_name: string }): CatalogHit => ({
    match_type: 'fuzzy',
    prompt_form: r.prompt_form,
    record_id: r.record_id,
    usage_count: r.usage_count,
    raw: r.matched_name,
  })
  const fetchLimit = Math.min(limit * 4, 100000)
  const rows = db().prepare(sql).all(fts, ...filter.params, fetchLimit) as Array<{ record_id: string; prompt_form: string; usage_count: number; matched_name: string }>
  return filterFuzzyCandidates(value, rows.map(project)).slice(0, limit)
}

/** G7 overlay accepted-alias：auto/exact 级联全部落空后，读 overlay accepted 提案
 *  （from_record_id=查询 tag）→ 目标端按 canonical→alias 解析，命中以 alias 级返回。
 *  canonical 保护：本函数只在 catalog 级联零命中时执行，真实 canonical/alias 命中永不降级。
 *  G7：categories/sources 过滤透传到目标端 exactQuery 解析（overlay 命中走 records JOIN，真实过滤而非豁免）。 */
function overlayAliasHits(normalized: string, limit: number, categories?: string[], sources?: string[]): CatalogHit[] {
  if (!existsSync(overlayLibraryPath())) return []
  const odb = openOverlayDb()
  try {
    const rows = odb
      .prepare(
        "SELECT DISTINCT to_record_id FROM relation_proposals WHERE status='accepted' AND from_record_id=? ORDER BY to_record_id",
      )
      .all(normalized) as Array<{ to_record_id: string }>
    const hits: CatalogHit[] = []
    for (const row of rows) {
      const target = normalizeTag(row.to_record_id)
      if (!target) continue
      const resolved = exactQuery(target, 'canonical', limit - hits.length, categories, sources).length
        ? exactQuery(target, 'canonical', limit - hits.length, categories, sources)
        : exactQuery(target, 'alias', limit - hits.length, categories, sources)
      for (const h of resolved) {
        hits.push({ ...h, match_type: 'alias' })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  } finally {
    odb.close()
  }
}

/** M4 T1 artist registry 命中：normalized 精确匹配 overlay artist_registry（填隙语义——
 *  仅在 canonical/alias 级联零命中时消费；match_type 'alias' 对齐 G7 overlay-alias 消费
 *  先例，source 字段 'overlay_artist_registry' 明确标记；无 record_id/usage_count——
 *  登记的是存在性而非 catalog 记录）。 */
function artistRegistryHits(normalized: string, limit: number): CatalogHit[] {
  if (!existsSync(overlayLibraryPath())) return []
  const odb = openOverlayDb()
  try {
    const rows = odb
      .prepare('SELECT name FROM artist_registry WHERE name_normalized=? LIMIT ?')
      .all(normalized, limit) as Array<{ name: string }>
    return rows.map((r) => ({
      match_type: 'alias' as const,
      prompt_form: r.name,
      raw: r.name,
      source: 'overlay_artist_registry',
    }))
  } finally {
    odb.close()
  }
}

/** 同步级联双入口（Ruling 1/3 双入口拆分，spec §3.2）：canonical→alias→artistRegistry→fuzzy
 *  （mode auto）+ G7 overlay accepted 别名追加；'exact' = 无 fuzzy；单级直查。
 *  服务一切同步消费方（catalog-recall 召回、groundSlotTags/F2 的 search seam、测试注入）——
 *  本函数【永不触发 semantic 层】：grounding/F2 只认 canonical/alias，关系提案端点存在性
 *  校验要求权威判定，语义近似命中不得进入这些路径（设计定案，见 classifyTag 注释）。 */
export function searchCatalogSync(tag: string, opts?: CatalogQueryOptions): CatalogHit[] {
  const normalized = normalizeTag(tag)
  const limit = opts?.limit === undefined ? 20 : opts.limit
  if (!normalized || limit < 1) return []
  const modeRaw = opts?.mode ?? 'auto'
  const single = modeRaw === 'canonical' || modeRaw === 'alias' || modeRaw === 'fuzzy' ? modeRaw : null
  if (single === 'fuzzy') return fuzzyQuery(tag, limit, opts?.categories, opts?.sources)
  if (single) return exactQuery(normalized, single, limit, opts?.categories, opts?.sources)
  const mode = modeRaw === 'exact' ? 'exact' : 'auto'
  const levels: Array<() => CatalogHit[]> = [
    () => exactQuery(normalized, 'canonical', limit, opts?.categories, opts?.sources),
    () => exactQuery(normalized, 'alias', limit, opts?.categories, opts?.sources),
    () => artistRegistryHits(normalized, limit),
  ]
  if (mode === 'auto') levels.push(() => fuzzyQuery(tag, limit, opts?.categories, opts?.sources))
  let cascadeHits: CatalogHit[] = []
  for (const level of levels) {
    const hits = level()
    if (hits.length) { cascadeHits = hits.slice(0, limit); break }
  }
  // G7：级联结果之后追加 overlay accepted 别名命中（alias 级；canonical/alias 命中在前，永不降级）
  if (cascadeHits.length >= limit) return cascadeHits
  const overlay = overlayAliasHits(normalized, limit - cascadeHits.length, opts?.categories, opts?.sources)
  return overlay.length ? [...cascadeHits, ...overlay] : cascadeHits
}

/** semantic 命中 → catalog records JOIN（spec §3.2）：按 record_id 取 prompt_form/usage_count，
 *  JOIN 不到的丢弃（不凑数——向量库与 catalog 重建时间差可能产生悬空 record_id）；
 *  @ 画师命中剔除（spec §3.2：semantic 层与 fuzzy F3 同口径——'@' 用户名/画师型记录不得进入
 *  语义近似结果；t6 探针实证 @-artist 占位 5/10 槽位后补齐）。 */
function joinWithCatalog(sem: SemanticHit[]): CatalogHit[] {
  const out: CatalogHit[] = []
  for (const s of sem) {
    if (!s.record_id) continue
    const rows = db()
      .prepare('SELECT prompt_form, usage_count FROM records WHERE record_id=?')
      .all(s.record_id) as Array<{ prompt_form: string; usage_count: number }>
    const row = rows[0]
    if (!row) continue
    if ((row.prompt_form ?? '').trim().startsWith('@')) continue
    out.push({
      match_type: 'semantic',
      record_id: s.record_id,
      prompt_form: row.prompt_form,
      usage_count: row.usage_count,
      score: s.score,
      text_source: s.text_source,
    })
  }
  return out
}

/** 归一化 Levenshtein 相似度：1 - dist/max(len)；任一侧空串 → 0。
 *  拼写容错 tie-breaker（附录 A1 遗留处置①）用——'selafuku'/'serafuku' = 0.875。 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  if (!a.length || !b.length) return 0
  const n = b.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    ;[prev, curr] = [curr, prev]
  }
  return 1 - prev[n] / Math.max(a.length, n)
}

/** tie-breaker 提位阈值：归一化 Levenshtein ≥ 0.8 视为"查询词的近 identical 拼写"
 *  （'selafuku'/'serafuku'=0.875 ✓；'serfafuku'=0.78 ✗；退化 'serafuku,'=0.78 ✗）。 */
export const STRING_TIEBREAK_SIMILARITY = 0.8

/** 拼写容错 tie-breaker（spec 附录 A1 遗留处置①，T12-001 根因的确定性缓解）：
 *  semantic 相似度分对"查询词的近重复短 passage"天然挤顶，而正确 tag 的 wiki 富化长
 *  passage 被长度稀释——对 semantic 命中按与查询词的归一化 Levenshtein 相似度分桶：
 *  ≥0.8 提为第一梯队（相似度降序、semantic 分降序），其余保持 semantic 序。
 *  确定性、零 LLM、零重建；@ 过滤已在 joinWithCatalog 先行。 */
function applyStringTieBreak(query: string, hits: CatalogHit[]): CatalogHit[] {
  if (hits.length < 2) return hits
  const q = normalizeTag(query)
  if (!q) return hits
  const scored = hits.map((h) => {
    const form = normalizeTag(h.prompt_form ?? h.raw ?? '')
    return { h, sim: form ? levenshteinSimilarity(q, form) : 0 }
  })
  const promoted = scored.filter((s) => s.sim >= STRING_TIEBREAK_SIMILARITY)
  if (!promoted.length) return hits
  promoted.sort((a, b) => b.sim - a.sim || (b.h.score ?? 0) - (a.h.score ?? 0))
  const rest = scored.filter((s) => s.sim < STRING_TIEBREAK_SIMILARITY).map((s) => s.h)
  return [...promoted.map((s) => s.h), ...rest]
}

/** 异步公共入口（spec §3.2）：searchCatalogSync 结果之上，仅 mode='auto' 且前级全空
 *  （canonical→alias→artistRegistry→fuzzy→overlay 均零命中）时末位追加 semantic 层；
 *  'exact' 与单级直查永不触发。增强层纪律：向量层任何故障（缺失/嵌入异常/JOIN 空）
 *  降级为空返回，不阻塞、不抛出。调用方注意：本函数为 async——judge-assembly 证据适配器、
 *  catalog_search 工具等异步消费方 await；同步消费方（grounding/F2/召回）必须用 searchCatalogSync。 */
export async function searchCatalog(tag: string, opts?: CatalogQueryOptions): Promise<CatalogHit[]> {
  const hits = searchCatalogSync(tag, opts)
  const modeRaw = opts?.mode ?? 'auto'
  if (modeRaw !== 'auto' || hits.length > 0) return hits
  const normalized = normalizeTag(tag)
  const limit = opts?.limit === undefined ? 20 : opts.limit
  if (!normalized || limit < 1) return hits
  const vs = getVectorSearch()
  if (!vs) return hits
  try {
    const sem = await vs(normalized, limit)
    if (!sem.length) return hits
    const joined = applyStringTieBreak(normalized, joinWithCatalog(sem))
    return joined.length ? joined : hits
  } catch {
    // 增强层纪律：语义层故障只降级为空，永不阻塞前四级级联结果
    return hits
  }
}

/** 单标签类别判定（canonical/alias/fuzzy/miss）——测试与前端分流用。
 *  [设计定案 2026-09-15，spec §3.2 双入口拆分] classifyTag 不接入 semantic 层：MatchKind
 *  不新增 'semantic' 值、本函数不做任何向量查询。原因：关系提案端点（catalog_relations）
 *  的存在性校验要求权威 catalog 判定，语义近似命中不得放行；semantic 是 auto 级联末位的
 *  增强层，只存在于异步公共入口 searchCatalog，不改变存在性分类语义。 */
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
  // MF-2：探针与 relations.ts 写入路径一致（overlayLibraryPath = <preset>/temp/anima-prompt-v1/relation-overlay.sqlite），
  // 不再探 knowledge 目录的旧位置；env ANIMA_OVERLAY_PATH / setOverlayPath 覆盖同样生效。
  return existsSync(overlayLibraryPath()) ? 'available' : 'unavailable'
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

/** G3（Task 2）anima-knowledge browse/stats/verify 的最小内部 SQL 通道（brief option a）：
 *  复用句柄缓存 + mtime 重开 + manifest 对账，不导出 _db 本体。只读 SELECT 用。 */
export function queryCatalogInternal(sql: string, params: readonly (string | number | null)[] = []): unknown[] {
  return db().prepare(sql).all(...params)
}

/** 便捷 close（测试隔离用） */
export function closeCatalog(): void {
  if (_db) { _db.close(); _db = null }
}

/** 预设 knowledge 目录推导（供 config 接线） */
export function knowledgeDir(): string {
  return dirname(defaultCatalogPath())
}