/**
 * Round 8 Task 1（F6/F8）→ Task 2Q 迁移：
 * F6 narrative 默认排除已被 T2Q「条件纳入」取代——compileAnima 装配时 narrative 先过确定性
 * NL 质量检查（checkNarrativeQuality：2-4 句英文、非 tag 罗列），通过则作为 NL 场景块纳入
 * positive（走既有 F1 去重路径）；不通过则排除 + advisory `narrative_excluded:<原因>`
 * （sentence_count/cjk/tag_list；本文件保留不合格 narrative 的排除路径覆盖）。
 * `allowNarrative: true` 语义升级为「跳过质量检查强制纳入」，F1 第一轮去重仍生效。
 * contentCount 与装配一致：被排除的 narrative 不计 1（纳入路径维持「narrative 整段计 1」）。
 * 安全语义独立：isExplicitRequest 始终扫描 narrative。
 * F8 空泛词拦截——audit 新增 `vague_tag` gate（severity minor，advisory 性质不进修正闭环）：
 * positive 逐逗号分段与 VAGUE_TAGS 精确匹配（trim 后整段相等，大小写不敏感），质量前缀白名单豁免
 * （masterpiece/best quality/score_x/safe 等）。
 * 全程零 LLM；mock catalog（纯函数注入 search），不依赖真库。T2Q 新增路径归 anima-t2q.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { auditAnima, compileAnima, VAGUE_TAGS } from '../../../src/pe-framework/dialect/anima.js'
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'

/** mock search：全部 miss（F6/F8 与 grounding 无关；mock 走 user-fuzzy 原文保留路径） */
const nullSearch = (_t: string): CatalogHit[] => []

describe('F6→T2Q: narrative 排除路径（不合格 narrative，compileAnima 装配层）', () => {
  it('规格1 迁移（T2Q 条件纳入）：不合格 narrative（单句非 NL 块）不进 positive、无 narrative 段、advisory narrative_excluded 附原因码', () => {
    const narrative = 'a lantern glows beside the moon gate, softly lit'
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative },
      { variant: 'base', search: nullSearch },
    )
    expect(r.positive).not.toContain('lantern')
    expect(r.positive.endsWith('moon gate')).toBe(true)
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    // T2Q：排除原因码化（句子数 2-4 检查先行——无句末标点 = 1 句 → sentence_count:1）
    expect(r.assumptions).toContain('narrative_excluded:sentence_count:1')
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

describe('F6→T2Q: contentCount 与装配一致（tag_count 语义）', () => {
  it('规格8 被排除的 narrative 不计 contentCount；allowNarrative=true 维持「narrative 计 1」', () => {
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
