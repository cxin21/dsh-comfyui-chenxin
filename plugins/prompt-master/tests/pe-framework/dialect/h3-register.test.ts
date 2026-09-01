import { describe, expect, it, beforeEach } from 'vitest'
import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
import { normalizeH3Input, registerH3Dialect, compileH3 } from '../../../src/pe-framework/dialect/h3.js'

describe('H3 dialect registration', () => {
  beforeEach(() => { __resetDialectsForTests(); registerH3Dialect() })

  it('registers h3 with targetSlotHint t2v.prompt and auditOnlyOk', () => {
    const d = getDialect('h3')
    expect(d?.targetSlotHint).toBe('t2v.prompt')
    expect(d?.auditOnlyOk).toBe(true)
  })

  it('normalizeH3Input infers ref2va when references present', () => {
    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }], references: [{ who: 'x', image: 'p' }] } }, {})
    expect(r.stage).toBe('ref2va')
  })

  it('normalizeH3Input infers t2va when no references', () => {
    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }] } }, {})
    expect(r.stage).toBe('t2va')
  })

  it('normalizeH3Input error on missing shots', () => {
    expect(normalizeH3Input({}, {})?.error).toBeTruthy()
  })

  it('F1: form_fields.references merged into compile input value when shots.references empty', () => {
    const formRefs = [{ who: '阿澈', image: 'ref.png', width: 1024, height: 1024 }]
    const r = normalizeH3Input(
      { shots: { duration_seconds: 8, shots: [{ what: '阿澈回眸' }] } },
      { formFields: { references: formRefs } },
    )
    expect(r.stage).toBe('ref2va')
    const value = r.value!
    expect(value.references?.length).toBe(1)
    // 编译入参带 references → subject_definitions 非空（回归：空 refs 导致审计必炸）
    const { text } = compileH3(value, { stage: 'ref2va' })
    expect(text).toContain('subject_definitions')
    expect(text).toContain('<Subject 1>')
  })

  it('F2: compileH3 rejects shot missing `what` with readable error (not TypeError)', () => {
    expect(() => compileH3(
      { duration_seconds: 10, shots: [{ start_time_seconds: 0, content: 'x' }] as never },
      { stage: 't2va' },
    )).toThrow(/第 1 镜缺少 what 字段.*what/)
  })

  it('F3: trimPunct strips Chinese punctuation (no doubled .)', () => {
    // through compileH3: 中文句号结尾的 what 不应输出「推进。。」
    const { text } = compileH3({ duration_seconds: 6, shots: [{ what: '镜头缓缓推进。' }] }, { stage: 't2va' })
    expect(text).not.toMatch(/。。/)
    expect(text).toContain('镜头缓缓推进.')
  })
})
