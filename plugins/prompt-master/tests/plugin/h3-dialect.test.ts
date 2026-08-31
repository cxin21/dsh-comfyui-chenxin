import { describe, expect, it } from 'vitest'
import { parseRequest, max_shots, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, MAX_PROMPT_CHARS, ContractError } from '../../src/pe-framework/schema/h3-shots.js'
import { compileH3 } from '../../src/pe-framework/dialect/h3.js'
import { readGolden, assertGolden } from '../fidelity/harness.js'

describe('h3 contracts (contracts.py port)', () => {
  it('max_shots follows the official formula', () => {
    expect(max_shots(4)).toBe(2)
    expect(max_shots(6)).toBe(2)
    expect(max_shots(7)).toBe(3)
    expect(max_shots(9)).toBe(3)
    expect(max_shots(12)).toBe(4)
    expect(max_shots(15)).toBe(5)
  })

  it('duration bounds are the official envelope', () => {
    expect(MIN_DURATION_SECONDS).toBe(4)
    expect(MAX_DURATION_SECONDS).toBe(15)
    expect(MAX_PROMPT_CHARS).toBe(7000)
    expect(() => parseRequest('t2va', { duration_seconds: 3, shots: [{ what: 'x' }] })).toThrow(/between 4 and 15/)
    expect(() => parseRequest('t2va', { duration_seconds: 16, shots: [{ what: 'x' }] })).toThrow(/between 4 and 15/)
  })

  it('shot count cap enforced', () => {
    expect(() =>
      parseRequest('t2va', {
        duration_seconds: 4,
        shots: [{ what: 'a' }, { what: 'b' }, { what: 'c' }],
      }),
    ).toThrow(/exceed the maximum 2 for 4s /)
  })

  it('unknown stage / unknown fields rejected', () => {
    expect(() => parseRequest('flux', { duration_seconds: 6, shots: [{ what: 'x' }] })).toThrow(/unknown minimax-h3-prompt stage/)
    expect(() =>
      parseRequest('t2va', { duration_seconds: 6, shots: [{ what: 'x' }], bogus: 1 }),
    ).toThrow(/unsupported request field/)
  })

  it('dialogue markup is rejected at parse', () => {
    expect(() =>
      parseRequest('t2va', { duration_seconds: 6, shots: [{ what: 'x', dialogue: '<d>hi</d>' }] }),
    ).toThrow(/must not contain <d> markup/)
  })

  it('ref2va identity rules', () => {
    const refs = [{ kind: 'picture', who: 'Neko', image: 'n.png', width: 1024, height: 1024 }]
    const r = parseRequest('ref2va', { duration_seconds: 8, shots: [{ what: 'x', who: 'Neko' }], references: refs as any })
    expect(r.shots[0].who).toBe('Neko')
    // who mismatch
    expect(() =>
      parseRequest('ref2va', { duration_seconds: 8, shots: [{ what: 'x', who: 'Mei' }], references: refs as any }),
    ).toThrow(/does not match any reference 'who'/)
    // missing who on ref
    expect(() =>
      parseRequest('ref2va', { duration_seconds: 8, shots: [{ what: 'x' }], references: [{ kind: 'picture', image: 'n.png' }] as any }),
    ).toThrow(/requires a 'who'/)
  })

  it('keyframe stages reject video/audio and require 1-2 pictures without who', () => {
    expect(() =>
      parseRequest('i2va', { duration_seconds: 6, shots: [{ what: 'x' }], references: [] }),
    ).toThrow(/requires at least one picture reference/)
    expect(() =>
      parseRequest('fl2va', {
        duration_seconds: 8,
        shots: [{ what: 'x' }],
        references: [{ kind: 'picture', who: 'Neko', image: 'n.png' }] as any,
      }),
    ).toThrow(/who must be absent for fl2va/)
  })
})

describe('h3 dialect golden double-run (dialect.py port)', () => {
  const CASES: Array<{ name: string; stage: string; plan?: boolean }> = [
    { name: 't2va-baker', stage: 't2va' },
    { name: 't2va-sword-peaks', stage: 't2va' },
    { name: 'i2va-window', stage: 'i2va' },
    { name: 'fl2va-cyclist', stage: 'fl2va' },
    { name: 'ref2va-neko', stage: 'ref2va' },
    { name: 'ref2va-mei-three-refs', stage: 'ref2va' },
  ]

  for (const { name, stage } of CASES) {
    it(`${name}: compileH3 text/text_zh byte-exact against golden`, () => {
      const golden = readGolden(name) as any
      const input = golden.input
      const compiled = compileH3(input, { stage })
      assertGolden(
        { result: { text: compiled.text, text_zh: compiled.textZh } },
        name,
        ['result.text', 'result.text_zh'],
      )
    })
  }

  it('fl2va-multishot: official validation failure reproduced (no refs under fl2va)', () => {
    const golden = readGolden('fl2va-multishot') as any
    const input = golden.input
    let threw: Error | undefined
    try {
      // parseRequest（计划模式下 validate 仍由 contracts 管 stages）
      parseRequest('fl2va', input as Record<string, unknown>)
    } catch (e) {
      threw = e as Error
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String(threw?.message)).toMatch(/fl2va requires at least one picture reference/)
    const env = golden.pythonOutput
    expect(env.errors?.[0]?.code).toBe('validation_failed')
    expect(String(env.errors?.[0]?.message)).toContain('fl2va requires at least one picture reference')
  })

  it('compileH3 defaults stage to t2va', () => {
    const { text } = compileH3({ duration_seconds: 8, shots: [{ what: 'A cat sleeps.' }] })
    expect(text).toContain('integrated_multimodal_description: [Shot 1] A cat sleeps.')
  })
})

describe('h3 dialect rendering shapes (d.h: 结构对照 t2va/ref2va 六段式)', () => {
  it('t2va renders exactly three fields in fixed order', () => {
    const { text } = compileH3({ duration_seconds: 6, shots: [{ what: 'sunrise' }] })
    const headers = ['integrated_multimodal_description:', 'overall_soundscape:', 'non_diegetic_music:']
    const pos = headers.map((h) => text.indexOf(h))
    expect(pos.every((p) => p >= 0)).toBe(true)
    expect(pos).toEqual([...pos].sort((a, b) => a - b))
  })

  it('ref2va renders six fields in fixed order with subject labels', () => {
    const { text } = compileH3(
      { duration_seconds: 8, shots: [{ what: 'Neko waves.', who: 'Neko' }], references: [{ kind: 'picture', who: 'Neko', image: 'n.png' } as any] },
      { stage: 'ref2va' },
    )
    expect(text).toContain('subject_definitions: <Subject 1> is Neko from <Picture 1>.')
    expect(text).toContain('summary: [reference generation] Neko (<Picture 1>) appears in a 8-second, 1-shot video')
    const headers = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']
    const pos = headers.map((h) => text.indexOf(h))
    expect(pos).toEqual([...pos].sort((a, b) => a - b))
    expect(ContractError).toBeDefined()
  })

  it('dialogue preserved byte-for-byte inside <d>[Language]</d>', () => {
    const { text } = compileH3({
      duration_seconds: 8,
      shots: [{ what: 'open', dialogue: 'First batch of the morning.' }, { what: 'steam' }],
    })
    expect(text).toContain('<d>[English] First batch of the morning.</d>')
  })
})