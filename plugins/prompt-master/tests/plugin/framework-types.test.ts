import { describe, expect, it } from 'vitest'
import { SLOT_ORDER, TARGETS, THREE_VARIANTS } from '../../src/pe-framework/index.js'

describe('pe-framework types', () => {
  it('SLOT_ORDER is non-empty and matches upstream fixity', () => {
    expect(SLOT_ORDER.length).toBeGreaterThan(0)
    // 前端权重敏感：断言首槽在源码常量中同样居首（implementer 验证后固化为字面断言）
    expect(SLOT_ORDER).toContain('count_gender')
    // 钢人固化：逐字冻结 anima types.py L30-40 的完整槽序（顺序即权重策略）
    // B8（外部基准 2026-09）：新增 artist 槽（count→character→artist 对齐 NewBie/Animagine 实证权重序；
    // 上游 types.py 无 artist 槽——空槽时输出与旧序逐字节一致）
    expect(SLOT_ORDER).toEqual([
      'count_gender',
      'character',
      'artist',
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