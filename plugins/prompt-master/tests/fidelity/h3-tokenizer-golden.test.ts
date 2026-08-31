import { describe, expect, it, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readGolden } from './harness.js'
import { countTokensH3, encodeTokensH3, h3Tokenizer } from '../../src/pe-framework/audit/tokenizer-h3.js'

const TEXTS = (JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fidelity', 'fixtures', 'h3', 'tokenizer-texts.json'), 'utf8')) as any).texts as Array<{ id: string; text: string }>
const IDS_SAMPLE = new Set(['golden_t2va_baker', 'golden_ref2va_neko', 'edge_ja', 'edge_zh', 'edge_emoji_punct']) // id 序列 golden ≥3

describe('H3 tokenizer golden double-run (逐值 + id 序列)', () => {
  for (const t of TEXTS) {
    it(`${t.id}: framed/raw counts match golden exactly`, () => {
      const entry = readGolden(`h3-tokenizer-${t.id}`)
      const golden = entry.pythonOutput as any
      expect(h3Tokenizer().count(t.text)).toBe(golden.raw)
      expect(countTokensH3(t.text).tokens).toBe(golden.framed)
    })

    if (IDS_SAMPLE.has(t.id)) {
      it(`${t.id}: id sequence is element-wise identical to golden ids`, () => {
        const entry = readGolden(`h3-tokenizer-${t.id}`)
        const golden = entry.pythonOutput as any
        expect(encodeTokensH3(t.text)).toEqual(golden.ids)
      })
    }
  }

  it('all tokenizer goldens are sha256-self-consistent (M5)', () => {
    for (const t of TEXTS) {
      const entry = readGolden(`h3-tokenizer-${t.id}`)
      const sha = createHash('sha256').update(JSON.stringify(entry.pythonOutput)).digest('hex')
      expect(sha, `h3-tokenizer-${t.id}`).toBe(entry.sha256)
    }
  })

  afterAll(() => { /* tokenizer 单例常驻 */ })
})