import { describe, expect, it } from 'vitest'
import { buildH3Budget, H3_CONTEXT_LIMIT, DEFAULT_RUNTIME_SAFETY_MARGIN } from '../../../src/pe-framework/audit/budget.js'
import { countTokensH3 } from '../../../src/pe-framework/audit/tokenizer-h3.js'
import { resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
import { dirname } from 'node:path'

const realTokenizerDir = dirname(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' }))

describe('H3 budget chat-frame precision', () => {
  it('estimate fallback intact when tokenizer dir invalid', () => {
    const b = buildH3Budget('t2va', 'hello', [{ who: 'a', image: 'x', width: 1024, height: 1024 }], { tokenizerSourceDir: 'C:/nonexistent' })
    expect(b.counter).toBe('estimate')
    // 回退口径：帧底用旧估算 5+2N（1 引用 → 7）
    expect(b.chatTemplateTokens).toBe(7)
  })

  it('exact frame bottom with real tokenizer: refs>0 帧底来自 countTokensH3 而非 5+2N', () => {
    const b = buildH3Budget('t2va', 'hello', [{ who: 'a', image: 'x', width: 1024, height: 1024 }], { tokenizerSourceDir: realTokenizerDir })
    expect(b.counter).toBe('official-tokenizer')
    const exactFrame = countTokensH3('', realTokenizerDir, 1).tokens
    expect(b.chatTemplateTokens).toBe(exactFrame)
    // 旧估算是 7（5+2*1）——官方帧（im_start/user/vision pads/im_end）严格大于估算
    expect(exactFrame).toBeGreaterThan(7)
  })

  it('zero-ref frame bottom matches golden baseline (framed-raw=5, t2va_baker golden)', () => {
    const b = buildH3Budget('t2va', 'x'.repeat(100), [], { tokenizerSourceDir: realTokenizerDir })
    expect(b.chatTemplateTokens).toBe(5) // golden: raw=76 framed=81 → 无引用帧底 = 5
    expect(b.qualityCap).toBe(1200)
    expect(b.over).toBe(false)
  })

  it('effectiveCap reflects exact frame bottom in available', () => {
    const refs = [{ who: 'a', image: 'x', width: 1024, height: 1024 }]
    const b = buildH3Budget('t2va', 'hello', refs, { tokenizerSourceDir: realTokenizerDir })
    const frame = countTokensH3('', realTokenizerDir, 1).tokens
    const available = H3_CONTEXT_LIMIT - 1024 - frame - DEFAULT_RUNTIME_SAFETY_MARGIN
    expect(b.effectiveCap).toBe(Math.min(1200, available))
  })
})
