import { describe, it, expect } from 'vitest'
import { validateBrief, BRIEF_MAX_ITEMS_PER_DIM, BRIEF_MAX_TEXT_LEN } from '../../../src/pe-framework/enrich/brief.js'
import type { EnrichedBrief } from '../../../src/pe-framework/enrich/brief.js'

function okBrief(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const item = { text: '1girl', source: 'user' }
  return {
    outputLang: 'en',
    subject: [item],
    scene: [{ text: 'street at dusk', source: 'enriched' }],
    composition: [item],
    lighting: [item],
    color: [item],
    style: [item],
    mood: [item],
    nameAnchors: [],
    ...over,
  }
}

describe('validateBrief', () => {
  it('合法 brief → ok:true 且原样返回', () => {
    const raw = okBrief()
    const res = validateBrief(raw)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.brief).toEqual(raw)
  })

  it('非对象 → ok:false', () => {
    expect(validateBrief(null).ok).toBe(false)
    expect(validateBrief('x').ok).toBe(false)
    expect(validateBrief([]).ok).toBe(false)
  })

  it('outputLang 非法 → ok:false', () => {
    expect(validateBrief(okBrief({ outputLang: 'fr' })).ok).toBe(false)
    expect(validateBrief(okBrief({ outputLang: undefined })).ok).toBe(false)
  })

  it('缺任一维度 → ok:false', () => {
    const raw = okBrief()
    delete raw.mood
    const res = validateBrief(raw)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).not.toBe('brief_too_large')
  })

  it('维度不是数组 → ok:false', () => {
    expect(validateBrief(okBrief({ scene: 'x' })).ok).toBe(false)
  })

  it('item 形状错（缺 text / text 非串） → ok:false', () => {
    expect(validateBrief(okBrief({ subject: [{ source: 'user' }] })).ok).toBe(false)
    expect(validateBrief(okBrief({ subject: [{ text: 3, source: 'user' }] })).ok).toBe(false)
  })

  it('source 枚举外 → ok:false', () => {
    expect(validateBrief(okBrief({ subject: [{ text: 'a', source: 'llm' }] })).ok).toBe(false)
  })

  it('单维超 ${BRIEF_MAX_ITEMS_PER_DIM} 条 → ok:false reason=brief_too_large', () => {
    const many = Array.from({ length: (BRIEF_MAX_ITEMS_PER_DIM as number) + 1 }, (_, i) => ({ text: `t${i}`, source: 'enriched' }))
    const res = validateBrief(okBrief({ subject: many }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('brief_too_large')
  })

  it('单条超 200 字符 → ok:false reason=brief_too_large（不截断）', () => {
    const long = 'x'.repeat((BRIEF_MAX_TEXT_LEN as number) + 1)
    const res = validateBrief(okBrief({ color: [{ text: long, source: 'enriched' }] }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('brief_too_large')
  })

  it('边界：恰好 6 条 / 200 字符 → ok:true', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ text: `t${i}`, source: 'enriched' }))
    const edge = { text: 'y'.repeat(BRIEF_MAX_TEXT_LEN as number), source: 'user' }
    expect(validateBrief(okBrief({ subject: six, mood: [edge] })).ok).toBe(true)
  })

  it('nameAnchors：空数组合法；条目须 {original, anchored} 字符串', () => {
    expect(validateBrief(okBrief({ nameAnchors: [{ original: '小明', anchored: 'XiaoMing' }] })).ok).toBe(true)
    expect(validateBrief(okBrief({ nameAnchors: [{}] })).ok).toBe(false)
    expect(validateBrief(okBrief({ nameAnchors: 'x' })).ok).toBe(false)
  })
})

/* Round8 T3Q：artDirection 可选字段——所选艺术指导卡片 id 的合法性校验 */
describe('validateBrief artDirection', () => {
  it('缺省（旧形状）→ ok:true，输出 brief 无 artDirection 键（向后兼容硬约束）', () => {
    const res = validateBrief(okBrief())
    expect(res.ok).toBe(true)
    if (res.ok) expect('artDirection' in res.brief).toBe(false)
  })

  it('合法卡片 id（全五类）→ ok:true 且 brief.artDirection 原样保留', () => {
    const ad = { perspective: 'low_angle', composition: 'diagonal_dynamics', lighting: 'rim_backlight', color: 'warm_cool_contrast', motion: 'flowing_dress' }
    const res = validateBrief(okBrief({ artDirection: ad }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.brief.artDirection).toEqual(ad)
  })

  it('部分选择（子集字段）→ ok:true，仅保留所选字段', () => {
    const res = validateBrief(okBrief({ artDirection: { lighting: 'god_rays', color: 'limited_palette' } }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.brief.artDirection).toEqual({ lighting: 'god_rays', color: 'limited_palette' })
  })

  it('未知卡片 id → ok:false reason=invalid_art_direction', () => {
    const res = validateBrief(okBrief({ artDirection: { perspective: 'no_such_card' } }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_art_direction')
  })

  it('跨类目 id（lighting 填构图卡）→ ok:false reason=invalid_art_direction', () => {
    const res = validateBrief(okBrief({ artDirection: { lighting: 'rule_of_thirds' } }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_art_direction')
  })

  it('值非字符串（数字/null）→ ok:false reason=invalid_art_direction', () => {
    expect(validateBrief(okBrief({ artDirection: { color: 42 } })).ok).toBe(false)
    const res = validateBrief(okBrief({ artDirection: { color: null } }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_art_direction')
  })

  it('artDirection 非对象（串/数组）→ ok:false reason=invalid_art_direction', () => {
    const s = validateBrief(okBrief({ artDirection: 'low_angle' }))
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.reason).toBe('invalid_art_direction')
    expect(validateBrief(okBrief({ artDirection: ['low_angle'] })).ok).toBe(false)
  })

  it('未知子键被丢弃；空对象 {} → ok:true 且不产出空 artDirection', () => {
    const dropped = validateBrief(okBrief({ artDirection: { perspective: 'low_angle', bogus: 'x' } }))
    expect(dropped.ok).toBe(true)
    if (dropped.ok) expect(dropped.brief.artDirection).toEqual({ perspective: 'low_angle' })
    const empty = validateBrief(okBrief({ artDirection: {} }))
    expect(empty.ok).toBe(true)
    if (empty.ok) expect('artDirection' in empty.brief).toBe(false)
  })
})
