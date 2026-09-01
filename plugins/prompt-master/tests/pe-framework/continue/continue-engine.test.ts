import { describe, expect, it } from 'vitest'
import { inspectOutput, type OutputContract } from '../../../src/pe-framework/continue/inspect.js'
import { mergeContinuedText } from '../../../src/pe-framework/continue/merge.js'
import { continueUntilComplete } from '../../../src/pe-framework/continue/engine.js'

const sixSegment: OutputContract = {
  id: 'minimax-full-reference',
  fields: [
    { key: 'subject_definitions', patterns: [/subject_definitions\s*[:：]/i] },
    { key: 'summary', patterns: [/summary\s*[:：]/i, /摘要\s*[:：]/] },
    { key: 'retention_analysis', patterns: [/retention_analysis\s*[:：]/i] },
    { key: 'detailed_description', patterns: [/detailed_description\s*[:：]/i] },
    { key: 'overall_soundscape', patterns: [/overall_soundscape\s*[:：]/i] },
    { key: 'non_diegetic_music', patterns: [/non_diegetic_music\s*[:：]/i] },
  ],
}

describe('inspectOutput', () => {
  it('complete text → complete=true, missing=[]', () => {
    const text = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    expect(inspectOutput(text, sixSegment)).toEqual({ missing: [], complete: true })
  })

  it('missing field reported as field:<key>', () => {
    const text = 'subject_definitions: X\nsummary: Y' // 只有 2/6
    const r = inspectOutput(text, sixSegment)
    expect(r.complete).toBe(false)
    expect(r.missing).toContain('field:retention_analysis')
  })

  it('label with empty body (<2 chars) counts as missing', () => {
    const text = 'subject_definitions: X\nsummary:\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    expect(inspectOutput(text, sixSegment).missing).toContain('field:summary')
  })
})

describe('mergeContinuedText', () => {
  it('model parrots full text → take continued only', () => {
    expect(mergeContinuedText('ABC', 'ABCDEF')).toBe('ABCDEF')
  })
  it('suffix-prefix overlap 12+ chars → dedupe join', () => {
    const prev = 'A'.repeat(200) + 'TAIL-COMMON-SEGMENT-XXXX'
    const cont = 'TAIL-COMMON-SEGMENT-XXXX' + 'B'.repeat(50)
    const merged = mergeContinuedText(prev, cont)
    expect(merged).toBe(prev + 'B'.repeat(50))
  })
  it('no overlap → newline join; strips greeting prefix', () => {
    expect(mergeContinuedText('AAA', '好的，BBB')).toBe('AAA\nBBB')
  })
})

describe('continueUntilComplete', () => {
  const seed = { system: 'sys', userText: '写六段', outputLang: 'zh' as const }

  it('no truncation + complete → returns immediately (rounds=0)', async () => {
    const full = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    let genCalls = 0
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: full, finishKind: 'stop', seed,
      generate: async () => { genCalls++; return { text: full, finishKind: 'stop' as const } },
      signal: new AbortController().signal,
    })
    expect(r.complete).toBe(true)
    expect(r.rounds).toBe(0)
    expect(genCalls).toBe(0)
  })

  it('max-tokens + incomplete → continues with accumulated text in user message', async () => {
    const part1 = 'subject_definitions: X\nsummary: Y'
    const cont = 'retention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    let capturedUser = ''
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: part1, finishKind: 'max-tokens', seed,
      generate: async (req) => { capturedUser = req.user; return { text: cont, finishKind: 'stop' as const } },
      signal: new AbortController().signal,
    })
    expect(r.complete).toBe(true)
    expect(r.rounds).toBe(1)
    expect(capturedUser).toContain('已写出')
    expect(capturedUser).toContain(part1)
    expect(r.text).toContain('subject_definitions')
    expect(r.text).toContain('non_diegetic_music')
  })

  it('abort mid-round → partial text + CONTINUE_ABORTED_PARTIAL warning', async () => {
    const ctl = new AbortController()
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: 'subject_definitions: X', finishKind: 'max-tokens', seed,
      generate: async (req) => {
        ctl.abort()
        return { text: 'summary: Y', finishKind: 'stop' as const }
      },
      signal: ctl.signal,
    })
    expect(r.complete).toBe(false)
    expect(r.warnings).toContain('CONTINUE_ABORTED_PARTIAL')
  })

  it('max rounds exhausted → INCOMPLETE_AFTER_MAX_ROUNDS', async () => {
    let n = 0
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: 'x', finishKind: 'max-tokens', seed, maxRounds: 2,
      generate: async () => { n++; return { text: `chunk${n}`, finishKind: 'max-tokens' as const } },
      signal: new AbortController().signal,
    })
    expect(r.complete).toBe(false)
    expect(r.warnings).toContain('INCOMPLETE_AFTER_MAX_ROUNDS')
    expect(r.rounds).toBe(2)
  })
})
