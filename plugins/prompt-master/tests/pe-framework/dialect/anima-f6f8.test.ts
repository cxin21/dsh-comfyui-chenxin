/**
 * Round 8 Task 1（F6/F8）：
 * F6 narrative 默认排除——compileAnima 装配时 narrative 段（slot=null/origin=narrative）默认不进
 * positive（实战 2/2 为伪增量冗余）；`allowNarrative: true` 为显式合法出口，走既有 F1 去重路径
 * （第一轮装配层去重保留）。排除发生在段入列处（pushSeg 之前，非装配后删除）；排除时留痕
 * advisory `narrative_excluded:<chars>chars`（result.assumptions 载体 → envelope.result.assumptions
 * 可见）。contentCount 与排除一致：被排除的 narrative 不计 1（allowNarrative=true 维持 F1 的
 * 「narrative 整段计 1」语义）。安全语义独立：isExplicitRequest 始终扫描 narrative。
 * F8 空泛词拦截——audit 新增 `vague_tag` gate（severity minor，advisory 性质不进修正闭环）：
 * positive 逐逗号分段与 VAGUE_TAGS 精确匹配（trim 后整段相等，大小写不敏感），质量前缀白名单豁免
 * （masterpiece/best quality/score_x/safe 等）。
 * 全程零 LLM；mock catalog（纯函数注入 search），不依赖真库。
 */
import { describe, expect, it } from 'vitest'
import { auditAnima, compileAnima, VAGUE_TAGS } from '../../../src/pe-framework/dialect/anima.js'
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'

/** mock search：全部 miss（F6/F8 与 grounding 无关；mock 走 user-fuzzy 原文保留路径） */
const nullSearch = (_t: string): CatalogHit[] => []

describe('F6: narrative 默认排除（compileAnima 装配层）', () => {
  it('规格1 默认排除：narrative 不进 positive、无 narrative 段、advisory narrative_excluded 附字符数', () => {
    const narrative = 'a lantern glows beside the moon gate, softly lit'
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative },
      { variant: 'base', search: nullSearch },
    )
    expect(r.positive).not.toContain('lantern')
    expect(r.positive.endsWith('moon gate')).toBe(true)
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.assumptions).toContain(`narrative_excluded:${narrative.length}chars`)
  })

  it('规格2 默认排除不留残余：narrative 含槽位未覆盖新句同样不追加（排除优先于去重）', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'brand new sentence never seen before.' },
      { variant: 'base', search: nullSearch },
    )
    expect(r.positive).not.toContain('brand new sentence')
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.assumptions.some((a) => a.startsWith('narrative_excluded:'))).toBe(true)
  })

  it('规格3 出口：allowNarrative=true 全重复仍不追加（F1 第一轮去重保留）、无排除 advisory', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'moon gate' },
      { variant: 'base', search: nullSearch, allowNarrative: true },
    )
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.assumptions.some((a) => a.startsWith('narrative_excluded:'))).toBe(false)
  })

  it('规格4 出口：allowNarrative=true 部分重复只加新句（F1 短语级规则）', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'moon gate, a lantern glows' },
      { variant: 'base', search: nullSearch, allowNarrative: true },
    )
    const segs = r.segments.filter((s) => s.origin === 'narrative')
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('a lantern glows')
    expect(r.positive.endsWith('a lantern glows')).toBe(true)
  })

  it('规格5 无 narrative：无排除 advisory、行为不变', () => {
    const r = compileAnima({ count_gender: ['1girl'] }, { variant: 'base', search: nullSearch })
    expect(r.assumptions.some((a) => a.startsWith('narrative_excluded:'))).toBe(false)
  })

  it('规格6 空白 narrative：视同无 narrative（不产生排除 advisory）', () => {
    const r = compileAnima({ count_gender: ['1girl'], narrative: '   ' }, { variant: 'base', search: nullSearch })
    expect(r.assumptions.some((a) => a.startsWith('narrative_excluded:'))).toBe(false)
  })

  it('规格7 安全语义独立：narrative 被排除但 explicit 标记仍生效（safe 不注入、正文无 narrative）', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], narrative: 'nude study, soft light' },
      { variant: 'base', search: nullSearch },
    )
    expect(r.positive).not.toContain('nude')
    expect(r.positive).not.toContain('safe')
  })
})

describe('F6: contentCount 与排除一致（tag_count 语义）', () => {
  it('规格8 默认排除后 narrative 不计 contentCount；allowNarrative=true 维持「narrative 计 1」', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag${i + 1}`)
    const slots = { appearance: tags, narrative: 'alpha, beta' }
    // 默认：narrative 被排除 → contentCount=11 <12 → tag_count gate 触发（与 positive 实际段数一致）
    const r = compileAnima(slots, { variant: 'base', search: nullSearch })
    expect(r.positive).not.toContain('alpha')
    const excluded = auditAnima(r.positive, r.negative, { variant: 'base', slots, search: nullSearch })
    expect(excluded.some((g) => g.rule === 'tag_count_out_of_range')).toBe(true)
    // 出口：narrative 参与装配 → contentCount=12 → 不触发（F1 segment 语义保留）
    const r2 = compileAnima(slots, { variant: 'base', search: nullSearch, allowNarrative: true })
    const allowed = auditAnima(r2.positive, r2.negative, { variant: 'base', slots, search: nullSearch, allowNarrative: true })
    expect(allowed.some((g) => g.rule === 'tag_count_out_of_range')).toBe(false)
  })
})

describe('F8: vague_tag gate（minor，不进修正闭环）', () => {
  it('规格9 命中：positive 含 atmosphere → 一条 minor gate，detail 给替换建议', () => {
    const gates = auditAnima('masterpiece, atmosphere, 1girl', '', { variant: 'base' })
    const hits = gates.filter((g) => g.rule === 'vague_tag')
    expect(hits).toHaveLength(1)
    expect(hits[0].severity).toBe('minor')
    expect(hits[0].detail).toContain('atmosphere')
    expect(hits[0].detail).toContain('建议删除或替换为具象描述')
  })

  it('规格10 白名单豁免：质量前缀（masterpiece/best quality/score_7/safe）不触发 vague_tag', () => {
    const gates = auditAnima('masterpiece, best quality, score_7, safe, atmosphere', '', { variant: 'base' })
    const hits = gates.filter((g) => g.rule === 'vague_tag')
    expect(hits).toHaveLength(1)
    expect(hits[0].detail).toContain('atmosphere')
  })

  it('规格11 无命中：无 vague_tag gate；子串/词形变化不误报（atmospheric/beautifully）', () => {
    const gates = auditAnima('masterpiece, atmospheric lighting, beautifully lit scene, 1girl', '', { variant: 'base' })
    expect(gates.some((g) => g.rule === 'vague_tag')).toBe(false)
  })

  it('规格12 词表导出：VAGUE_TAGS 为只读常量且恰含 brief 指定 7 词', () => {
    expect([...VAGUE_TAGS].sort()).toEqual(
      ['amazing', 'atmosphere', 'beautiful', 'gorgeous', 'lovely', 'pretty', 'stunningly beautiful'].sort(),
    )
  })

  it('规格13 同词重复只报一条 vague_tag（重复段由 duplicate_segment 另行负责）', () => {
    const gates = auditAnima('atmosphere, atmosphere', '', { variant: 'base' })
    expect(gates.filter((g) => g.rule === 'vague_tag')).toHaveLength(1)
  })
})
