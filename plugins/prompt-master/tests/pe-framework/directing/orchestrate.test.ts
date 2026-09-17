import { describe, expect, it } from 'vitest'
import { orchestrateDirecting, type DirectingDeps } from '../../../src/pe-framework/directing/orchestrate.js'
import type { ScriptIr } from '../../../src/pe-framework/directing/ir-schema.js'

const SCRIPT_IR: ScriptIr = {
  characters: [{ id: 'S1', name: '御姐', appearance_lock: 'tall', wardrobe: 'bodysuit', notes: '' }] as ScriptIr['characters'],
  locations: [{ id: 'L1', name: 'street', spatial_landmarks: 'neon gate' }],
  props: [],
  info_cuts: [{ beat_hint: 'B01', change: 'she appears' }],
}

const SCRIPT_ANALYST_OUT = JSON.stringify(SCRIPT_IR)

const BEATS = [
  {
    id: 'B01', purpose: 'establish',
    creative_intent: { state_before: 'calm', trigger: 'she enters', state_after: 'alert', audience_takeaway: 'she is dangerous' },
    location_id: 'L1', character_ids: ['S1'],
    shots: [
      {
        id: 'B01-S1', purpose_tag: 'establish' as const, duration_seconds: 4, stage: 't2va' as const,
        what: 'Wide establishing shot of the neon street with her standing in the center.',
        who: 'S1', shot_size: '全景', camera: '广角·慢推', transition: '硬切', technique: null,
        tags: [], sound: 'city hum with distant traffic',
        action: 'She stands and surveys the street.', micro: 'Her fingers tighten on her coat.',
        carry: 'Her gaze settles toward camera.', ambient: 'city hum with distant traffic',
        music: '', dialogue: undefined,
        shot_intent: { new_information: 'she appears on the street', narrative_subject: 'her presence', contains_reaction: false },
        reference_plan: [] as never[],
        direction: { performance: 'stands tall', staging: 'center of frame', cinematography: 'wide push', dialogue: null, micro_performance: 'breath steady' },
        continuity_handoff: { positions: 'center of frame', emotion: 'composed', props: 'no props in hand', audio: 'city hum' },
      },
    ],
  },
]

const BEAT_DIRECTOR_OUT = JSON.stringify({ beats: BEATS })

const SHOT_WRITER_OUT = JSON.stringify({
  shots: [{ what: 'wide shot', who: null, duration: 5, camera: '', action: '', micro: '', carry: '', ambient: 'city hum', dialogue: undefined }],
})

const PASS_AUDITOR = JSON.stringify({ verdict: 'pass', findings: [] })

function baseDeps(overrides?: Partial<DirectingDeps>): DirectingDeps {
  return {
    scriptAnalystRunner: async () => SCRIPT_ANALYST_OUT,
    beatDirectorRunner: async () => BEAT_DIRECTOR_OUT,
    shotWriterRunner: async () => SHOT_WRITER_OUT,
    auditorRunner: async () => PASS_AUDITOR,
    repairerRunner: async () => SHOT_WRITER_OUT,
    ...overrides,
  }
}

describe('orchestrateDirecting（spec §3/§7/§8）', () => {
  it('happy path: S1→S2→S3→S4 pass → completed, quality=passed', async () => {
    const r = await orchestrateDirecting({ script: '深夜剧本' }, baseDeps())
    expect(r.ok).toBe(true)
    expect(r.status).toBe('completed')
    expect(r.quality).toBe('passed')
    expect(r.corrections).toBe(0)
    expect(r.storyboard.beats).toHaveLength(1)
  })

  it('S1 失败 → fail-fast 显式错误', async () => {
    await expect(
      orchestrateDirecting({ script: 'x' }, baseDeps({ scriptAnalystRunner: async () => { throw new Error('LLM down') } })),
    ).rejects.toThrow('LLM down')
  })

  it('S3 单镜失败 → prompt:null 不阻塞其他镜', async () => {
    let call = 0
    const r = await orchestrateDirecting(
      { script: 'x' },
      baseDeps({
        beatDirectorRunner: async () =>
          JSON.stringify({ beats: [...BEATS, ...BEATS].map((b, i) => ({ ...b, id: `B0${i + 1}`, shots: b.shots.map((s) => ({ ...s, id: `B0${i + 1}-S1` })) })) }),
        shotWriterRunner: async () => { call++; if (call === 1) throw new Error('writer fail'); return SHOT_WRITER_OUT },
      }),
    )
    expect(r.ok).toBe(true) // 部分产出仍 ok（修复未耗尽）
    expect(r.quality).toBe('degraded') // S3 失败 → degraded
    expect(r.advisories.some((a) => a.startsWith('shot_writer_failed'))).toBe(true)
    expect(r.storyboard.beats).toHaveLength(2) // 链路未被单镜失败阻塞
  })

  it('S4 降级（auditor 故障）→ 仅机器门', async () => {
    const r = await orchestrateDirecting(
      { script: 'x' },
      baseDeps({ auditorRunner: async () => { throw new Error('audit down') } }),
    )
    expect(r.ok).toBe(true)
    expect(r.advisories.some((a) => a.startsWith('auditor_skipped'))).toBe(true)
  })

  it('await_user_approval → status=awaiting_approval（S2 后挂起）', async () => {
    const r = await orchestrateDirecting({ script: 'x', awaitUserApproval: true }, baseDeps())
    expect(r.status).toBe('awaiting_approval')
    expect(r.storyboard.beats.length).toBeGreaterThan(0)
  })
})
