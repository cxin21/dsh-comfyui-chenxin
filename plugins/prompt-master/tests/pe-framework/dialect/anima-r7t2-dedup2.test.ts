/**
 * Round 7 Task 2（F1 残余）：F2 grounding 替换之后的第二轮 narrative 短语去重。
 * 背景（三期审计 B1 实证）：第一轮去重（compile 装配层）在 grounding 替换之前做覆盖判定——
 * grounding 把槽位文本换成 canonical 形态（`beside a moon gate→moon gate`）后，原文侧词元
 * （beside/thin/mist/…）从覆盖集消失，narrative 中与「替换前原文」相同的短语漏网，
 * positive 出现两个 `moon gate`（一个来自替换后的 scene 槽，一个来自 narrative 残余短语）。
 * 行为规格（brief 四条，每条一个 it）：替换后二次去重 / 幂等 / 散文句回归 / 无替换路径一致。
 * 全程零 LLM；mock catalog（纯函数注入 search），不依赖真库。
 */
import { describe, expect, it } from 'vitest'
import { compileAnima } from '../../../src/pe-framework/dialect/anima.js'
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'

const hit = (match_type: CatalogHit['match_type'], prompt_form: string): CatalogHit => ({ match_type, prompt_form })

/** mock search：按归一化 key 返回预置 hits；未登记 → []（miss） */
function mockSearch(table: Record<string, CatalogHit[]>) {
  const norm = (s: string) => s.trim().toLowerCase()
  return (t: string): CatalogHit[] => table[norm(t)] ?? []
}

/** 全部 miss（无 grounding/替换路径；走 user-fuzzy 原文保留） */
const nullSearch = (t: string): CatalogHit[] => []

/** grounding 替换形态：scene 槽原文是 miss，但 grounding/fuzzy 候选把文本换成 canonical 形态
 *  （`beside a moon gate`→`moon gate`、`thin mist around the covered bridge`→`covered bridge`）——
 *  装配期覆盖集只见替换后的 canonical 词元，原文侧词元（beside/thin/mist/around/the）不在其中 */
const groundingSearch = mockSearch({
  '1girl': [hit('canonical', '1girl')],
  'beside a moon gate': [hit('canonical', 'moon gate')],
  'thin mist around the covered bridge': [hit('canonical', 'covered bridge')],
})

/** 一期同款形状（一期实战短语清单） */
const yiqiSlots = {
  count_gender: ['1girl'],
  scene: ['beside a moon gate', 'thin mist around the covered bridge'],
  narrative: 'Scene details: 1girl, gentle and graceful ancient Chinese beauty, hanfu, standing, beside a moon gate, thin mist around the covered bridge',
}

describe('R7-T2: F2 grounding 替换后的第二轮 narrative 短语去重', () => {
  it('规格1 一期同款形状 + grounding 替换：narrative 残余短语被二次去重（moon gate/covered bridge 各恰一次、无 Scene details 段）', () => {
    const r = compileAnima(yiqiSlots, { variant: 'base', search: groundingSearch })
    expect((r.positive.match(/moon gate/g) || []).length).toBe(1)
    expect((r.positive.match(/covered bridge/g) || []).length).toBe(1)
    expect(r.positive).not.toContain('Scene details')
    expect(r.segments.some((s) => s.text.includes('Scene details'))).toBe(false)
    // 未覆盖的新短语按第一轮规则保留
    expect(r.positive).toContain('gentle and graceful ancient Chinese beauty, hanfu, standing')
  })

  it('规格2 幂等：对最终 positive 的 narrative 再跑 dedup pass → 无变化', () => {
    const r1 = compileAnima(yiqiSlots, { variant: 'base', search: groundingSearch })
    const seg1 = r1.segments.find((s) => s.origin === 'narrative')
    // 把第一轮输出的 narrative 段文本原样喂回 dedup pass（同 slots 再编译）→ 结果逐字节不变
    const r2 = compileAnima({ ...yiqiSlots, narrative: seg1?.text ?? '' }, { variant: 'base', search: groundingSearch })
    expect(r2.positive).toBe(r1.positive)
    const seg2 = r2.segments.find((s) => s.origin === 'narrative')
    expect(seg2?.text).toBe(seg1?.text)
    // 二次去重不产生新替换
    expect(r2.corrections).toBe(0)
    expect(r2.substitutions).toEqual([])
  })

  it('规格3 散文句回归：含句号新句的 narrative（部分新内容）→ 新句保留（三期 T2 规格回归）', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'moon gate stands. a lantern glows, softly lit.' },
      { variant: 'base', search: nullSearch },
    )
    const segs = r.segments.filter((s) => s.origin === 'narrative')
    expect(segs).toHaveLength(1)
    // 句级规则不变：含句末标点的句子整句判定，未全被覆盖则整句保留（第二轮不做短语级切分丢弃）
    expect(segs[0].text).toBe('moon gate stands. a lantern glows, softly lit.')
  })

  it('规格4 无替换路径：第二轮去重仍执行，纯 narrative 重复同样被清，行为与第一轮一致', () => {
    const r = compileAnima(yiqiSlots, { variant: 'base', search: nullSearch })
    expect(r.corrections).toBe(0)
    expect(r.substitutions).toEqual([])
    // 第一轮已清除 narrative 侧的槽位重复短语（槽位原文保留是 user-fuzzy 现行为，与此无关）；
    // 未覆盖短语保留，narrative 残余与第一轮结果一致
    expect(r.positive).not.toContain('Scene details')
    const segs = r.segments.filter((s) => s.origin === 'narrative')
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('gentle and graceful ancient Chinese beauty, hanfu, standing')
  })
})
