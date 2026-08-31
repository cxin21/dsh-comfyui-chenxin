import { describe, expect, it } from 'vitest'
import { SLOT_ORDER, TARGETS, THREE_VARIANTS } from '../../src/pe-framework/index.js'

describe('pe-framework types', () => {
  it('SLOT_ORDER is non-empty and matches upstream fixity', () => {
    expect(SLOT_ORDER.length).toBeGreaterThan(0)
    // 前端权重敏感：断言首槽在源码常量中同样居首（implementer 验证后固化为字面断言）
    expect(SLOT_ORDER).toContain('count_gender')
    // 钢人固化：逐字冻结 anima types.py L30-40 的完整槽序（顺序即权重策略）
    expect(SLOT_ORDER).toEqual([
      'count_gender',
      'character',
      'appearance',
      'clothing',
      'pose_action',
      'expression',
      'camera',
      'scene',
      'detail_mood',
    ])
  })
  it('TARGETS covers the four dialects', () => {
    expect(TARGETS).toEqual(['anima', 'h3', 'sd', 'generic'])
  })
  it('variants are base/aesthetic/turbo', () => {
    expect([...THREE_VARIANTS]).toEqual(['base', 'aesthetic', 'turbo'])
  })
})