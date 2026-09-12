/**
 * A7（外部基准 2026-09）：艺术指导卡片 ↔ 方言光效禁令一致性。
 * camera-anima 部署禁用光效词（LIGHTING_BAN，dialect/anima.ts 导出）；光影卡片的配套 tag
 * 若含禁词，enrich 教 LLM 用、审计马上报警——修正闭环空转。本测试把这条跨模块不变式钉死：
 * 五类卡片的全部 tag（含 lighting 以外类别，防御性覆盖）都不得包含任何 LIGHTING_BAN 禁词。
 */
import { describe, expect, it } from 'vitest'
import { ALL_ART_DIRECTION } from '../../../src/pe-framework/enrich/art-direction.js'
import { LIGHTING_BAN } from '../../../src/pe-framework/dialect/anima.js'

describe('art-direction cards comply with LIGHTING_BAN (A7 invariant)', () => {
  it('no card tag contains any banned lighting term', () => {
    for (const [field, cards] of Object.entries(ALL_ART_DIRECTION)) {
      for (const card of cards) {
        for (const tag of card.tags) {
          const low = tag.toLowerCase()
          for (const banned of LIGHTING_BAN) {
            expect(low.includes(banned.toLowerCase()), `${field}/${card.id} tag "${tag}" contains banned term "${banned}"`).toBe(false)
          }
        }
      }
    }
  })

  it('every lighting card still carries 3 tags (design intent density preserved after A7 rewrite)', () => {
    expect(ALL_ART_DIRECTION.lighting).toHaveLength(8)
    for (const card of ALL_ART_DIRECTION.lighting) {
      expect(card.tags.length).toBeGreaterThanOrEqual(3)
    }
  })
})
