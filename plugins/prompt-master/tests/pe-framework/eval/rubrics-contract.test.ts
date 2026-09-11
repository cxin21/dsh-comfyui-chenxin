import { describe, it, expect, beforeEach } from 'vitest'
import type { DialectRubric } from '../../../src/pe-framework/eval/rubrics/contract.js'
import { getDialect, registerDialect, __resetDialectsForTests } from '../../../src/pe-framework/dialect/registry.js'
import { registerAnimaDialect } from '../../../src/pe-framework/dialect/anima.js'
import { registerH3Dialect } from '../../../src/pe-framework/dialect/h3.js'

describe('DialectRubric contract', () => {
  beforeEach(() => { __resetDialectsForTests() }) // 清掉 dialect 模块 import 副作用注册，保证「未注册」前提
  it('rubric 是可选字段：已注册但不带 rubric 的方言返回 undefined（向后兼容）', () => {
    // 注册一个真实存在但不带 rubric 的最小方言 stub，满足 DialectContract 必需成员，其余可选项全省略
    registerDialect({
      // Target 类型不含测试专用 id，测试内 cast（仅测试文件，不影响 src 契约）
      id: 'test-norubric' as Parameters<typeof registerDialect>[0]['id'],
      label: 'x',
      auditOnlyOk: true,
      normalize: () => ({}),
      compile: (slots: unknown) => slots,
      audit: () => ({ gates: [] }),
      targetSlotHint: 'x',
    })
    expect(getDialect('test-norubric' as Parameters<typeof getDialect>[0])).toBeDefined()
    expect(getDialect('test-norubric' as Parameters<typeof getDialect>[0])!.rubric).toBeUndefined()
  })
  it('DialectRubric 类型形状可用（编译期断言 + 归一化示例）', () => {
    const example: DialectRubric = {
      dimensions: [
        { id: 'a', weight: 0.6, instruction: 'x' },
        { id: 'b', weight: 0.4, instruction: 'y' },
      ],
      severityRules: 'r',
      evidenceTools: ['catalog'],
      passThreshold: 80,
    }
    const sum = example.dimensions.reduce((s, d) => s + d.weight, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })
})

describe('dialect rubric 注册（Task 4, spec §2.2）', () => {
  beforeEach(() => { __resetDialectsForTests(); registerAnimaDialect(); registerH3Dialect() })

  it('anima/h3 方言带合法 rubric，权重归一化，阈值正确', () => {
    for (const [target, threshold] of [['anima', 80], ['h3', 75]] as const) {
      const rubric = getDialect(target)?.rubric
      expect(rubric).toBeDefined()
      const sum = rubric!.dimensions.reduce((s, d) => s + d.weight, 0)
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
      expect(rubric!.passThreshold).toBe(threshold)
      expect(rubric!.dimensions.length).toBeGreaterThanOrEqual(5)
    }
    expect(getDialect('anima')!.rubric!.evidenceTools).toContain('catalog')
    expect(getDialect('h3')!.rubric!.evidenceTools).toEqual(['tokenizer', 'aesthetics'])
  })
})
