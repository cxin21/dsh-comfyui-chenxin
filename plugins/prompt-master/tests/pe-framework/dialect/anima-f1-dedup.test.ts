/**
 * 三期 Task 2（F1）：narrative 兜底段与槽位段去重（compile 装配层，audit 之前，零 LLM）。
 * 行为规格（brief 六条）：全重复不追加 / 部分重复按句切分只追加未覆盖句 / 无重复原样 /
 * 无 narrative 不变 / duplicate_segment important gates 消失 / 实词归一化（小写、≥2 字符、CJK bigram）。
 * 实词集合语义与 eval/critic.ts tokensOf 一致（抽公共 util）。
 */
import { describe, expect, it } from 'vitest'
import { auditAnima, compileAnima } from '../../../src/pe-framework/dialect/anima.js'
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'

/** mock search：全部 miss（F1 去重与 grounding 无关；mock 走 user-fuzzy 原文保留路径） */
const nullSearch = (t: string): CatalogHit[] => []

describe('F1: narrative 兜底段与槽位段去重（compile 装配层）', () => {
  it('规格1 全重复：narrative 实词集合被已有槽位段覆盖 → 不追加 narrative 段', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'moon gate' },
      { variant: 'base', search: nullSearch },
    )
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.positive.endsWith('moon gate')).toBe(true)
  })

  it('规格2 部分重复：按句切分，只追加未覆盖的句子', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'moon gate. a lantern glows.' },
      { variant: 'base', search: nullSearch },
    )
    expect(r.positive).not.toContain('moon gate. ')
    expect(r.positive).toContain('a lantern glows')
    const narrativeSegs = r.segments.filter((s) => s.origin === 'narrative')
    expect(narrativeSegs).toHaveLength(1)
    expect(narrativeSegs[0].text).toBe('a lantern glows.')
    expect(narrativeSegs[0].priority).toBe(2000)
    expect(narrativeSegs[0].slot).toBeNull()
  })

  it('规格3 无重复：narrative 全新内容 → 原样追加（现行为不变）', () => {
    const narrative = 'she drifts through drifting petals, quiet as snowfall'
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative },
      { variant: 'base', search: nullSearch },
    )
    const seg = r.segments.find((s) => s.origin === 'narrative')
    expect(seg?.text).toBe(narrative)
    expect(r.positive.endsWith(narrative)).toBe(true)
  })

  it('规格4 无 narrative 段：行为不变（无 narrative 段，positive 不含逗号尾随）', () => {
    const r = compileAnima({ count_gender: ['1girl'], scene: ['moon gate'] }, { variant: 'base', search: nullSearch })
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.positive).not.toMatch(/,\s*$/)
  })

  it('规格5 去重后 duplicate_segment important gates 消失（跑 audit 验证）', () => {
    const slots = { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'moon gate, moon gate' }
    // 修复前行为对照：不去重时 positive 含重复段，audit 打 duplicate_segment important
    const pre = 'masterpiece, 1girl, moon gate, moon gate, moon gate'
    expect(auditAnima(pre, '', { variant: 'base', slots }).some((g) => g.rule === 'duplicate_segment' && g.severity === 'important')).toBe(true)
    // 修复后：narrative 被去重，重复 gate 消失
    const r = compileAnima(slots, { variant: 'base', search: nullSearch })
    const gates = auditAnima(r.positive, r.negative, { variant: 'base', slots })
    expect(gates.some((g) => g.rule === 'duplicate_segment')).toBe(false)
  })

  it('规格6 归一化：大小写不敏感、≥2 字符词元、CJK bigram（tokensOf 语义）', () => {
    // 大小写不敏感：槽位 'Moon Gate' 覆盖 narrative 'MOON GATE'
    const r1 = compileAnima(
      { count_gender: ['1girl'], scene: ['Moon Gate'], narrative: 'MOON GATE' },
      { variant: 'base', search: nullSearch },
    )
    expect(r1.segments.some((s) => s.origin === 'narrative')).toBe(false)
    // 单字符词元不成词元：narrative 'a b I' 无 ≥2 字符词元 → 视为被覆盖，不追加
    const r2 = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'a b I' },
      { variant: 'base', search: nullSearch },
    )
    expect(r2.segments.some((s) => s.origin === 'narrative')).toBe(false)
    // CJK bigram：槽位 '水袖' 覆盖 narrative '水袖'
    const r3 = compileAnima(
      { count_gender: ['1girl'], scene: ['水袖'], narrative: '水袖' },
      { variant: 'base', search: nullSearch },
    )
    expect(r3.segments.some((s) => s.origin === 'narrative')).toBe(false)
  })

  it('规格7 一期会话同款形状：`Scene details:` 前缀剥离后去重仍触发', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate', 'weeping willows by the pond'], narrative: 'Scene details: moon gate, weeping willows by the pond' },
      { variant: 'base', search: nullSearch },
    )
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.positive.endsWith('weeping willows by the pond')).toBe(true)
  })

  it('规格8 Minor-1：小数点不切句（`.` 前后均为数字），尾片段不静默丢弃', () => {
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['moon gate'], narrative: 'score 1.5 is high. a lantern glows' },
      { variant: 'base', search: nullSearch },
    )
    const segs = r.segments.filter((s) => s.origin === 'narrative')
    expect(segs).toHaveLength(1)
    // '1.5' 未被切成 'score 1' / '5 is high' 两个片段；无标点尾片段 'a lantern glows' 保留
    expect(segs[0].text).toBe('score 1.5 is high. a lantern glows')
  })
})
