import { describe, expect, it } from 'vitest'
import { registerStyleListTool } from '../../src/tools/style-list.js'
import { loadStylePresets } from '../../src/pe-framework/styles/registry.js'
import { stubCtx, runTool } from '../plugin/helpers.js'

const def = () => registerStyleListTool(null as never, {} as never)

describe('style_list (spec §9)', () => {
  it('no filter returns all presets with the summary shape', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {})))
    expect(Array.isArray(raw)).toBe(true)
    // M2 数据里程碑：55 → 批次递增（T4 +7=62；T5 +5=67；T6 +5=72；T7 +6=78；T8 +4=82 收口总账）
    expect(raw.length).toBe(82)
    const ids = new Set(raw.map((p: { id: string }) => p.id))
    expect(ids.size).toBe(82)
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
    // T7 起 sensitive 预设在库、T8 起 explicit 预设在库：safe 上限=72（隔离 D6+E4）、
    // sensitive 上限=78（再隔离 E4）、explicit 上限=全量 82——三档 cap 精确语义由
    // 批 D d.test / 批 E e.test 活体断言双覆盖，此处收口计数。
    const sensitive = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'sensitive' })))
    expect(sensitive.length).toBe(78)
    const explicit = JSON.parse(String(await runTool(stubCtx(), def(), { rating: 'explicit' })))
    expect(explicit.length).toBe(82)
  })
  it('category and applies_to filters', async () => {
    const anime = JSON.parse(String(await runTool(stubCtx(), def(), { category: 'anime' })))
    expect(anime.length).toBeGreaterThan(0)
    for (const p of anime) expect(p.category).toBe('anime')
    const anima = JSON.parse(String(await runTool(stubCtx(), def(), { applies_to: 'anima' })))
    expect(anima.length).toBe(82)
    const graphic = JSON.parse(String(await runTool(stubCtx(), def(), { category: 'graphic' })))
    // M2-T6 起 graphic 含 hand-authored 预设（poster_constructivist）
    expect(graphic.map((p: { id: string }) => p.id).sort()).toEqual([
      'nb20_简约线条高饱和高对比风', 'nb35_高亮平涂矢量轻漫风格', 'nb43_粗砺墨线限色高反差平涂风', 'poster_constructivist',
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
  it('audit #5: description interpolates the live preset count at registration (no hardcoded count)', () => {
    // 2026-09-12 审计 #5：描述硬编码「55 条」随库增长陈旧（实际 82）。修复后注册时经
    // loadStylePresets().presets.length 动态插值——库增减后描述重启自愈（消漂移类）。
    const { presets } = loadStylePresets()
    const d = def()
    expect(d.description).toContain(`过滤 ${presets.length} 条`)
    expect(d.description).not.toContain('55 条')
  })
})
