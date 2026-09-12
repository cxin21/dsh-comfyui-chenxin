/**
 * 外部基准对比（2026-09）落地的 dialect 审计升级回归：
 * - A4：MUTUAL_EXCLUSIONS 扩容（对齐 NewBie-LLM-Formatter 冲突清单）
 * - A5：景别一致性 gate（framing_tag_mismatch）
 * - B8：artist 槽（校验白名单 + grounding prompt_form 升级 + miss 保真）
 */
import { describe, expect, it, afterAll } from 'vitest'
import { auditAnima, compileAnima, validateAnimaSlots } from '../../../src/pe-framework/dialect/anima.js'
import { searchCatalog, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'

const realSearch = (t: string) => searchCatalog(t, { limit: 5 })

describe('A4：互斥清单扩容', () => {
  it('新增互斥对逐对触发 mutual_exclusion', () => {
    const pairs: Array<[string, string]> = [
      ['solo', '2girls'],
      ['solo', '1boy'],
      ['solo', 'multiple girls'],
      ['open mouth', 'closed mouth'],
      ['spread legs', 'legs together'],
      ['spread fingers', 'clenched hand'],
    ]
    for (const [a, b] of pairs) {
      const gates = auditAnima(`${a}, ${b}`, '', {})
      expect(gates.some((g) => g.rule === 'mutual_exclusion'), `${a} + ${b}`).toBe(true)
    }
  })

  it('无害组合不误报（跨性别同框合法；1girl+1boy 不触发任何互斥）', () => {
    const gates = auditAnima('1girl, 1boy, spread fingers, open mouth', '', {})
    expect(gates.some((g) => g.rule === 'mutual_exclusion')).toBe(false)
    expect(gates.some((g) => g.detail.includes('1girl'))).toBe(false)
  })
})

describe('A5：景别一致性 gate', () => {
  it('close-up + full body → framing_tag_mismatch（互斥报告让位给更可执行的景别 gate）', () => {
    const gates = auditAnima('close-up, full body', '', {})
    expect(gates.some((g) => g.rule === 'framing_tag_mismatch')).toBe(true)
    expect(gates.filter((g) => g.rule === 'mutual_exclusion' && g.detail.includes('close-up'))).toHaveLength(0)
  })

  it('close-up + 鞋袜/过膝袜、cowboy shot + shoes 各自触发', () => {
    expect(auditAnima('close-up, thighhighs', '', {}).some((g) => g.rule === 'framing_tag_mismatch')).toBe(true)
    expect(auditAnima('upper body, pantyhose', '', {}).some((g) => g.rule === 'framing_tag_mismatch')).toBe(true)
    expect(auditAnima('cowboy shot, shoes', '', {}).some((g) => g.rule === 'framing_tag_mismatch')).toBe(true)
  })

  it('取景内可见组合合法（full body + shoes）', () => {
    expect(auditAnima('full body, shoes, standing', '', {}).some((g) => g.rule === 'framing_tag_mismatch')).toBe(false)
  })
})

describe('B8：artist 槽', () => {
  it('validateAnimaSlots 接受 artist 槽（字符串数组），拒绝非数组', () => {
    expect(validateAnimaSlots({ artist: ['rella'] })).toBeUndefined()
    expect(validateAnimaSlots({ artist: 'rella' })).toContain('artist')
    expect(validateAnimaSlots({ artist: [42] })).toContain('artist')
  })

  it('grounding 命中 → 经 prompt_form 升级为 @形输出（catalog 实库）', () => {
    const r = compileAnima({ artist: ['rella'] }, { variant: 'base', search: realSearch })
    expect(r.positive).toContain('@rella')
  })

  it('不存在的画师保留原文 + catalog_miss advisory（不自动替换）', () => {
    const r = compileAnima({ artist: ['zzzznotanartist'] }, { variant: 'base', search: realSearch })
    expect(r.positive).toContain('zzzznotanartist')
    expect(r.assumptions).toContain('catalog_miss:zzzznotanartist')
  })

  afterAll(() => closeCatalog())
})
