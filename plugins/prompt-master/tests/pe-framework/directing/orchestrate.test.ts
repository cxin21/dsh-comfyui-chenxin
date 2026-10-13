import { describe, expect, it } from 'vitest'
import { orchestrateDirecting, type DirectingDeps } from '../../../src/pe-framework/directing/orchestrate.js'
import type { ScriptIr } from '../../../src/pe-framework/directing/ir-schema.js'
import { CallerCancelledError } from '../../../src/pe-framework/llm/cancel.js'

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
  shots: [{ what: 'wide shot', who: null, duration: 5, camera: 'wide push in', action: '', micro: '', carry: '', ambient: 'city hum', dialogue: undefined }],
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

  it('R2（spec §6.1②）：characters[].id 注入 speaker ID——双角色跨镜稳定', async () => {
    let calls = 0
    const twoCharScriptIr: ScriptIr = {
      characters: [
        { id: 'S1', name: '御姐', appearance_lock: 'tall', wardrobe: 'bodysuit', notes: '' },
        { id: 'S2', name: '侦探', appearance_lock: 'trench coat', wardrobe: 'coat', notes: '' },
      ],
      locations: [{ id: 'L1', name: 'street', spatial_landmarks: 'neon gate' }],
      props: [],
      info_cuts: [{ beat_hint: 'B01', change: 'x' }],
    }
    const mkDialogueBeat = (id: string, speakerId: string, name: string, line: string) => ({
      id,
      purpose: 'exchange',
      creative_intent: { state_before: 'a', trigger: 'b', state_after: 'c', audience_takeaway: 'd' },
      location_id: 'L1',
      character_ids: [speakerId],
      shots: [{
        id: `${id}-S1`, purpose_tag: 'dialogue' as const, duration_seconds: 4, stage: 't2va' as const,
        what: `${name} speaks.`, who: speakerId, shot_size: '中近景', camera: '平视·静止',
        tags: [], sound: 'voice', route_reason: 'text only',
        shot_intent: { new_information: 'line lands', narrative_subject: 'line', contains_reaction: true },
        reference_plan: [] as never[],
        direction: { performance: 'p', staging: 's', cinematography: 'c', dialogue: { speaker_id: speakerId, line, addressee_id: null }, micro_performance: 'm' },
        continuity_handoff: { positions: 'center', emotion: 'calm', props: 'none', audio: 'voice' },
      }],
    })
    const r = await orchestrateDirecting(
      { script: '她低声说，要走了。他回答，走吧。' },
      baseDeps({
        scriptAnalystRunner: async () => JSON.stringify(twoCharScriptIr),
        beatDirectorRunner: async () =>
          JSON.stringify({ beats: [mkDialogueBeat('B01', 'S1', '御姐', '要走了。'), mkDialogueBeat('B02', 'S2', '侦探', '走吧。')] }),
        shotWriterRunner: async () => {
          calls++
          return calls === 1
            ? JSON.stringify({ shots: [{ what: 'speaks', duration: 4, dialogue: { text: '要走了。', language: '中文' } }] })
            : JSON.stringify({ shots: [{ what: 'replies', duration: 4, dialogue: { text: '走吧。', language: '中文' } }] })
        },
      }),
    )
    expect(r.ok).toBe(true)
    const texts = r.storyboard.beats.flatMap((b) => b.shots).map((s) => s.prompt?.text ?? '')
    expect(texts[0]).toContain('御姐 (S1) says:')
    expect(texts[1]).toContain('侦探 (S2) says:')
    expect(texts[1]).not.toContain('(S1)')
  })

  it('R3（spec §4 Δ3）：reference_plan 绑定编译——ref2va 主体声明非空', async () => {
    const r = await orchestrateDirecting(
      { script: 'x' },
      baseDeps({
        beatDirectorRunner: async () =>
          JSON.stringify({ beats: [dBeatRef('B01')] }),
        shotWriterRunner: async () =>
          JSON.stringify({ shots: [{ what: 'She turns toward camera.', who: '御姐', duration: 4 }] }),
      }),
    )
    expect(r.ok).toBe(true)
    const text = r.storyboard.beats[0].shots[0].prompt?.text ?? ''
    expect(text).toContain('subject_definitions:')
    expect(text).toContain('<Subject 1> is 御姐 from <Picture 1>')
    expect(text).toContain('tall') // appearance_lock 注入主体描述
  })

  it('R8/R9（spec §4 meta + §5 道具三态）：S2 meta/props 合并进 DirectingIR', async () => {
    const r = await orchestrateDirecting(
      { script: 'x' },
      baseDeps({
        beatDirectorRunner: async () =>
          JSON.stringify({
            beats: [dBeatRef('B01')],
            meta: {
              sound_events: ['1 开场基底 城市底噪', '2 N/A'],
              audiovisual_signature: {
                medium: '实拍', aspect: '16:9', color_ids: { S1: '绯红' }, texture: ['霓虹'],
                core_theme: '她将珍珠掷入怒海', master_dna: ['锋利'], genre_formula: { opening: 'o', turn: 't', climax: 'c', ending: 'e' },
              },
            },
            props: [{ id: 'P1', name: 'phone', state_by_beat: { B01: '黑屏→亮屏→黑屏' } }],
          }),
      }),
    )
    expect(r.ok).toBe(true)
    const sb = r.storyboard
    expect(sb.meta.sound_events).toEqual(['1 开场基底 城市底噪', '2 N/A'])
    expect((sb.meta.audiovisual_signature as Record<string, unknown>).medium).toBe('实拍')
    expect(sb.props[0].state_by_beat.B01).toBe('黑屏→亮屏→黑屏')
    // S2 meta 在场时 G-sound/G-signature 应零违规（规范槽名 + 字段齐全 + 一角色一色相）
    expect(r.gates.filter((g) => g.rule === 'G-sound' || g.rule === 'G-signature')).toEqual([])
  })
})

describe('P2-4/P2-5（对抗审查修复）：resume 对账 / 词边界 / 取消穿透', () => {
  it('P2-4b：resume 换剧本 → resume_script_mismatch advisory，S1/S2 跳过、逐字对账不误烧修复', async () => {
    const pending = await orchestrateDirecting({ script: '原始剧本文本。', awaitUserApproval: true }, baseDeps())
    const r = await orchestrateDirecting(
      { script: '被偷换的新剧本文本。', resumeStoryboard: pending.storyboard },
      baseDeps({
        scriptAnalystRunner: async () => { throw new Error('S1 不应重跑') },
        beatDirectorRunner: async () => { throw new Error('S2 不应重跑') },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.advisories.some((a) => a.startsWith('resume_script_mismatch'))).toBe(true)
    expect(r.status).toBe('completed')
  })

  it('P2-4c：门点名 B01-S10 不得误伤健康镜 B01-S1（includes 子串陷阱）', async () => {
    const done = await orchestrateDirecting({ script: 'x' }, baseDeps())
    const ir = done.storyboard
    const keptText = ir.beats[0].shots[0].prompt?.text ?? ''
    // 同 Beat 克隆出 B01-S10（camera 置空违规）；镜号连续门也会点名 B01-S10
    const b = ir.beats[0]
    b.shots[0].time = '00:04'
    const s10 = JSON.parse(JSON.stringify(b.shots[0]))
    s10.id = 'B01-S10'
    s10.camera = ''
    b.shots.push(s10)
    let writerCalls = 0
    const r = await orchestrateDirecting(
      { resumeStoryboard: ir },
      baseDeps({
        shotWriterRunner: async () => { writerCalls++; return JSON.stringify({ shots: [{ what: 'wide shot', who: null, duration: 5, camera: 'wide push in', action: '', micro: '', carry: '', ambient: 'city hum' }] }) },
      }),
    )
    // includes 变异会让 'B01-S10' 匹配到 B01-S1 → 健康镜也被重写（writer=2）
    expect(writerCalls).toBe(1)
    expect(r.storyboard.beats[0].shots[0].prompt?.text).toBe(keptText)
  })

  it('P2-5：S3 writer 取消（CallerCancelledError）穿透编排器，不被吞成 advisory', async () => {
    const pending = await orchestrateDirecting({ script: 'x', awaitUserApproval: true }, baseDeps())
    await expect(
      orchestrateDirecting(
        { resumeStoryboard: pending.storyboard },
        baseDeps({ shotWriterRunner: async () => { throw new CallerCancelledError('已被调用方取消') } }),
      ),
    ).rejects.toThrow(/已被调用方取消/)
  })
})

/** R3 fixture：单 Beat × 单 ref2va 镜（identity_subject 绑定 S1） */
function dBeatRef(id: string) {
  return {
    id,
    purpose: 'identity lock',
    creative_intent: { state_before: 'a', trigger: 'b', state_after: 'c', audience_takeaway: 'd' },
    location_id: 'L1',
    character_ids: ['S1'],
    shots: [{
      id: `${id}-S1`, purpose_tag: 'dialogue' as const, duration_seconds: 4, stage: 'ref2va' as const,
      what: '御姐 turns toward camera.', who: '御姐', shot_size: '中近景', camera: '平视·静止',
      tags: [], sound: 'voice', route_reason: 'identity lock',
      shot_intent: { new_information: 'turn lands', narrative_subject: 'turn', contains_reaction: true },
      reference_plan: [{ role: 'identity_subject', target: 'S1', h3_label: 'Subject 1' }],
      direction: { performance: 'p', staging: 's', cinematography: 'c', dialogue: null, micro_performance: 'm' },
      continuity_handoff: { positions: 'center', emotion: 'calm', props: 'none', audio: 'voice' },
    }],
  }
}
