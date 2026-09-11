/**
 * 三期 Task 4（F5）：compileAnima 暴露 catalog 后处理（applyCanonicalSubstitutions）耗时 ms 字段。
 * 纯可观测，零行为变更；mock catalog（纯函数注入 search），不依赖真库。
 */
import { describe, expect, it } from 'vitest'
import { compileAnima } from '../../../src/pe-framework/dialect/anima.js'
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'

const hit = (match_type: CatalogHit['match_type'], prompt_form: string): CatalogHit => ({ match_type, prompt_form })

function mockSearch(table: Record<string, CatalogHit[]>) {
  const norm = (s: string) => s.trim().toLowerCase()
  return (t: string): CatalogHit[] => table[norm(t)] ?? []
}

describe('F5: compileAnima catalogMs 耗时字段', () => {
  it('替换发生 → catalogMs 为 number 且 ≥0，替换语义不变', () => {
    const search = mockSearch({
      '1girl': [hit('canonical', '1girl')],
      'beside a moon gate': [hit('fuzzy', 'moon gate')],
      'moon gate': [hit('canonical', 'moon gate')],
    })
    const r = compileAnima({ count_gender: ['1girl'], scene: ['beside a moon gate'] }, { variant: 'base', search })
    expect(typeof r.catalogMs).toBe('number')
    expect(r.catalogMs).toBeGreaterThanOrEqual(0)
    expect(r.corrections).toBe(1)
    expect(r.substitutions).toEqual(['beside a moon gate→moon gate'])
  })

  it('无替换 → catalogMs 仍为 number 且 ≥0（字段始终存在）', () => {
    const search = mockSearch({ '1girl': [hit('canonical', '1girl')] })
    const r = compileAnima({ count_gender: ['1girl'] }, { variant: 'base', search })
    expect(typeof r.catalogMs).toBe('number')
    expect(r.catalogMs).toBeGreaterThanOrEqual(0)
    expect(r.corrections).toBe(0)
  })
})
