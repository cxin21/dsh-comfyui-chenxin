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

describe('inspectOutput groupSeparator (director_segments)', () => {
  const director: OutputContract = {
    id: 'minimax-director-segments', fields: [],
    groupSeparator: /={3,}\s*提示词组\s*(\d+)\s*={3,}/g,
    expectedGroups: (ff) => Number(ff?.segment_count ?? 4),
  }

  it('director contract: 3/4 groups → groups:3/4 missing', () => {
    const text = '前言\n===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\nB\n===== 提示词组 3 =====\nC'
    const r = inspectOutput(text, director, { segment_count: 4 })
    expect(r.complete).toBe(false)
    expect(r.missing.some(m => m.includes('3/4'))).toBe(true)
  })

  it('director contract: all 4 groups present → complete', () => {
    const text = '前言\n===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\nB\n===== 提示词组 3 =====\nC\n===== 提示词组 4 =====\nD'
    expect(inspectOutput(text, director, { segment_count: 4 }).complete).toBe(true)
  })

  it('empty group body → group:<n>:body missing', () => {
    const text = '===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\n   '
    const r = inspectOutput(text, director, { segment_count: 2 })
    expect(r.missing).toContain('group:2:body')
    expect(r.complete).toBe(false)
  })

  it('text starting with separator → leading segment absent, no phantom group', () => {
    const text = '===== 提示词组 1 =====\nA\n===== 提示词组 2 =====\nB'
    expect(inspectOutput(text, director, { segment_count: 2 }).complete).toBe(true)
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

  it('generate throws after mergeable piece → partial result returned (not throw)', async () => {
    let n = 0
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: 'subject_definitions: X\nsummary: Y', finishKind: 'max-tokens', seed,
      generate: async () => {
        n++
        if (n === 1) return { text: 'retention_analysis: Z', finishKind: 'max-tokens' as const }
        throw new Error('llm exploded mid-continuation')
      },
      signal: new AbortController().signal,
    })
    expect(r.complete).toBe(false)
    expect(r.warnings).toContain('CONTINUE_PARTIAL_BEFORE_ERROR')
    expect(r.text).toContain('retention_analysis: Z')
    expect(r.rounds).toBe(2)
  })

  it('generate throws before any merge → rethrows', async () => {
    await expect(continueUntilComplete({
      contract: sixSegment, initialText: 'subject_definitions: X', finishKind: 'max-tokens', seed,
      generate: async () => { throw new Error('boom') },
      signal: new AbortController().signal,
    })).rejects.toThrow('boom')
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
