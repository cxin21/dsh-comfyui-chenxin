/**
 * Round 8 Task 2（F7）：tag 软预算闸门——anima audit 新增 `tag_budget_exceeded` gate。
 * 阈值依据调研（DTG/DART 实测档位：20-40 为推荐档，60+ 为最差档）：
 * - positive 按逗号分段计数（trim 后非空段），段数 > TAG_BUDGET_MAX_SEGMENTS(40) → gate
 * - 字符数 > TAG_BUDGET_MAX_CHARS(1200) → 同 gate（detail 同格式），两者取或
 * - severity=important：不翻转 stage.ok（runStage ok 只认 critical）、不单独触发修正闭环
 * - 质量前缀段（masterpiece 等）计入段数（它们也是权重占用）
 * 全程零 LLM；规格 1-3 直调 auditAnima 纯函数（无 slots → 不触 catalog），
 * 规格 4 走 runStage（闭环联动锚定，模式同 anima-f4-cjk.test.ts）。
 */
import { describe, expect, it } from 'vitest'
import { auditAnima, TAG_BUDGET_MAX_CHARS, TAG_BUDGET_MAX_SEGMENTS } from '../../../src/pe-framework/dialect/anima.js'
import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'

/** 定长 tag 构造器：`base + 序号` padEnd 到 len 字符（互异，避免 duplicate_segment 噪声） */
function padTag(i: number, len: number): string {
  return (`tag${i + 1}`).padEnd(len, 'x')
}

describe('F7: tag_budget_exceeded 软预算闸门', () => {
  it('规格0 阈值常量导出：TAG_BUDGET_MAX_SEGMENTS=40、TAG_BUDGET_MAX_CHARS=1200（调研档位）', () => {
    expect(TAG_BUDGET_MAX_SEGMENTS).toBe(40)
    expect(TAG_BUDGET_MAX_CHARS).toBe(1200)
  })

  it('规格1 positive 41 段 → gate 触发，detail 含 41 与 40（质量前缀段计入段数）', () => {
    // 4 个质量前缀段（masterpiece/best quality/score_7/safe）+ 37 个内容段 = 41 段：
    // 若前缀不计入，段数只有 37 ≤ 40 不触发——本用例同时锚定「前缀计入段数」规则
    const positive = ['masterpiece', 'best quality', 'score_7', 'safe', ...Array.from({ length: 37 }, (_, i) => padTag(i, 20))].join(', ')
    const gates = auditAnima(positive, '', { variant: 'base' })
    const hits = gates.filter((g) => g.rule === 'tag_budget_exceeded')
    expect(hits).toHaveLength(1)
    expect(hits[0].severity).toBe('important')
    expect(hits[0].detail).toContain('41')
    expect(hits[0].detail).toContain('40')
    expect(hits[0].detail).toContain('场景细节>氛围词>次要动作')
  })

  it('规格2 positive 1200+ 字符（段数 ≤40）→ gate 触发，detail 同格式含 1200', () => {
    // 4 前缀 + 30 内容段 × 38 字符 ≈ 1250 字符 > 1200；段数 34 ≤ 40（段数维度不触发）
    const positive = ['masterpiece', 'best quality', 'score_7', 'safe', ...Array.from({ length: 30 }, (_, i) => padTag(i, 38))].join(', ')
    expect(positive.length).toBeGreaterThan(1200) // 前置条件：字符维度确实超限
    const gates = auditAnima(positive, '', { variant: 'base' })
    const hits = gates.filter((g) => g.rule === 'tag_budget_exceeded')
    expect(hits).toHaveLength(1)
    expect(hits[0].severity).toBe('important')
    expect(hits[0].detail).toContain('1200')
    expect(hits[0].detail).toContain('字符')
  })

  it('规格3 35 段 800 字符 → 不触发（两维度均在预算内）', () => {
    // 4 前缀 + 31 内容段 × 22 字符 ≈ 790 字符：段数 35 ≤ 40、字符 < 1200
    const positive = ['masterpiece', 'best quality', 'score_7', 'safe', ...Array.from({ length: 31 }, (_, i) => padTag(i, 22))].join(', ')
    expect(positive.split(',').map((s) => s.trim()).filter(Boolean)).toHaveLength(35) // 前置条件：35 段
    expect(positive.length).toBeGreaterThan(700)
    expect(positive.length).toBeLessThanOrEqual(1200)
    const gates = auditAnima(positive, '', { variant: 'base' })
    expect(gates.some((g) => g.rule === 'tag_budget_exceeded')).toBe(false)
  })

  it('规格4 stage.ok 语义不受影响：runStage 超预算（important 非 critical）→ ok=true', () => {
    // 40 appearance + 1 count_gender = 41 槽位 tag + 4 前缀 + safe = 46 段 > 40 → gate 触发；
    // runStage ok 只认 critical（runStage.ts:66）→ 软预算不翻 ok（闭环联动锚定，模式同 F4）
    // 2026-09-12 P2'：夹具改用 40 个真 canonical danbooru tag——假 tag 会被证据流删除，
    // 预算 gate 不再触发（drop 行为只对生产 compile 开启，runStage 走生产路径）
    const slots = { count_gender: ['1girl'], appearance: CANONICAL_APPEARANCE_TAGS.slice(0, 40) }
    const stage = runStage({ target: 'anima', slots, variant: 'base', judge: 'off' })
    const gate = stage.gates.find((g) => g.rule === 'tag_budget_exceeded')
    expect(gate).toBeDefined()
    expect(gate!.severity).toBe('important')
    expect(stage.ok).toBe(true)
  })
})

/** 40 个 catalog 已验证的 canonical danbooru 外观 tag（P2' 夹具：grounded tag 不受证据流影响） */
const CANONICAL_APPEARANCE_TAGS = [
  'long hair', 'short hair', 'twintails', 'ponytail', 'braid', 'bob cut', 'ahoge', 'hime cut',
  'blunt bangs', 'side ponytail', 'black hair', 'brown hair', 'blue hair', 'red hair', 'white hair',
  'purple hair', 'pink hair', 'grey hair', 'green hair', 'blonde hair', 'blue eyes', 'red eyes',
  'green eyes', 'brown eyes', 'purple eyes', 'gold eyes', 'heterochromia', 'glasses', 'blush',
  'mole', 'freckles', 'hair ornament', 'hair ribbon', 'hairclip', 'headband', 'hair bobbles',
  'cone hairbun', 'double bun', 'hair flower', 'parted bangs',
]
