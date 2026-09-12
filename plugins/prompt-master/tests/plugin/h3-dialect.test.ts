import { describe, expect, it } from 'vitest'
import { parseRequest, max_shots, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, MAX_PROMPT_CHARS, ContractError } from '../../src/pe-framework/schema/h3-shots.js'
import { compileH3 } from '../../src/pe-framework/dialect/h3.js'
import { contractGatesH3, auditH3, looksLikeMultishotPlan, planToShotsChecked } from '../../src/pe-framework/audit/rules-h3.js'
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
        { result: { text: compiled.text, text_zh: compiled.text_zh } },
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

describe('h3 per-shot duration (Phase 2 反均匀切分)', () => {
  it('explicit durations project cumulative cut points (no equal division)', () => {
    const { text } = compileH3({
      duration_seconds: 10,
      shots: [
        { what: 'establishing wide of the harbor.', duration: 6 },
        { what: 'close on the rope knot fraying.', duration: 2.5 },
        { what: 'the boat lurches away.', duration: 1.5 },
      ],
    })
    expect(text).toContain('At 00:06.000,')
    expect(text).toContain('At 00:08.500,')
  })

  it('missing duration falls back to equal division (golden-compatible)', () => {
    const { text } = compileH3({ duration_seconds: 9, shots: [{ what: 'a' }, { what: 'b' }, { what: 'c' }] })
    expect(text).toContain('At 00:03.000,')
    expect(text).toContain('At 00:06.000,')
  })

  it('contractGatesH3 rejects mixed explicit/implicit durations', () => {
    const gates = contractGatesH3('t2va', { duration_seconds: 8, shots: [{ what: 'a', duration: 4 }, { what: 'b' }] }, [])
    expect(gates.some((g) => g.rule === 'shot_duration_mixed' && g.severity === 'critical')).toBe(true)
  })

  it('contractGatesH3 rejects sums that do not equal duration_seconds', () => {
    const gates = contractGatesH3('t2va', { duration_seconds: 8, shots: [{ what: 'a', duration: 4 }, { what: 'b', duration: 3 }] }, [])
    expect(gates.some((g) => g.rule === 'shot_duration_sum' && g.severity === 'critical')).toBe(true)
  })

  it('contractGatesH3 flags sub-0.4s shots as minor', () => {
    const gates = contractGatesH3('t2va', { duration_seconds: 5, shots: [{ what: 'a', duration: 0.3 }, { what: 'b', duration: 4.7 }] }, [])
    const short = gates.find((g) => g.rule === 'shot_duration_short')
    expect(short?.severity).toBe('minor')
  })

  it('non-positive duration throws a readable error at compile', () => {
    expect(() =>
      compileH3({ duration_seconds: 8, shots: [{ what: 'a', duration: 0 }, { what: 'b', duration: 8 }] }),
    ).toThrow(/duration 必须为正数秒/)
  })
})

describe('h3 ref2va director depth (Phase 3 retention/subject 实化)', () => {
  it('quick（缺省）retention 保持 golden 口径（无 appears-in）', () => {
    const { text } = compileH3(
      { duration_seconds: 8, shots: [{ what: 'Neko waves.', who: 'Neko' }], references: [{ kind: 'picture', who: 'Neko', image: 'n.png' }] as any },
      { stage: 'ref2va' },
    )
    expect(text).toContain('<Subject 1> from <Picture 1> remains fully_preserved:')
    expect(text).not.toContain('(appears in')
  })

  it('depth=director retention 声明出现镜号（模型理解谁在哪几镜出现）', () => {
    const { text } = compileH3(
      {
        duration_seconds: 10,
        shots: [
          { what: 'Neko waves.', who: 'Neko' },
          { what: 'Mei waves back.', who: 'Mei' },
          { what: 'Both stand.', who: 'Neko' },
        ],
        references: [
          { kind: 'picture', who: 'Neko', image: 'n.png' },
          { kind: 'picture', who: 'Mei', image: 'm.png' },
        ] as any,
      },
      { stage: 'ref2va', depth: 'director' },
    )
    expect(text).toContain('<Subject 1> from <Picture 1> (appears in [Shot 1], [Shot 3]) remains fully_preserved:')
    expect(text).toContain('<Subject 2> from <Picture 2> (appears in [Shot 2]) remains fully_preserved:')
  })

  it('ref.description 下沉进 subject_definitions（生命核：身份/服装/材质/风格签名）', () => {
    const { text } = compileH3(
      {
        duration_seconds: 8,
        shots: [{ what: 'Neko waves.', who: 'Neko' }],
        references: [{ kind: 'picture', who: 'Neko', image: 'n.png', description: 'a silver-haired girl in a black-white uniform' }] as any,
      },
      { stage: 'ref2va' },
    )
    expect(text).toContain('<Subject 1> is Neko from <Picture 1> — a silver-haired girl in a black-white uniform.')
  })

  it('description 缺省时 subject_definitions 保持 golden 行（逐字节兼容）', () => {
    const { text } = compileH3(
      { duration_seconds: 8, shots: [{ what: 'Neko waves.', who: 'Neko' }], references: [{ kind: 'picture', who: 'Neko', image: 'n.png' }] as any },
      { stage: 'ref2va' },
    )
    expect(text).toContain('<Subject 1> is Neko from <Picture 1>.')
  })
})

describe('h3 constraints block (Phase 4 风格/负向约束段)', () => {
  const auditT2vaText = (text: string) => auditH3(text, { stage: 't2va', duration: 6, shotCount: 1 })

  it('constraints 追加为最后一个字段（t2va 与 ref2va），text_zh 保留字段头', () => {
    const t2va = compileH3({ duration_seconds: 6, shots: [{ what: 'A cat sleeps.' }], constraints: 'pure live action only; no 3D renders' })
    expect(t2va.text.trim().endsWith('constraints: pure live action only; no 3D renders')).toBe(true)
    expect(t2va.text_zh).toContain('constraints:')
    const ref2va = compileH3(
      {
        duration_seconds: 8,
        shots: [{ what: 'Neko waves.', who: 'Neko' }],
        references: [{ kind: 'picture', who: 'Neko', image: 'n.png' }] as any,
        constraints: 'flat cel style only',
      },
      { stage: 'ref2va' },
    )
    expect(ref2va.text.trim().endsWith('constraints: flat cel style only')).toBe(true)
  })

  it('合法尾块不产生 constraints_block gate，字段审计不受块体污染', () => {
    const { text } = compileH3({ duration_seconds: 6, shots: [{ what: 'A cat sleeps on the windowsill.' }], constraints: 'no camera shake' })
    const gates = auditT2vaText(text)
    expect(gates.some((g) => g.rule === 'constraints_block')).toBe(false)
    expect(gates.some((g) => g.severity === 'critical')).toBe(false)
  })

  it('重复块 → constraints_block critical', () => {
    const { text } = compileH3({ duration_seconds: 6, shots: [{ what: 'A cat sleeps.' }], constraints: 'no 3D' })
    const gates = auditT2vaText(`${text}\n\nconstraints: extra block`)
    expect(gates.some((g) => g.rule === 'constraints_block' && g.severity === 'critical')).toBe(true)
  })

  it('constraints 之后还有字段头 → constraints_block critical', () => {
    const base = compileH3({ duration_seconds: 6, shots: [{ what: 'A cat sleeps.' }] }).text
    const mid = base.replace('\n\noverall_soundscape:', '\n\nconstraints: no 3D renders\n\noverall_soundscape:')
    const gates = auditT2vaText(mid)
    expect(gates.some((g) => g.rule === 'constraints_block' && g.severity === 'critical')).toBe(true)
  })

  it('body 含 [Shot N] 标记 → constraints_block critical', () => {
    const { text } = compileH3({ duration_seconds: 6, shots: [{ what: 'A cat sleeps.' }], constraints: 'never introduce [Shot 2]' })
    const gates = auditT2vaText(text)
    expect(gates.some((g) => g.rule === 'constraints_block' && g.severity === 'critical')).toBe(true)
  })
})

describe('h3 director fields + MultishotPlan (Phase 5)', () => {
  it('shot camera/action/micro/carry 确定性投影进 [Shot N] 行（存在才投影）', () => {
    const { text } = compileH3({
      duration_seconds: 8,
      shots: [
        { what: 'the room sits in silence.', camera: 'the camera holds on the phone face-up on the table', micro: 'she presses her lips flat and retracts the reach', carry: 'the phone screen stays lit into the next shot' },
        { what: 'she grabs the phone.', action: 'the reach starts at the shoulder, the fingers close around the case' },
      ],
    })
    expect(text).toContain('The camera responds: the camera holds on the phone face-up on the table.')
    expect(text).toContain('Micro-performance: she presses her lips flat and retracts the reach.')
    expect(text).toContain('Carrying over: the phone screen stays lit into the next shot.')
    expect(text).toContain('The action plays out: the reach starts at the shoulder, the fingers close around the case.')
  })

  it('缺省导演字段保持 golden 口径（逐字节）', () => {
    const { text } = compileH3({ duration_seconds: 6, shots: [{ what: 'A cat sleeps.' }] })
    expect(text).toBe('integrated_multimodal_description: [Shot 1] A cat sleeps.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A')
  })

  it('plan 形状探测：shot_count/content → plan；what → 非 plan', () => {
    expect(looksLikeMultishotPlan({ shot_count: 2, shots: [] })).toBe(true)
    expect(looksLikeMultishotPlan({ shots: [{ content: 'x' }] })).toBe(true)
    expect(looksLikeMultishotPlan({ shots: [{ what: 'x' }] })).toBe(false)
    expect(looksLikeMultishotPlan({ duration_seconds: 8, shots: [{ what: 'x' }] })).toBe(false)
  })

  it('planToShotsChecked：合法 plan → shots（narrativeFunction 前缀 + camera/carry/duration 投影 + 可过审计）', () => {
    const plan = {
      total_duration: 9,
      shot_count: 2,
      edit_rhythm: 'slow build',
      continuity_strategy: 'matched exits',
      shots: [
        { content: 'the harbour wakes.', camera: 'slow push along the pier', shot_size: 'wide', composition: 'boats on the left third', action: 'gulls lift off as the first light hits', entry_state: 'still water', exit_state: 'ripples spreading', narrative_function: 'establish place', sound_focus: 'water lapping', active_references: [], start: 0, end: 5.5 },
        { content: 'a net is hauled up.', camera: 'handheld follow', shot_size: 'medium', action: 'two fishermen lean back and pull', entry_state: 'ripples spreading', exit_state: 'net dripping over the rail', narrative_function: 'introduce labor', sound_focus: 'rope strain', active_references: [], start: 5.5, end: 9 },
      ],
      continuity_ledger: { identity: 'two fishermen, unchanged', wardrobe_and_props: 'yellow slickers, coiled rope' },
    }
    const { shots, gates } = planToShotsChecked(plan)
    expect(gates.some((g) => g.severity === 'critical')).toBe(false)
    expect(shots).toBeDefined()
    expect(shots!.duration_seconds).toBe(9)
    expect(shots!.shots[0].what).toBe('establish place. the harbour wakes.')
    expect(shots!.shots[0].duration).toBe(5.5)
    expect(shots!.shots[0].camera).toBe('slow push along the pier; wide; boats on the left third')
    expect(shots!.shots[0].carry).toBe('Entry: still water; Exit: ripples spreading')
    expect(shots!.shots[1].duration).toBe(3.5)
    const compiled = compileH3({ duration_seconds: shots!.duration_seconds, shots: shots!.shots })
    const gateList = auditH3(compiled.text, { stage: 't2va', duration: 9, shotCount: 2 })
    expect(gateList.some((g) => g.severity === 'critical')).toBe(false)
  })

  it('planToShotsChecked：continuity_ledger 缺 identity → critical gate 且无 shots', () => {
    const { shots, gates } = planToShotsChecked({
      total_duration: 9,
      shot_count: 1,
      shots: [{ content: 'a.', start: 0, end: 9 }],
      continuity_ledger: { wardrobe_and_props: 'x' },
    })
    expect(shots).toBeUndefined()
    expect(gates.some((g) => g.rule === 'plan_ledger' && g.severity === 'critical')).toBe(true)
  })

  it('planToShotsChecked：时长断接 → plan_timing gate', () => {
    const { shots, gates } = planToShotsChecked({
      total_duration: 9,
      shot_count: 2,
      shots: [
        { content: 'a.', start: 0, end: 4 },
        { content: 'b.', start: 5, end: 9 },
      ],
      continuity_ledger: { identity: 'x', wardrobe_and_props: 'y' },
    })
    expect(shots).toBeUndefined()
    expect(gates.some((g) => g.rule === 'plan_timing')).toBe(true)
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