import { describe, expect, it } from 'vitest'
import { buildH3Budget, h3BudgetToReport, estimateTokens, H3_CONTEXT_LIMIT } from '../../src/pe-framework/audit/budget.js'
import { countTokensH3 } from '../../src/pe-framework/audit/tokenizer-h3.js'

describe('H3 budget exact tokenizer (T12 切换)', () => {
  it('official-tokenizer counter + tokens exactly match countTokensH3 framed context', () => {
    const text = 'integrated_multimodal_description: [Shot 1] A cat stretches.'
    const b = buildH3Budget('t2va', text, [])
    expect(b.counter).toBe('official-tokenizer')
    expect(b.textTokens).toBe(countTokensH3(text).tokens)
    expect(b.textTokens).toBeGreaterThan(0)
    const report = h3BudgetToReport(b)
    expect(report.counter).toBe('official-tokenizer')
    expect(report.tokens).toBe(b.textTokens)
  })

  it('over gate triggers on token-budget excess (exact count, high-entropy text)', () => {
    // 确定性 LCG 高熵文本（不可 BPE 压缩）：5000 字符 → 精确 2693 tokens > effectiveCap 1200
    let huge = ''
    for (let i = 0; i < 5000; i++) huge += String.fromCharCode(97 + ((i * 16807) % 26))
    const b = buildH3Budget('t2va', huge, [])
    expect(b.counter).toBe('official-tokenizer')
    expect(b.textTokens).toBeGreaterThan(1200)
    expect(b.tokenOver).toBe(true)
    expect(b.over).toBe(true)
  })

  it('estimate fallback fires when tokenizer sourceDir is invalid (counter=estimate)', () => {
    const b = buildH3Budget('t2va', 'hello', [], { tokenizerSourceDir: 'C:/nonexistent-tokenizer-dir' })
    expect(b.counter).toBe('estimate')
    expect(b.textTokens).toBe(estimateTokens('hello'))
  })

  it('max = effectiveCap = min(qualityCap, available)', () => {
    const b = buildH3Budget('t2va', 'ok', [])
    const report = h3BudgetToReport(b)
    expect(report.max).toBe(b.effectiveCap)
    expect(b.effectiveCap).toBe(1200) // 无引用 → available 极大，cap=quality cap
    expect(H3_CONTEXT_LIMIT).toBe(262144)
  })

  it('golden-aligned exact count: t2va-baker framed text → official 81 tokens', () => {
    const text = 'integrated_multimodal_description: [Shot 1] A baker opens the shutters at sunrise. <d>[English] First batch of the morning.</d> [Shot 2] At 00:04.000, the camera cuts to Steam rises from sliced bread.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    const b = buildH3Budget('t2va', text, [])
    expect(b.counter).toBe('official-tokenizer')
    expect(b.textTokens).toBe(81) // 与 T5 golden budget.text_tokens 逐值一致（非臆造）
  })
})