import { describe, expect, it } from 'vitest'
import { registerStyleListTool } from '../../src/tools/style-list.js'
import { stubCtx, runTool } from '../plugin/helpers.js'

const def = () => registerStyleListTool(null as never, {} as never)

describe('style_list (spec §9)', () => {
  it('no filter returns all presets with the summary shape', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {})))
    expect(Array.isArray(raw)).toBe(true)
    // M2 数据里程碑：55 → 批次递增（T4 +7=62；T8 收口总账收紧为 82）
    expect(raw.length).toBe(62)
    const ids = new Set(raw.map((p: { id: string }) => p.id))
    expect(ids.size).toBe(62)
    for (const p of raw) {
      for (const k of ['id', 'name', 'category', 'rating', 'artistCount', 'negativeCount', 'source']) {
        expect(k in p, `missing key ${k}`).toBe(true)
      }
      expect(typeof p.artistCount).toBe('number')
      expect(typeof p.negativeCount).toBe('number')
    }
  })
  it('rating filter semantics = registry maxRating (preset.rating ≤ cap)', async () => {
    const safe = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'safe' })))
    for (const p of safe) expect(p.rating).toBe('safe')
    // 当前数据全为 safe：任一上限 ≥ safe 都应返回全量（cap 语义，非精确相等；计数随 M2 批次递增）
    const sensitive = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'sensitive' })))
    expect(sensitive.length).toBe(62)
    const explicit = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'explicit' })))
    expect(explicit.length).toBe(62)
  })
  it('category and applies_to filters', async () => {
    const anime = JSON.parse(String(await runTool(stubCtx(), def(), { category: 'anime' })))
    expect(anime.length).toBeGreaterThan(0)
    for (const p of anime) expect(p.category).toBe('anime')
    const anima = JSON.parse(String(await runTool(stubCtx(), def(), { applies_to: 'anima' })))
    expect(anima.length).toBe(62)
    const graphic = JSON.parse(String(await runTool(stubCtx(), def(), { category: 'graphic' })))
    expect(graphic.map((p: { id: string }) => p.id).sort()).toEqual([
      'nb20_简约线条高饱和高对比风', 'nb35_高亮平涂矢量轻漫风格', 'nb43_粗砺墨线限色高反差平涂风',
    ])
  })
  it('query matches id/name substring case-insensitively', async () => {
    const hits = JSON.parse(String(await runTool(stubCtx(), def(), { query: 'rella' })))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((p: { id: string }) => p.id.startsWith('nb01'))).toBe(true)
    const upper = JSON.parse(String(await runTool(stubCtx(), def(), { query: 'RELLA' })))
    expect(upper.length).toBe(hits.length)
  })
  it('invalid enum inputs fail with explicit message', async () => {
    await expect(runTool(stubCtx(), def(), { rating: 'bogus' })).rejects.toThrow(/rating/)
    await expect(runTool(stubCtx(), def(), { category: 'bogus' })).rejects.toThrow(/category/)
    await expect(runTool(stubCtx(), def(), { applies_to: 'bogus' })).rejects.toThrow(/applies_to/)
  })
  it('combined filters intersect', async () => {
    const mixed = JSON.parse(String(await runTool(stubCtx(), def(), { category: 'anime', rating: 'safe', applies_to: 'anima', query: 'rella' })))
    expect(mixed.length).toBeGreaterThan(0)
    for (const p of mixed) {
      expect(p.category).toBe('anime')
      expect(p.rating).toBe('safe')
    }
  })
})
