import { describe, expect, it, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchCatalog, classifyTag, closeCatalog, setVectorSearch } from '../../../src/pe-framework/dialect/anima-catalog.js'
import { setOverlayPath, openOverlayDb, submitProposal, decideProposal } from '../../../src/pe-framework/anima-knowledge/relations.js'

let tmp: string

// 本文件专测前四级级联 + G7 overlay 语义——semantic 是独立增强层（spec §3.2），在此钉死禁用，
// 使 miss 断言不被真实向量库（若存在）的 semantic 命中污染；semantic 行为见 anima-catalog-semantic.test.ts
beforeAll(() => setVectorSearch(null))
afterAll(() => { setVectorSearch(null); closeCatalog() })

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pm-g7-'))
  setOverlayPath(join(tmp, 'temp', 'anima-prompt-v1', 'relation-overlay.sqlite'))
})

afterEach(() => {
  setOverlayPath('')
  rmSync(tmp, { recursive: true, force: true })
})

describe('G7: single-mode query (direct, no cascade)', () => {
  it("mode 'canonical' skips alias level (wave → miss)", async () => {
    expect(await searchCatalog('wave', { mode: 'canonical' })).toEqual([])
  })

  it("mode 'alias' resolves alias directly", async () => {
    const hits = await searchCatalog('wave', { mode: 'alias' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].match_type).toBe('alias')
    expect(hits[0].prompt_form).toBe('waving')
  })

  it("mode 'fuzzy' goes straight to fuzzy level", async () => {
    const hits = await searchCatalog('silver hair', { mode: 'fuzzy' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].match_type).toBe('fuzzy')
  })

  it('single modes respect limit', async () => {
    expect(await searchCatalog('silver hair', { mode: 'fuzzy', limit: 1 })).toHaveLength(1)
  })
})

describe('G7: categories / sources filters', () => {
  it('categories filter keeps matching category', async () => {
    const hits = await searchCatalog('silvery hair', { mode: 'canonical', categories: ['hair'] })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].record_id).toBeDefined()
  })

  it('categories filter drops non-matching category', async () => {
    expect(await searchCatalog('silvery hair', { mode: 'canonical', categories: ['pose'] })).toEqual([])
  })

  it('sources filter accepts the record source', async () => {
    const hits = await searchCatalog('silvery hair', {
      mode: 'canonical',
      sources: ['gelbooru_canonical:4dd87da139254abc9f18d2da04ee7b6b691d4e63'],
    })
    expect(hits.length).toBeGreaterThan(0)
  })

  it('sources filter drops foreign source', async () => {
    expect(await searchCatalog('silvery hair', {
      mode: 'canonical',
      sources: ['official_anima_rule:protocol-v1@anima-f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b'],
    })).toEqual([])
  })
})

describe('G7: overlay accepted-alias resolution in cascade', () => {
  /** 直接在 overlay 里落一条 accepted 提案（绕过验证链——该链在 T6 已测） */
  function seedAccepted(from: string, to: string, relation: 'parent' | 'child' | 'related' = 'related') {
    const db = openOverlayDb()
    try {
      db.prepare(
        `INSERT INTO relation_proposals
         (proposal_id, from_record_id, to_record_id, relation_type, status, confidence, source, rationale, model, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'accepted', 0.9, 'llm', 'test seed', 'test', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      ).run(`rel:seed-${from}-${to}`, from, to, relation)
    } finally {
      db.close()
    }
  }

  it('auto cascade appends overlay accepted alias after fuzzy hits (alias 级追加)', async () => {
    const fuzzyCount = (await searchCatalog('glistening hair', { mode: 'fuzzy', limit: 100000 })).length
    expect(fuzzyCount).toBeGreaterThan(0)
    seedAccepted('glistening hair', 'waving')
    const limit = fuzzyCount + 1 // 留 1 个追加位
    const hits = await searchCatalog('glistening hair', { limit })
    expect(hits).toHaveLength(limit)
    expect(hits[fuzzyCount].match_type).toBe('alias')
    expect(hits[fuzzyCount].prompt_form).toBe('waving')
  })

  it('overlay alias also appends in exact mode', async () => {
    seedAccepted('glistening hair', 'waving', 'parent')
    const hits = await searchCatalog('glistening hair', { mode: 'exact' })
    expect(hits[0].match_type).toBe('alias')
  })

  it('canonical protection: real canonical hit is never downgraded by overlay', async () => {
    seedAccepted('silvery hair', 'waving') // silvery hair 本身就是 canonical
    const hits = await searchCatalog('silvery hair')
    expect(hits[0].match_type).toBe('canonical')
    expect(hits[0].prompt_form).toBe('silvery hair')
  })

  it('overlay alias does not fire when overlay is empty (golden 行为不变)', async () => {
    expect(await searchCatalog('zzzzzzzzq')).toEqual([])
    expect(classifyTag('wave')).toBe('alias')
  })

  it('G7 fix: overlay alias hits respect categories/sources filters (filter active → overlay target 被过滤掉)', async () => {
    seedAccepted('glistening hair', 'waving')
    // 不带过滤：overlay alias 命中在（对照）
    expect((await searchCatalog('glistening hair', { mode: 'exact' })).length).toBeGreaterThan(0)
    // categories 过滤不含目标 record → overlay 命中被过滤排除
    expect(await searchCatalog('glistening hair', { mode: 'exact', categories: ['nonexistent_category_xyz'] })).toEqual([])
    // sources 过滤同理
    expect(await searchCatalog('glistening hair', { mode: 'exact', sources: ['official_anima_rule:protocol-v1@anima-f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b'] })).toEqual([])
  })

  it('MF-1: underscore-endpoint round-trip — submit(underline) → accept → searchCatalog(normalized) surfaces overlay alias', async () => {
    // 'blue hair' 是真实 catalog 端点（classifyTag 走 normalizeTag → 查 names.normalized_value）
    expect(classifyTag('blue_hair')).toBe('canonical')
    const sub = submitProposal(
      { source_tag: 'blue_hair', target_tag: 'waving', relation: 'related', rationale: 'test round-trip', evidence: ['taxonomy'] },
      { classify: classifyTag },
    )
    if (!('proposal_id' in sub)) throw new Error(`submit failed: ${JSON.stringify(sub)}`)
    decideProposal(sub.proposal_id, 'accept')
    // 'blue hair' 本身是 canonical：cascade 命中在前，overlay alias 追加在后（永不降级）
    const hits = await searchCatalog('blue hair', { limit: 100000 })
    const overlayHits = hits.filter((h) => h.prompt_form === 'waving')
    expect(overlayHits.length).toBeGreaterThan(0)
    expect(overlayHits[0].match_type).toBe('alias')
  })
})