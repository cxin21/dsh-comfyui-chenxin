import { describe, expect, it, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { h3Tokenizer, countTokensH3, encodeTokensH3, tokenizerMeta } from '../../src/pe-framework/audit/tokenizer-h3.js'
import { closeCatalog } from '../../src/pe-framework/dialect/anima-catalog.js'

const TEXTS = (JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fidelity', 'fixtures', 'h3', 'tokenizer-texts.json'), 'utf8')) as any).texts as Array<{ id: string; text: string }>
const countOf = (id: string): string => TEXTS.find((t) => t.id === id)!.text

describe('H3 tokenizer (BPE, practitioner-verified against venv Python backend)', () => {
  it('metadata: vocab/merges/added tokens sizes', () => {
    const meta = tokenizerMeta()
    expect(meta.vocabSize).toBe(151643)
    expect(meta.merges).toBe(151387)
    expect(meta.addedTokens).toBe(26)
    expect(meta.specialTokens).toBe(14)
  })

  it('empty text: raw 0 tokens, framed 5 (chat template frame only)', () => {
    expect(h3Tokenizer().count(countOf('edge_empty'))).toBe(0)
    expect(countTokensH3(countOf('edge_empty')).tokens).toBe(5)
  })

  it('golden t2va-baker framed count matches official budget.text_tokens (81)', () => {
    expect(countTokensH3(countOf('golden_t2va_baker')).tokens).toBe(81)
    expect(h3Tokenizer().count(countOf('golden_t2va_baker'))).toBe(76) // raw
  })

  it('goldens: sword 155 / i2va 77 / fl2va 104', () => {
    expect(countTokensH3(countOf('golden_t2va_sword')).tokens).toBe(155)
    expect(countTokensH3(countOf('golden_i2va_window')).tokens).toBe(77)
    expect(countTokensH3(countOf('golden_fl2va_cyclist')).tokens).toBe(104)
  })

  it('goldens: ref2va neko 121 / mei 171', () => {
    expect(countTokensH3(countOf('golden_ref2va_neko')).tokens).toBe(121)
    expect(countTokensH3(countOf('golden_ref2va_mei')).tokens).toBe(171)
  })

  it('multilingual: zh 21 / ja 26 framed', () => {
    expect(countTokensH3(countOf('edge_zh')).tokens).toBe(21)
    expect(countTokensH3(countOf('edge_ja')).tokens).toBe(26)
  })

  it('dialogue tags + punctuation-dense text counts exactly', () => {
    expect(countTokensH3(countOf('edge_en_dialogue')).tokens).toBe(50)
    expect(countTokensH3(countOf('edge_emoji_punct')).tokens).toBe(26)
  })

  it('collapsed spaces preserved in byte-level encoding', () => {
    expect(countTokensH3(countOf('edge_spaces_empty')).tokens).toBe(10)
    expect(h3Tokenizer().count(countOf('edge_spaces_empty'))).toBe(5)
  })

  it('special tokens emit as single ids inside text (vision markers)', () => {
    const named = '<|vision_start|><|image_pad|><|vision_end|>'
    const ids = encodeTokensH3(named)
    expect(ids.length).toBe(3) // 三个标记各自独立成 token（不进入 BPE）
    for (const id of ids) expect(Number.isInteger(id)).toBe(true)
  })

  it('frame adds exactly 5 tokens when text has no specials', () => {
    const base = countTokensH3(countOf('edge_zh')).tokens
    const raw = h3Tokenizer().count(countOf('edge_zh'))
    expect(base - raw).toBe(5)
  })

  afterAll(() => closeCatalog())
})