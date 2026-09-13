/**
 * catalog_artist_add（M4 T1，overlay 画师存在性登记）+ catalog_search 消费侧——TDD 先行。
 * 设计定夺（测试钉死）：
 * ① overlay 路线 = 与 relation-overlay **同库新表** artist_registry（同一 overlay sqlite，
 *    openOverlayDb 统一建表；源 tags.sqlite 零改动——只读连接 + 字节级断言）。
 * ② 消费语义：登记画师以 match_type **'alias'** 返回（对齐 G7 overlay accepted-alias 消费先例：
 *    overlay 来源命中走 alias 级语义）+ 新增 source 字段 'overlay_artist_registry' 明确标记；
 *    仅在 canonical/alias 级联零命中时补位（填隙语义——登记的目的是修复缺失画师，永不遮蔽真命中）；
 *    单级直查（canonical/alias/fuzzy）不注入。candidate 标记仍仅 fuzzy（存在性登记非候选）。
 * ③ evidence 必填非空（与 relations.submitProposal 的 ['llm-submission'] 缺省不同——防 LLM 灌水）。
 * ④ 幂等 = UPSERT 更新 evidence/confidence（二选一之「更新」分支：证据链可增补）。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerCatalogArtistAddTool } from '../../src/tools/catalog-artist-add.js'
import { runTool } from '../plugin/helpers.js'
import { setOverlayPath, listArtists } from '../../src/pe-framework/anima-knowledge/relations.js'
import { searchCatalog, catalogPath, closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'artist-add-test-'))
  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
})

afterEach(() => {
  setOverlayPath('')
  rmSync(tmp, { recursive: true, force: true })
})

afterAll(() => closeCatalog())

const def = () => registerCatalogArtistAddTool(null as never, {} as never)

describe('catalog_artist_add tool face (M4 T1)', () => {
  it('evidence is required and must be non-empty (missing / [] / whitespace-only all rejected, nothing written)', async () => {
    await expect(runTool({} as never, def(), { name: 'xu beihong' })).rejects.toThrow(/evidence/)
    await expect(runTool({} as never, def(), { name: 'xu beihong', evidence: [] })).rejects.toThrow(/evidence/)
    await expect(runTool({} as never, def(), { name: 'xu beihong', evidence: ['   '] })).rejects.toThrow(/evidence/)
    expect(listArtists()).toHaveLength(0)
  })
  it('name required; confidence bounds enforced', async () => {
    await expect(runTool({} as never, def(), { evidence: ['doc'] })).rejects.toThrow(/name/)
    await expect(runTool({} as never, def(), { name: 'a', evidence: ['doc'], confidence: 1.5 })).rejects.toThrow(/confidence/)
    await expect(runTool({} as never, def(), { name: 'a', evidence: ['doc'], confidence: -0.1 })).rejects.toThrow(/confidence/)
  })
  it('happy path: registers into overlay, source tags.sqlite byte-identical (mtime+size unchanged)', async () => {
    const src = catalogPath()
    const before = statSync(src)
    const out = JSON.parse(String(await runTool({} as never, def(), { name: 'xu beihong', evidence: ['batch B miss record', 'wiki page'], confidence: 0.7 })))
    const after = statSync(src)
    expect(out.ok).toBe(true)
    expect(out.created).toBe(true)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    const rows = listArtists()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('xu beihong')
    expect(rows[0].name_normalized).toBe('xu beihong')
    expect(rows[0].evidence).toEqual(['batch B miss record', 'wiki page'])
    expect(rows[0].confidence).toBe(0.7)
  })
  it('idempotent re-register same name: updates evidence/confidence (created:false, updated_at >= created_at)', async () => {
    await runTool({} as never, def(), { name: 'good smile company', evidence: ['e1'] })
    const first = listArtists()[0]
    const out = JSON.parse(String(await runTool({} as never, def(), { name: 'Good Smile Company', evidence: ['e1', 'e2'], confidence: 0.9 })))
    expect(out.ok).toBe(true)
    expect(out.created).toBe(false)
    const rows = listArtists()
    expect(rows).toHaveLength(1)
    expect(rows[0].name_normalized).toBe('good smile company')
    expect(rows[0].evidence).toEqual(['e1', 'e2'])
    expect(rows[0].confidence).toBe(0.9)
    expect(rows[0].updated_at >= rows[0].created_at).toBe(true)
    expect(rows[0].created_at).toBe(first.created_at)
  })
})

describe('catalog_search consumption of the artist registry (M4 T1)', () => {
  it('registered artist surfaces as alias hit with explicit source marker (gap-filling on miss)', async () => {
    await runTool({} as never, def(), { name: 'xu beihong', evidence: ['batch B miss record'] })
    const hits = searchCatalog('xu beihong', { mode: 'auto' })
    const reg = hits.find((h) => h.source === 'overlay_artist_registry')
    expect(reg, 'registry hit missing').toBeDefined()
    expect(reg!.match_type).toBe('alias')
    expect(reg!.prompt_form).toBe('xu beihong')
    // candidate 标记是 catalog_search 工具层产物（仅 fuzzy 置 true）；库级命中无该字段，
    // alias 级在工具层构造性为 false（见 catalog-search.ts flagged map）
    expect(reg!.match_type === 'fuzzy').toBe(false)
    expect(reg!.usage_count).toBeUndefined()
    expect(reg!.record_id).toBeUndefined()
  })
  it('exact mode includes registry hits; single-level direct modes do not', async () => {
    await runTool({} as never, def(), { name: 'xu beihong', evidence: ['doc'] })
    expect(searchCatalog('xu beihong', { mode: 'exact' }).some((h) => h.source === 'overlay_artist_registry')).toBe(true)
    expect(searchCatalog('xu beihong', { mode: 'canonical' }).some((h) => h.source === 'overlay_artist_registry')).toBe(false)
    expect(searchCatalog('xu beihong', { mode: 'alias' }).some((h) => h.source === 'overlay_artist_registry')).toBe(false)
    expect(searchCatalog('xu beihong', { mode: 'fuzzy' }).some((h) => h.source === 'overlay_artist_registry')).toBe(false)
  })
  it('canonical protection: real canonical hit is never shadowed or duplicated by the registry', async () => {
    await runTool({} as never, def(), { name: 'wlop', evidence: ['already canonical test'] })
    const hits = searchCatalog('wlop', { mode: 'auto' })
    expect(hits[0].match_type).toBe('canonical')
    expect(hits[0].source).toBeUndefined()
    expect(hits.filter((h) => h.source === 'overlay_artist_registry')).toHaveLength(0)
  })
  it('unregistered miss stays a clean miss (no registry contamination)', () => {
    const hits = searchCatalog('definitely nonexistent artist 83174', { mode: 'auto' })
    expect(hits.some((h) => h.source === 'overlay_artist_registry')).toBe(false)
  })
})
