import { afterAll, describe, expect, it } from 'vitest'
import { searchCatalog, searchCatalogSync, setVectorSearch, closeCatalog, queryCatalogInternal } from '../../../src/pe-framework/dialect/anima-catalog.js'

/** 取一条真实 canonical 记录作为 semantic stub 的 JOIN 目标（record_id 形态不对测试硬编码） */
function seedRecordId(tag: string): { record_id: string; prompt_form: string } {
  const hit = searchCatalogSync(tag, { mode: 'canonical', limit: 1 })[0]
  if (!hit?.record_id) throw new Error(`fixture seed missing: ${tag}`)
  return { record_id: hit.record_id, prompt_form: hit.prompt_form ?? tag }
}

afterAll(() => {
  setVectorSearch(null)
  closeCatalog()
})

describe('semantic level in auto cascade (spec §3.2)', () => {
  it('auto 级联前四级全空 → 落到 semantic 层（stub 向量层，零真库依赖）', async () => {
    const seed = seedRecordId('silvery hair')
    setVectorSearch(async (q) => (q === 'zzzzzzzzq' ? [{ record_id: seed.record_id, score: 0.82, text_source: 'wiki' as const }] : []))
    const hits = await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 })
    expect(hits[0]).toMatchObject({ match_type: 'semantic', prompt_form: seed.prompt_form, score: 0.82, text_source: 'wiki' })
  })

  it('字符串 tie-breaker：近 identical 拼写（lev_sim ≥0.8）提位到 semantic 序之前（selafuku 类拼写容错）', async () => {
    // T12-001 根因（模型分布特性）的确定性缓解：'selafuku' 与 'serafuku' 归一化 Levenshtein
    // 相似度 0.875 ≥ 0.8 → 提为第一梯队；'wafuku' 相似度 ~0.5 → 保持 semantic 序（即使分更高）。
    const near = seedRecordId('serafuku')
    const far = seedRecordId('wafuku')
    setVectorSearch(async () => [
      { record_id: far.record_id, score: 0.7359, text_source: 'fallback' as const },
      { record_id: near.record_id, score: 0.72, text_source: 'wiki' as const },
    ])
    const hits = await searchCatalog('selafuku', { mode: 'auto', limit: 5 })
    expect(hits[0].match_type).toBe('semantic')
    expect(hits[0].prompt_form).toBe('serafuku')
    expect(hits.map((h) => h.prompt_form)).toContain('wafuku')
  })

  it('字符串 tie-breaker 不触发于无近拼写命中的查询（zzzzzzzzq 类）', async () => {
    const seed = seedRecordId('silvery hair')
    setVectorSearch(async () => [{ record_id: seed.record_id, score: 0.82, text_source: 'wiki' as const }])
    const hits = await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 })
    expect(hits[0].prompt_form).toBe(seed.prompt_form) // 序保持 = 原 semantic 序
  })

  it("mode 'exact' 永不触发 semantic 层", async () => {
    let semanticQueried = false
    setVectorSearch(async () => {
      semanticQueried = true
      return []
    })
    expect(await searchCatalog('zzzzzzzzq', { mode: 'exact', limit: 5 })).toEqual([])
    expect(semanticQueried).toBe(false)
  })

  it('单级直查永不触发 semantic 层', async () => {
    let semanticQueried = false
    setVectorSearch(async () => {
      semanticQueried = true
      return []
    })
    expect(await searchCatalog('zzzzzzzzq', { mode: 'fuzzy', limit: 5 })).toEqual([])
    expect(semanticQueried).toBe(false)
  })

  it('前级命中（canonical）遮蔽 semantic 层', async () => {
    let semanticQueried = false
    setVectorSearch(async () => {
      semanticQueried = true
      return []
    })
    const hits = await searchCatalog('silvery hair', { mode: 'auto', limit: 5 })
    expect(hits[0].match_type).toBe('canonical')
    expect(semanticQueried).toBe(false)
  })

  it('semantic 命中 JOIN 不到 records → 丢弃（不凑数）', async () => {
    setVectorSearch(async () => [{ record_id: 'no-such-record-xyz', score: 0.9, text_source: 'fallback' }])
    expect(await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 })).toEqual([])
  })

  it('semantic 层剔除 @ 画师命中（spec §3.2 补齐，与 fuzzy F3 的 @ 剔除同口径）', async () => {
    // 取真实 @ 画师记录作 JOIN 目标——证明剔除来自 @ 过滤而非 JOIN-miss 巧合
    const atRows = queryCatalogInternal("SELECT record_id, prompt_form FROM records WHERE prompt_form LIKE '@%' LIMIT 1") as Array<{ record_id: string; prompt_form: string }>
    if (!atRows.length) throw new Error('fixture missing: no @-prefixed record in catalog')
    expect((atRows[0].prompt_form ?? '').startsWith('@')).toBe(true)
    const seed = seedRecordId('silvery hair')
    setVectorSearch(async () => [
      { record_id: atRows[0].record_id, score: 0.95, text_source: 'wiki' },
      { record_id: seed.record_id, score: 0.82, text_source: 'wiki' },
    ])
    const hits = await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 })
    expect(hits.some((h) => (h.prompt_form ?? h.raw ?? '').startsWith('@'))).toBe(false)
    // 非 @ 命中保留且前移（@ 命中不再占位）
    expect(hits[0]).toMatchObject({ match_type: 'semantic', prompt_form: seed.prompt_form, score: 0.82 })
  })

  it('向量层故障降级为空，不阻塞级联（增强层纪律）', async () => {
    setVectorSearch(async () => {
      throw new Error('embed boom')
    })
    expect(await searchCatalog('zzzzzzzzq', { mode: 'auto', limit: 5 })).toEqual([])
  })

  it('searchCatalogSync（同步双入口）永不触发 semantic 层', () => {
    let semanticQueried = false
    setVectorSearch(async () => {
      semanticQueried = true
      return []
    })
    expect(searchCatalogSync('zzzzzzzzq', { mode: 'auto', limit: 5 })).toEqual([])
    expect(semanticQueried).toBe(false)
  })
})
