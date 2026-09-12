/**
 * Round8 T3Q：艺术指导卡片库（美术指导设计意图包，方法论来自 SD-Anima-Prompt-Studio）。
 * 本测试锁定卡片库结构契约：5 类 36 张、id 全局唯一、每卡 tags 3-5 个、菜单可渲染。
 */
import { describe, it, expect } from 'vitest'
import {
  PERSPECTIVE_CARDS,
  COMPOSITION_CARDS,
  LIGHTING_CARDS,
  COLOR_CARDS,
  MOTION_CARDS,
  ALL_ART_DIRECTION,
  isKnownCardId,
  buildArtDirectionMenu,
  type ArtDirectionCard,
} from '../../../src/pe-framework/enrich/art-direction.js'

const GROUPS: Array<{ field: keyof typeof ALL_ART_DIRECTION; cards: readonly ArtDirectionCard[]; count: number }> = [
  { field: 'perspective', cards: PERSPECTIVE_CARDS, count: 8 },
  { field: 'composition', cards: COMPOSITION_CARDS, count: 8 },
  { field: 'lighting', cards: LIGHTING_CARDS, count: 8 },
  { field: 'color', cards: COLOR_CARDS, count: 6 },
  { field: 'motion', cards: MOTION_CARDS, count: 6 },
]

describe('艺术指导卡片库结构契约', () => {
  it('5 类卡组、数量 8/8/8/6/6 共 36 张', () => {
    expect(Object.keys(ALL_ART_DIRECTION).sort()).toEqual(['color', 'composition', 'lighting', 'motion', 'perspective'])
    let total = 0
    for (const g of GROUPS) {
      expect(ALL_ART_DIRECTION[g.field]).toBe(g.cards) // ALL_ART_DIRECTION 直接引用五类卡组
      expect(g.cards).toHaveLength(g.count)
      total += g.cards.length
    }
    expect(total).toBe(36)
  })

  it('每张卡：id 蛇形小写、name 非空中文设计意图、tags 3-5 个非空英文短语', () => {
    for (const g of GROUPS) {
      for (const card of g.cards) {
        expect(card.id).toMatch(/^[a-z][a-z0-9_]*$/)
        expect(card.name.length).toBeGreaterThan(0)
        expect(/[一-龥]/.test(card.name)).toBe(true) // name 是中文设计意图名
        expect(card.tags.length).toBeGreaterThanOrEqual(3)
        expect(card.tags.length).toBeLessThanOrEqual(5)
        for (const tag of card.tags) {
          expect(tag.length).toBeGreaterThan(0)
          expect(tag).not.toMatch(/[一-龥]/) // tag 是英文组合拳
        }
      }
    }
  })

  it('id 全局唯一（36 张无重复）——artDirection 字段值才能无歧义寻址', () => {
    const ids = GROUPS.flatMap((g) => g.cards.map((c) => c.id))
    expect(new Set(ids).size).toBe(36)
  })

  it('isKnownCardId：本类 id → true；跨类 id / 未知 id → false（按类目寻址，不允许 lighting=构图卡）', () => {
    expect(isKnownCardId('perspective', 'low_angle')).toBe(true)
    expect(isKnownCardId('motion', 'flowing_dress')).toBe(true)
    expect(isKnownCardId('lighting', 'rule_of_thirds')).toBe(false) // 构图卡不能填进光影
    expect(isKnownCardId('perspective', 'no_such_card')).toBe(false)
  })

  it('buildArtDirectionMenu：含全部 36 张卡的 id+name+tags（LLM 选择清单）', () => {
    const menu = buildArtDirectionMenu()
    for (const g of GROUPS) {
      for (const card of g.cards) {
        expect(menu).toContain(card.id)
        expect(menu).toContain(card.name)
        for (const tag of card.tags) expect(menu).toContain(tag)
      }
    }
    expect(menu).toContain('艺术指导卡片菜单')
  })
})
