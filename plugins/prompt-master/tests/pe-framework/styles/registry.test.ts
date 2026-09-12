import { describe, expect, it } from 'vitest'
import { loadStylePresets, getStylePreset, listStylePresets, stylePresetCount, assertAppliesToElements } from '../../../src/pe-framework/styles/registry.js'
import type { StylePresetV2 } from '../../../src/pe-framework/styles/schema.js'

/** 十类分类学（spec §4.4）——registry 层 category 断言用（captain 附加项②） */
const TAXONOMY = ['photography', 'anime', 'illustration', 'cg_3d', 'oriental', 'dark_supernatural', 'scifi_fantasy', 'retro', 'graphic', 'glamour_intimate']

describe('style registry (spec §4.2)', () => {
  const loaded = loadStylePresets()

  it('loads 55 presets with no conflicts', () => {
    expect(loaded.advisories).toEqual([])
    // M2 数据里程碑：55 → 批次递增（T4 +7=62；T5 +5=67；T8 收口总账收紧为 82）
    expect(stylePresetCount()).toBe(67)
  })
  it('get by id returns preset; unknown returns undefined', () => {
    expect(getStylePreset('cinematic_real')?.category).toBe('photography')
    expect(getStylePreset('nb01_2024顶级画师混搭_rella_wlop')?.source).toBe('newbie-migrated')
    expect(getStylePreset('nope')).toBeUndefined()
  })
  it('rating filter: safe session never sees sensitive/explicit presets', () => {
    const safe = listStylePresets({ maxRating: 'safe' })
    expect(safe.every((p) => p.rating === 'safe')).toBe(true)
  })
  it('category + applies_to + query filters compose', () => {
    expect(listStylePresets({ category: 'anime' }).every((p) => p.category === 'anime')).toBe(true)
    expect(listStylePresets({ appliesTo: 'h3' }).every((p) => p.applies_to.includes('h3'))).toBe(true)
    expect(listStylePresets({ query: 'rella' }).length).toBeGreaterThanOrEqual(1)
  })
  it('captain addendum ①: applies_to elements are enum-checked (anima|h3|sd only, fail-fast)', () => {
    const bad = { ...getStylePreset('cinematic_real')!, applies_to: ['anima', 'weibo'] } as unknown as StylePresetV2
    expect(() => assertAppliesToElements(bad, 'fixture.json')).toThrow(/applies_to/)
    expect(() => assertAppliesToElements(getStylePreset('cinematic_real')!, 'fixture.json')).not.toThrow()
    // 全量条目经 load 通道隐式过检（loadStylePresets 内逐条调用）；计数随 M2 批次递增（T8=82）
    expect(stylePresetCount()).toBe(67)
  })
  it('captain addendum ②: every loaded preset carries a category from the ten-class taxonomy', () => {
    const all = listStylePresets()
    // 计数随 M2 批次递增（T4 +7=62；T5 +5=67；T8 收口=82）
    expect(all.length).toBe(67)
    for (const p of all) expect(TAXONOMY, `${p.id}: ${p.category}`).toContain(p.category)
  })
})
