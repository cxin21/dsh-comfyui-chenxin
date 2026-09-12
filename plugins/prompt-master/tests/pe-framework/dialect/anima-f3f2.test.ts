/**
 * 三期 Task 1（F3/F2）：fuzzy 候选过滤 + catalog_miss 的 canonical 候选确定性自动采纳。
 * 全程零 LLM；mock catalog（纯函数注入 search），不依赖真库。
 */
import { describe, expect, it } from 'vitest'
import { filterFuzzyCandidates, charOverlap, type CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'
import { applyCanonicalSubstitutions, compileAnima, fuzzyCandidates } from '../../../src/pe-framework/dialect/anima.js'

const hit = (match_type: CatalogHit['match_type'], prompt_form: string): CatalogHit => ({ match_type, prompt_form })

/** mock search：按归一化 key 返回预置 hits；未登记 → []（miss） */
function mockSearch(table: Record<string, CatalogHit[]>) {
  const norm = (s: string) => s.trim().toLowerCase()
  return (t: string): CatalogHit[] => table[norm(t)] ?? []
}

describe('F3: fuzzy 候选过滤（anima-catalog 输出前）', () => {
  it('剔除 @ 开头的用户名型候选', () => {
    const hits = [hit('fuzzy', '@willowsoft'), hit('fuzzy', 'moon gate')]
    const out = filterFuzzyCandidates('moon gate at night', hits)
    expect(out.map((h) => h.prompt_form)).toEqual(['moon gate'])
  })

  it('剔除与原查询字符重合率 <0.4 的候选', () => {
    // 'skinny' 与 'beside a moon gate' 几乎无字符重合
    expect(charOverlap('beside a moon gate', 'skinny')).toBeLessThan(0.4)
    const hits = [hit('fuzzy', 'skinny'), hit('fuzzy', 'moon gate')]
    const out = filterFuzzyCandidates('beside a moon gate', hits)
    expect(out.map((h) => h.prompt_form)).toEqual(['moon gate'])
  })

  it('每处 miss 的候选数截到 ≤3，不足 3 个不凑数（fuzzyCandidates 层）', () => {
    const hits = ['moon gate', 'moonlit gate', 'gate moon', 'night gate', 'torii gate'].map((p) => hit('fuzzy', p))
    const search = mockSearch({ 'moon gate': hits })
    expect(fuzzyCandidates('moon gate', search).length).toBeLessThanOrEqual(3)
    expect(fuzzyCandidates('moon gate', search)).toHaveLength(3)
    const few = fuzzyCandidates('moon gate', mockSearch({ 'moon gate': [hit('fuzzy', 'moon gate')] }))
    expect(few).toEqual(['moon gate'])
  })
})

describe('F2: catalog_miss 的 canonical/alias 候选确定性自动采纳', () => {
  it('miss 片段有 canonical 候选 → 替换 + corrections=1 + advisory 列替换对 + 重跑后 miss gate 消失', () => {
    const search = mockSearch({
      '1girl': [hit('canonical', '1girl')],
      'beside a moon gate': [hit('fuzzy', 'moon gate')],
      'moon gate': [hit('canonical', 'moon gate')],
    })
    const slots = { count_gender: ['1girl'], scene: ['beside a moon gate'] }
    const res = applyCanonicalSubstitutions('masterpiece, 1girl, beside a moon gate', '', { variant: 'base', slots, search })
    expect(res.corrections).toBe(1)
    expect(res.replacements).toEqual(['beside a moon gate→moon gate'])
    expect(res.positive).toContain('moon gate')
    expect(res.positive).not.toContain('beside a moon gate')
    // 替换对进 advisory（原片段→新tag）
    expect(res.advisories).toContain('canonical_substitution:beside a moon gate→moon gate')
    // 重跑 audit：该 miss gate 消失
    expect(res.gates.some((g) => g.rule === 'catalog_miss' && g.detail.includes('beside a moon gate'))).toBe(false)
  })

  it('候选全为 miss（无 canonical/alias 命中）→ 正文保留原文、corrections=0', () => {
    const search = mockSearch({
      '1girl': [hit('canonical', '1girl')],
      'zzzzzzzzq': [hit('fuzzy', 'qqqqqqzzz')],
      'qqqqqqzzz': [hit('fuzzy', 'zzzzzzqqq')],
    })
    const slots = { count_gender: ['1girl'], character: ['zzzzzzzzq'] }
    const compiled = compileAnima(slots, { variant: 'base', search })
    const res = applyCanonicalSubstitutions(compiled.positive, compiled.negative, { variant: 'base', slots, search })
    expect(res.corrections).toBe(0)
    expect(res.positive).toBe(compiled.positive)
    expect(res.positive).toContain('zzzzzzzzq')
  })

  it('幂等：替换后重跑无新替换（不无限循环）', () => {
    const search = mockSearch({
      'beside a moon gate': [hit('fuzzy', 'moon gate')],
      'moon gate': [hit('canonical', 'moon gate')],
    })
    const first = applyCanonicalSubstitutions('masterpiece, beside a moon gate', '', { search })
    expect(first.corrections).toBe(1)
    const second = applyCanonicalSubstitutions(first.positive, '', { search })
    expect(second.corrections).toBe(0)
    expect(second.positive).toBe(first.positive)
  })

  it('守卫①：slots 在场时 narrative 含句号的散文片段不参与替换（slotTags 限定）', () => {
    // 候选取单 token 'moon' 且位于句中（非句尾 token，避开词级子集对句尾标点的拦截）→ 红相仅由句型/slotTags 守卫决定
    const prose = 'she rests under a moon glow. softly'
    const search = mockSearch({
      '1girl': [hit('canonical', '1girl')],
      'courtyard': [hit('canonical', 'courtyard')],
      [prose]: [hit('fuzzy', 'moon')],
      'moon': [hit('canonical', 'moon')],
    })
    const slots = { count_gender: ['1girl'], scene: ['courtyard'], narrative: prose }
    const positive = `masterpiece, 1girl, courtyard, ${prose}`
    const res = applyCanonicalSubstitutions(positive, '', { variant: 'base', slots, search })
    expect(res.corrections).toBe(0)
    expect(res.positive).toBe(positive)
    expect(res.positive).toContain(prose)
  })

  it('守卫②：无 slots 直调时含句末标点的句型片段不参与标签替换', () => {
    const prose = 'the moon glows. it is bright'
    const search = mockSearch({
      [prose]: [hit('fuzzy', 'moon')],
      'moon': [hit('canonical', 'moon')],
    })
    const positive = `masterpiece, ${prose}`
    const res = applyCanonicalSubstitutions(positive, '', { search })
    expect(res.corrections).toBe(0)
    expect(res.positive).toBe(positive)
  })

  it('compileAnima 集成：替换生效、corrections 暴露、被替换 miss 的 assumption 撤除', () => {
    const search = mockSearch({
      '1girl': [hit('canonical', '1girl')],
      'beside a moon gate': [hit('fuzzy', 'moon gate')],
      'moon gate': [hit('canonical', 'moon gate')],
    })
    const r = compileAnima({ count_gender: ['1girl'], scene: ['beside a moon gate'] }, { variant: 'base', search })
    expect(r.positive).toContain('moon gate')
    expect(r.positive).not.toContain('beside a moon gate')
    expect(r.corrections).toBe(1)
    expect(r.assumptions).not.toContain('catalog_miss:beside a moon gate')
    expect(r.substitutions).toEqual(['beside a moon gate→moon gate'])
  })
})

/* P1/P2'（2026-09-12，docs/2026-09-12-prompt-rewrite-and-architecture.md）：真实样本回归——
 * 两轮 judge blocker 的机械根源 = 归化产废词（flowing sleeves→flowing / flowing hair→hair flowing）；
 * P2' = 内容槽 miss 落不到 exact → 删除（DanbooruSearch 式：tag 列表只留已验证形式） */
describe('P1 归化守卫 / P2' + "' 证据流丢弃", () => {
  it('P1 守卫①：禁丢中心名词（flowing sleeves 不得归化为孤立词 flowing）', () => {
    const search = mockSearch({
      'flowing sleeves': [hit('fuzzy', 'flowing')],
      flowing: [hit('canonical', 'flowing')],
    })
    const slots = { count_gender: ['1girl'], clothing: ['flowing sleeves'] }
    const res = applyCanonicalSubstitutions('masterpiece, 1girl, flowing sleeves', '', { variant: 'base', slots, search })
    expect(res.corrections).toBe(0)
    expect(res.dropped).toEqual([])
    expect(res.positive).toContain('flowing sleeves')
  })

  it('P1 守卫②：禁词序重排（flowing hair 不得归化为 hair flowing）', () => {
    const search = mockSearch({
      'flowing hair': [hit('fuzzy', 'hair flowing')],
      'hair flowing': [hit('canonical', 'hair flowing')],
    })
    const slots = { count_gender: ['1girl'], appearance: ['flowing hair'] }
    const res = applyCanonicalSubstitutions('masterpiece, 1girl, flowing hair', '', { variant: 'base', slots, search })
    expect(res.corrections).toBe(0)
    expect(res.positive).toContain('flowing hair')
  })

  it("P2'：可丢弃内容槽 miss 且无 exact 落点 → 删除 + advisory + 槽位视图同步；受保护槽（count_gender/character）保留", () => {
    const search = mockSearch({
      '1girl': [hit('canonical', '1girl')],
      'zzzzzzzzq': [hit('fuzzy', 'qqqqqqzzz')],
      'qqqqqqzzz': [hit('fuzzy', 'zzzzzzqqq')],
    })
    const slots = { count_gender: ['1girl'], character: ['zzzzzzzzq'], scene: ['flowing sleeves'] }
    // P2' 需显式开启（生产管线 registerAnimaDialect.compile 传 true；缺省关，保持历史语义）
    const res = applyCanonicalSubstitutions('masterpiece, 1girl, zzzzzzzzq, flowing sleeves', '', { variant: 'base', slots, search, dropUnresolvedMiss: true })
    // scene ∈ 可丢弃 → 删；character ∈ 受保护 → 留
    expect(res.dropped).toEqual(['flowing sleeves'])
    expect(res.advisories).toContain('catalog_miss_dropped:flowing sleeves')
    expect(res.positive).toContain('zzzzzzzzq')
    expect(res.positive).not.toContain('flowing sleeves')
    expect(res.effectiveSlots?.scene).toEqual([])
    expect(res.effectiveSlots?.character).toEqual(['zzzzzzzzq'])
  })

  it("P2' 联动：被丢弃 tag 的词元不得压制 narrative 去重覆盖集（概念必须留在 narrative 里）", () => {
    const search = mockSearch({
      '1girl': [hit('canonical', '1girl')],
      'zzzzzzzzq': [hit('fuzzy', 'qqqqqqzzz')],
      'qqqqqqzzz': [hit('fuzzy', 'zzzzzzqqq')],
    })
    const slots = {
      count_gender: ['1girl'],
      scene: ['zzzzzzzzq'],
      narrative: 'The zzzzzzzzq tower glows under the moon. A lantern drifts across the stone floor.',
    }
    const r = compileAnima(slots, { variant: 'base', search, dropUnresolvedMiss: true, allowNarrative: true })
    // tag 删了，但 narrative 两句都必须原样保留（丢 tag 的词元不得进入去重覆盖集）
    expect(r.positive).toContain('The zzzzzzzzq tower glows under the moon')
    expect(r.positive).toContain('A lantern drifts across the stone floor')
    expect(r.segments.some((s) => s.origin === 'narrative' && s.text.includes('zzzzzzzzq'))).toBe(true)
  })
})
