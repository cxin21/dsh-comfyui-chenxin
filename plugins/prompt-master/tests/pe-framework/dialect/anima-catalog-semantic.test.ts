import { afterAll, describe, expect, it } from 'vitest'
import { searchCatalog, searchCatalogSync, setVectorSearch, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'

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
