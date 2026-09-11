import { describe, it, expect } from 'vitest'
import type { DialectRubric } from '../../../src/pe-framework/eval/rubrics/contract.js'
import { getDialect } from '../../../src/pe-framework/dialect/registry.js'

describe('DialectRubric contract', () => {
  it('rubric 是可选字段：未注册的方言返回 undefined（向后兼容）', () => {
    // 从 dialect/registry.ts 导出表中任取一个没有 rubric 的方言（如 sd，若不存在则用注册表里任一真实方言）
    const dialect = getDialect('generic' as never) ?? getDialect('anima')
    expect(dialect?.rubric).toBeUndefined() // 本任务不注册任何 rubric
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
