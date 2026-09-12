import { describe, expect, it } from 'vitest'
import { auditH3, auditH3Full, auditMultishotPlan, compilePlan, compilePlanToShots, shotDraftFromDict, type H3AuditMeta } from '../../src/pe-framework/audit/rules-h3.js'
import { buildH3Budget, h3BudgetToReport, STAGE_QUALITY_CAPS, visualTokens } from '../../src/pe-framework/audit/budget.js'
import { compileH3, buildTextZh } from '../../src/pe-framework/dialect/h3.js'
import { readGolden } from '../fidelity/harness.js'

const t2vaMeta = (duration: number, shotCount: number): H3AuditMeta => ({ stage: 't2va', duration, shotCount })

describe('h3 audit gates (audit.py port) — passing golden outputs', () => {
  it('t2va-baker golden text passes all t2va gates', () => {
    const golden = readGolden('t2va-baker') as any
    const text = golden.pythonOutput.result.text
    expect(auditH3(text, t2vaMeta(8, 2))).toEqual([])
  })

  it('t2va-sword-peaks golden text passes (5 shots, 15s)', () => {
    const golden = readGolden('t2va-sword-peaks') as any
    expect(auditH3(golden.pythonOutput.result.text, t2vaMeta(15, 5))).toEqual([])
  })

  it('i2va golden text passes keyframe audit', () => {
    const golden = readGolden('i2va-window') as any
    expect(auditH3(golden.pythonOutput.result.text, { stage: 'i2va', duration: 6, shotCount: 1 })).toEqual([])
  })

  it('fl2va golden text passes keyframe audit', () => {
    const golden = readGolden('fl2va-cyclist') as any
    expect(auditH3(golden.pythonOutput.result.text, { stage: 'fl2va', duration: 8, shotCount: 1 })).toEqual([])
  })

  it('ref2va golden text passes the structural gates (no-reference variant)', () => {
    const golden = readGolden('ref2va-neko') as any
    const gates = auditH3(golden.pythonOutput.result.text, { stage: 'ref2va', duration: 8, shotCount: 1 })
    expect(gates).toEqual([])
  })
})

describe('h3 audit gates — every rule one test', () => {
  const base = 'integrated_multimodal_description: [Shot 1] A cat sits.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'

  it('cut_timestamps: first shot with a timestamp fails', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] At 00:01.000, the camera cuts to a cat.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    const gates = auditH3(bad, t2vaMeta(6, 1))
    expect(gates.some((g) => g.rule === 'cut_timestamps')).toBe(true)
  })

  it('F1 regression: first-shot-with-timestamp is detected on EVERY consecutive auditH3 call (no regex lastIndex state leakage)', () => {
    // t38 F1：CUT_PREFIX 若带 /g 且未复位 lastIndex，第二次及以后调用会静默放过首镜时间戳。
    // 当前实现 CUT_PREFIX 为非全局正则（^ 锚定 + 每次 test/exec 从 0 起搜）；此用例双重调用锁定该语义。
    const bad = 'integrated_multimodal_description: [Shot 1] At 00:01.000, the camera cuts to a cat.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    const first = auditH3(bad, t2vaMeta(6, 1))
    expect(first.some((g) => g.rule === 'cut_timestamps')).toBe(true)
    // 第二次调用（同一模块实例/同一规则正则）必须仍然检测到
    const second = auditH3(bad, t2vaMeta(6, 1))
    expect(second.some((g) => g.rule === 'cut_timestamps')).toBe(true)
  })

  it('cut_timestamps: non-sequential shot numbers fail', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] a. [Shot 3] b.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    const gates = auditH3(bad, t2vaMeta(6, 2))
    expect(gates.map((g) => g.rule)).toContain('cut_timestamps')
    expect(gates[0].severity).toBe('critical')
    expect(gates[0].source).toBe('audit/rules-h3')
  })

  it('cut_timestamps: timestamp with seconds >= 60 fails', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] a. [Shot 2] At 00:60.000, the camera cuts to b.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, t2vaMeta(8, 2)).some((g) => g.rule === 'cut_timestamps')).toBe(true)
  })

  it('cut_timestamps: shot timestamp beyond video duration fails', () => {
    // duration 4s：第二镜 at 00:04.000 → start=4.0 >= duration_seconds=4.0 → 越界
    const bad = 'integrated_multimodal_description: [Shot 1] a. [Shot 2] At 00:04.000, the camera cuts to b.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, t2vaMeta(4, 2)).some((g) => g.rule === 'cut_timestamps')).toBe(true)
  })

  it('shot_count: declared count mismatch fails', () => {
    const gates = auditH3(base, t2vaMeta(6, 2))
    expect(gates.map((g) => g.rule)).toContain('shot_count')
  })

  it('max_shots: shot count exceeds cap fails', () => {
    const threeShots = 'integrated_multimodal_description: [Shot 1] a. [Shot 2] At 00:02.000, the camera cuts to b. [Shot 3] At 00:04.000, the camera cuts to c.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(threeShots, t2vaMeta(6, 3)).some((g) => g.rule === 'max_shots')).toBe(true)
  })

  it('field_order: wrong field order fails', () => {
    const bad = 'overall_soundscape: N/A\n\nintegrated_multimodal_description: [Shot 1] a.\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, t2vaMeta(6, 1)).some((g) => g.rule === 'field_order')).toBe(true)
  })

  it('dialogue_markup: bare <d> without language fails', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] a <d>hi</d>.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, t2vaMeta(6, 1)).some((g) => g.rule === 'dialogue_markup')).toBe(true)
  })

  it('soundscape_dialogue: dialogue repeated in overall_soundscape fails', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] a.\n\noverall_soundscape: <d>[English] hi</d>\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, t2vaMeta(6, 1)).some((g) => g.rule === 'soundscape_dialogue')).toBe(true)
  })

  it('soundscape_dialogue: non-diegetic marker in soundscape fails', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] a.\n\noverall_soundscape: background music\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, t2vaMeta(6, 1)).some((g) => g.rule === 'soundscape_dialogue')).toBe(true)
  })

  it('soundscape_dialogue: dialogue in music fails', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] a.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: <d>[English] hi</d>'
    expect(auditH3(bad, t2vaMeta(6, 1)).some((g) => g.rule === 'soundscape_dialogue')).toBe(true)
  })

  it('shot_execution: empty shot content fails', () => {
    const bad = 'integrated_multimodal_description: [Shot 1] \n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, t2vaMeta(6, 1)).some((g) => g.rule === 'shot_execution')).toBe(true)
  })

  it('Phase 8a: model-native 转场声明（hard cut / match cut / cut to / whip pan）通过 shot_execution', () => {
    for (const decl of ['hard cut. a door slams shut.', 'match cut. the same cup sits in a different room.', 'cut to the courtyard.', 'whip pan to the far corridor.']) {
      const text = `integrated_multimodal_description: [Shot 1] A cat sleeps on the windowsill.\n\n[Shot 2] At 00:03.000, ${decl}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`
      expect(auditH3(text, t2vaMeta(6, 2)).some((g) => g.rule === 'shot_execution'), decl).toBe(false)
    }
  })

  it('Phase 8a: 无转场声明的正文仍被 shot_execution 拒绝', () => {
    const text = 'integrated_multimodal_description: [Shot 1] A cat sleeps on the windowsill.\n\n[Shot 2] At 00:03.000, the room is quiet and nobody moves.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(text, t2vaMeta(6, 2)).some((g) => g.rule === 'shot_execution')).toBe(true)
  })

  it('char_budget: 7001-char prompt fails', () => {
    const huge = '[Shot 1] ' + 'x'.repeat(7000)
    const bad = `integrated_multimodal_description: ${huge}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`
    expect(auditH3(bad, t2vaMeta(6, 1)).some((g) => g.rule === 'char_budget')).toBe(true)
  })
})

describe('h3 audit gates — keyframe preambles', () => {
  it('i2va preamble must anchor <Picture 1> at 0.00 seconds', () => {
    const bad = 'For the target video, at 1.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] a.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, { stage: 'i2va', duration: 6, shotCount: 1 }).some((g) => g.rule === 'alignment_preamble')).toBe(true)
  })

  it('fl2va preamble must end at the duration mark', () => {
    const bad = 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 5.00-second mark of the target video.\n\nintegrated_multimodal_description: [Shot 1] a.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A'
    expect(auditH3(bad, { stage: 'fl2va', duration: 8, shotCount: 1 }).some((g) => g.rule === 'alignment_preamble')).toBe(true)
  })
})

describe('h3 audit gates — ref2va label resolution', () => {
  it('every ordered input image must be referenced; used Subject must be defined', () => {
    const golden = readGolden('ref2va-neko') as any
    const text = golden.pythonOutput.result.text
    const refs = [{ who: 'Neko', image: 'n.png', width: 1024, height: 1024 }]
    expect(auditH3Full(text, { stage: 'ref2va', duration: 8, shotCount: 1, references: refs as any })).toEqual([])
    // undefined subject usage: drop the definition line → used Subject 1 has no definition
    const bad = text.replace('<Subject 1> is Neko from <Picture 1>.', '')
    const gates = auditH3Full(bad, { stage: 'ref2va', duration: 8, shotCount: 1, references: refs as any })
    expect(gates.some((g) => g.rule === 'label_resolution')).toBe(true)
  })
})

describe('h3 multishot plan gates (multishot.py compile_plan port)', () => {
  it('valid plan compiles to zero findings', () => {
    const plan = {
      totalDuration: 12,
      shotCount: 4,
      editRhythm: 'establishing to release',
      continuityStrategy: 'single subject',
      shots: [1, 2, 3, 4].map((n) =>
        shotDraftFromDict(
          { shot: n, content: `neko action ${n}`, camera: 'static', transition: n === 1 ? 'opening' : 'cut', sound_focus: 'wind', start: (n - 1) * 3, end: n * 3 },
          n,
        ),
      ),
      continuityLedger: { identity: 'Neko', wardrobe_and_props: 'hoodie' },
    }
    expect(compilePlan(plan)).toEqual([])
  })

  it('plan_timing: shots must connect and end at total_duration', () => {
    const plan = {
      totalDuration: 12,
      shotCount: 2,
      editRhythm: '',
      continuityStrategy: '',
      shots: [
        shotDraftFromDict({ shot: 1, content: 'a', start: 0, end: 4 }, 1),
        shotDraftFromDict({ shot: 2, content: 'b', start: 5, end: 10 }, 2),
      ],
      continuityLedger: { identity: 'Neko', wardrobe_and_props: 'hoodie' },
    }
    const gates = auditMultishotPlan(plan)
    expect(gates.some((g) => g.rule === 'plan_timing')).toBe(true)
  })

  it('plan_ledger: identity and wardrobe_and_props required', () => {
    const plan = {
      totalDuration: 8,
      shotCount: 1,
      editRhythm: '',
      continuityStrategy: '',
      shots: [shotDraftFromDict({ shot: 1, content: 'a', start: 0, end: 8 }, 1)],
      continuityLedger: { identity: 'Neko' },
    }
    const gates = auditMultishotPlan(plan)
    expect(gates.map((g) => g.rule)).toContain('plan_ledger')
  })

  it('compilePlanToShots maps content → what, sound_focus → ambient', () => {
    const drafts = [shotDraftFromDict({ shot: 1, content: 'neko jumps', sound_focus: 'wind' }, 1)]
    const shots = compilePlanToShots({ shots: drafts } as any)
    expect(shots[0].what).toBe('neko jumps')
    expect(shots[0].ambient).toBe('wind')
  })
})

describe('h3 budget projection (budget.py + budget-policy.json port)', () => {
  it('quality caps table matches official caps', () => {
    expect(STAGE_QUALITY_CAPS).toEqual({ t2va: 1200, i2va: 1500, fl2va: 1700, l2va: 1700, ref2va: 2400 })
  })

  it('projection fields align with golden budget semantics', () => {
    const golden = readGolden('t2va-baker') as any
    const text = golden.pythonOutput.result.text
    const b = buildH3Budget('t2va', text, [])
    expect(b.charCount).toBe(text.length)
    expect(b.charLimit).toBe(7000)
    expect(b.qualityCap).toBe(1200)
    expect(b.over).toBe(false)
    // 官方 golden text_tokens（81）为准；T12 起 TS 精确计数与 golden 逐值一致
    const g = golden.pythonOutput.result.budget
    expect(g.quality_cap).toBe(1200)
    expect(g.effective_cap).toBe(1200)
    expect(g.over).toBe(false)
    expect(b.textTokens).toBe(g.text_tokens) // 精确计数器 = 官方值（81，非臆造）
    // AuditReport.budget 形状
    const reportBudget = h3BudgetToReport(b)
    expect(reportBudget.counter).toBe('official-tokenizer')
    expect(reportBudget.over).toBe(false)
  })

  it('char_over true when text exceeds 7000 chars', () => {
    const b = buildH3Budget('t2va', 'x'.repeat(7001))
    expect(b.charOver).toBe(true)
    expect(b.over).toBe(true)
  })

  it('visual_tokens stride contract (32px spatial stride)', () => {
    const assumptions: string[] = []
    expect(visualTokens({ who: 'Neko', image: 'n.png', width: 1024, height: 1024 }, assumptions)).toBe(32 * 32)
    expect(visualTokens({ who: 'Pic', image: 'p.png', width: null, height: null }, assumptions)).toBe(32 * 32)
    expect(assumptions[0]).toContain('reference_dimensions_assumed')
  })
})

describe('h3 dialect audit roundtrip: compiled output always passes its own audit', () => {
  it('compileH3 t2va → auditH3 empty', () => {
    const { text } = compileH3({
      duration_seconds: 15,
      shots: [
        { what: 'A bird flies over the valley.', ambient: 'wind', music: 'strings' },
        { what: 'The bird lands on a branch.', ambient: 'leaves' },
        { what: 'The bird turns its head.', music: 'soft piano' },
      ],
    })
    const gates = auditH3(text, t2vaMeta(15, 3))
    expect(gates).toEqual([])
    expect(buildTextZh(text)).toBeTruthy()
  })
})