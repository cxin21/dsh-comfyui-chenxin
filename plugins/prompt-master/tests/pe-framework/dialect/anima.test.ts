/**
 * 2026-09-12 审计修复 #3（spec §5.1 L153）：compileAnima 装配处 rating 槽与 explicit 布尔
 * 兼容映射的可观测性——两者同给时 rating 胜出（resolveEffectiveRating 语义零改动），并
 * 增发 advisory `rating_overrides_explicit` 留痕（兼容映射被覆盖不得静默）；
 * 仅单给（只 rating / 只 explicit）不打。
 * hermetic：nullSearch 约定（anima-f1-dedup 同款——grounding 非本用例关注点，全部 miss）。
 */
import { describe, expect, it } from 'vitest'
import { compileAnima } from '../../../src/pe-framework/dialect/anima.js'
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'

/** mock search：全部 miss（本文件只关注 3b 分级装配面，与 grounding 无关） */
const nullSearch = (t: string): CatalogHit[] => []

const slots = (extra: Record<string, unknown>) => ({
  count_gender: ['1girl'], detail_mood: ['white dress'], ...extra,
}) as Parameters<typeof compileAnima>[0]

describe('rating vs explicit alias advisory (spec §5.1 L153, audit #3)', () => {
  it('rating + explicit:true given together → advisory rating_overrides_explicit; rating still wins', () => {
    const r = compileAnima(slots({ rating: 'sensitive', explicit: true }), { variant: 'base', search: nullSearch })
    expect(r.assumptions).toContain('rating_overrides_explicit')
    // rating 胜出语义不动：装配档位取 rating='sensitive'（非 explicit）
    expect(r.assumptions).toContain('rating_active:sensitive')
    expect(r.positive).toContain('rating_sensitive')
    expect(r.positive).not.toContain('rating_explicit')
    expect(r.negative).toContain('nude') // sensitive 档策略负向（档位判定随 rating 而非 explicit 布尔）
  })
  it('rating alone (no explicit bool) → no advisory', () => {
    const r = compileAnima(slots({ rating: 'explicit' }), { variant: 'base', search: nullSearch })
    expect(r.assumptions).not.toContain('rating_overrides_explicit')
    expect(r.assumptions).toContain('rating_active:explicit')
  })
  it('explicit bool alone → no advisory (legacy alias path unchanged)', () => {
    const r = compileAnima(slots({ explicit: true }), { variant: 'base', search: nullSearch })
    expect(r.assumptions).not.toContain('rating_overrides_explicit')
    expect(r.assumptions).toContain('rating_active:explicit')
    expect(r.positive).toContain('rating_explicit')
  })
})
