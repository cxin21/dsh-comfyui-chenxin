/**
 * 三期 Task 3（F4）：cjk_in_positive 守门 gate。
 * CJK 片段对 anima 无效（tag 库无中文条目）→ critical 级：进修正闭环
 * （闭环触发条件 = gates.some(critical)，important 不触发——见 prompt-author 闭环条件）。
 * 全程零 LLM；mock catalog，不依赖真库。
 */
import { describe, expect, it } from 'vitest'
import { auditAnima, compileAnima } from '../../../src/pe-framework/dialect/anima.js'
import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'

const hit = (match_type: 'canonical', prompt_form: string) => ({ match_type, prompt_form })
const mockSearch = (t: string) => (t === '1girl' || t === 'hanfu' || t === 'standing' ? [hit('canonical', t)] : [])

function cjkGates(positive: string) {
  return auditAnima(positive, 'worst quality', { slots: { count_gender: ['1girl'] }, search: mockSearch })
    .filter((g) => g.rule === 'cjk_in_positive')
}

describe('F4: cjk_in_positive 守门', () => {
  it('positive 含中文片段（水袖）→ 触发 gate，detail 含片段文本', () => {
    const gates = cjkGates('masterpiece, best quality, standing, 水袖, hanfu')
    expect(gates).toHaveLength(1)
    expect(gates[0].detail).toContain('水袖')
  })

  it('多个中文片段 → 每个片段一条 gate', () => {
    const gates = cjkGates('masterpiece, 水袖, 江南园林, hanfu')
    const details = gates.map((g) => g.detail)
    expect(details.some((d) => d.includes('水袖'))).toBe(true)
    expect(details.some((d) => d.includes('江南园林'))).toBe(true)
  })

  it('纯英文 positive → 无该 gate', () => {
    expect(cjkGates('masterpiece, best quality, standing, hanfu, water sleeves')).toHaveLength(0)
  })

  it('单个假名（の）→ 触发（假名对 anima 同样无效，判定阈值=1）', () => {
    expect(cjkGates('masterpiece, best quality, yukata の, hanfu').length).toBe(1)
  })

  it('单字符孤立拉丁字母/数字不受影响（无假名/表意文字）→ 不触发', () => {
    expect(cjkGates('masterpiece, 1girl, a, hanfu')).toHaveLength(0)
  })

  it('compileAnima 全链路：CJK 槽位 → 审计 gates 含 cjk_in_positive（severity critical）', () => {
    const res = compileAnima({ count_gender: ['1girl'], clothing: ['汉服'] }, { variant: 'base', search: mockSearch })
    const gates = auditAnima(res.positive, res.negative, { variant: 'base', search: mockSearch })
    const gate = gates.find((g) => g.rule === 'cjk_in_positive')
    expect(gate).toBeDefined()
    expect(gate!.severity).toBe('critical')
  })

  it('闭环联动锚定：runStage 对含 CJK 的 slots 返回 ok=false（critical gate 触发修正闭环条件）', () => {
    const stage = runStage({ target: 'anima', slots: { count_gender: ['1girl'], clothing: ['汉服'] }, variant: 'base', judge: 'off' })
    const gate = stage.gates.find((g) => g.rule === 'cjk_in_positive')
    expect(gate).toBeDefined()
    expect(gate!.severity).toBe('critical')
    // prompt-author 闭环条件：!stage.ok && gates.some(critical) → 必须为 false 才进闭环
    expect(stage.ok).toBe(false)
  })

  it('闭环联动锚定（对照）：纯英文 slots → runStage ok 不受本 gate 影响', () => {
    const stage = runStage({ target: 'anima', slots: { count_gender: ['1girl'], clothing: ['hanfu'] }, variant: 'base', judge: 'off' })
    expect(stage.gates.some((g) => g.rule === 'cjk_in_positive')).toBe(false)
  })
})
