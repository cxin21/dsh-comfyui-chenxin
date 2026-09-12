/**
 * Round 8 Task 2Q（调研驱动）：提示词质量层改写——锚定补全 persona + 官方负向模板 +
 * narrative「条件纳入」（取代 Round8 T1 默认排除）。
 * 调研结论落地：Anima 是 tag+NL 混合方言（2-4 句英文 NL 管场景/光影/动作是官方原生格式），
 * tag 预算 20-40，场景槽 ≤3 锚点，多词自造短语转词表内规范 tag 或移入 NL，禁空泛词；
 * intent/enrich 均为「锚定补全」模式（brief 是锚点，LLM 只补全不重写）。
 * 行为规格（brief 七条，每条一个 it）。全程零 LLM；compile 用例 mock catalog
 * （纯函数注入 search），不依赖真库。
 */
import { describe, expect, it } from 'vitest'
import { ANIMA_PERSONA, ANIMA_SCHEMA } from '../../../src/pe-framework/intent/subagent-provider.js'
import { buildEnrichPersona } from '../../../src/pe-framework/enrich/personas.js'
import { compileAnima } from '../../../src/pe-framework/dialect/anima.js'
import type { CatalogHit } from '../../../src/pe-framework/dialect/anima-catalog.js'

/** mock search：全部 miss（persona/负向/narrative 检查与 grounding 无关；mock 走 user-fuzzy 原文保留路径） */
const nullSearch = (_t: string): CatalogHit[] => []

describe('T2Q A/D：persona 锚定补全改写', () => {
  it('规格1 ANIMA_PERSONA：预算/补全/配额/NL 块关键词在场，字面保留规则退场；schema narrative 注明 NL 场景块', () => {
    expect(ANIMA_PERSONA).toContain('20-40')
    expect(ANIMA_PERSONA).toContain('补全')
    expect(ANIMA_PERSONA).toMatch(/≤3|最多 3 个/)
    expect(ANIMA_PERSONA).toContain('2-4 句')
    expect(ANIMA_PERSONA).toContain('禁止罗列')
    expect(ANIMA_PERSONA).not.toContain('保持原文字面')
    expect(ANIMA_SCHEMA).toContain('2-4 句英文 NL 场景块')
  })

  it('规格7 enrich persona（anima）：tag 化准备指引在场；h3 分支不受影响', () => {
    const anima = buildEnrichPersona('anima')
    expect(anima).toContain('2-3 条')
    expect(anima).toContain('最多 3 条进 tag')
    expect(anima).toContain('holding sword')
    const h3 = buildEnrichPersona('h3')
    expect(h3).not.toContain('2-3 条')
    expect(h3).not.toContain('最多 3 条进 tag')
  })
})

describe('T2Q B：负向模板切官方', () => {
  it('规格2 base 默认 negative 含官方词表（artist name/blurry/jpeg artifacts/chromatic aberration 在内）', () => {
    const r = compileAnima({ count_gender: ['1girl'] }, { variant: 'base', search: nullSearch })
    expect(r.negative).toBe(
      'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration',
    )
  })
})

describe('T2Q C：narrative 条件纳入（取代 Round8 T1 默认排除）', () => {
  it('规格3 合格 NL（2-4 句英文场景块）→ 纳入 positive、无排除 advisory', () => {
    const narrative =
      'Rain drifts across the empty plaza in thin silver sheets. Neon signs smear their light over the wet stone. She walks slowly, letting the water soak through her coat.'
    const r = compileAnima({ count_gender: ['1girl'], narrative }, { variant: 'base', search: nullSearch })
    const seg = r.segments.find((s) => s.origin === 'narrative')
    expect(seg).toBeTruthy()
    expect(r.positive).toContain('Rain drifts across the empty plaza')
    expect(r.assumptions.some((a) => a.startsWith('narrative_excluded:'))).toBe(false)
  })

  it('规格4 逗号数>句数（tag 罗列形态）→ 排除 + narrative_excluded:tag_list advisory', () => {
    const narrative =
      'The city burns behind her. Smoke fills the air, ash on her skin, fire in her eyes, steel in her hand.'
    const r = compileAnima({ count_gender: ['1girl'], narrative }, { variant: 'base', search: nullSearch })
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.assumptions).toContain('narrative_excluded:tag_list:3commas/2sentences')
  })

  it('规格5 含 CJK → 排除 + narrative_excluded:cjk advisory（句子数达标，CJK 为决定原因）', () => {
    const narrative = 'The garden is quiet at dusk. 少女独自站在月光下的石桥上。A soft wind moves through the pines.'
    const r = compileAnima({ count_gender: ['1girl'], narrative }, { variant: 'base', search: nullSearch })
    expect(r.segments.some((s) => s.origin === 'narrative')).toBe(false)
    expect(r.assumptions).toContain('narrative_excluded:cjk')
  })

  it('规格6 allowNarrative=true 强制纳入：跳过质量检查（tag 罗列形态照进 positive），F1 去重仍生效', () => {
    const narrative = 'long hair, red eyes, white dress, standing in a garden'
    const r = compileAnima(
      { count_gender: ['1girl'], scene: ['garden'], narrative },
      { variant: 'base', search: nullSearch, allowNarrative: true },
    )
    const seg = r.segments.find((s) => s.origin === 'narrative')
    expect(seg).toBeTruthy()
    expect(seg?.text).toContain('long hair')
    expect(r.assumptions.some((a) => a.startsWith('narrative_excluded:'))).toBe(false)
  })
})
