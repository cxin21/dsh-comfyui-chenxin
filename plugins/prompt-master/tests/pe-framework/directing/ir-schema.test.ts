import { describe, expect, it } from 'vitest'
import {
  validateDirectingIr,
  validateScriptIr,
  PURPOSE_TAGS,
  STAGES,
  DURATION_RANGES,
  type DirectingIr,
} from '../../../src/pe-framework/directing/ir-schema.js'

/** GOOD fixture：2 Beat × 4 shot，覆盖官方 5 stages 与 6 purpose_tag（spec §4 契约） */
export function buildGoodIr(): DirectingIr {
  const handoff = { positions: 'left of gate', emotion: 'composed', props: 'phone black', audio: 'city hum' }
  const intent = { state_before: 'a', trigger: 'b', state_after: 'c', audience_takeaway: 'd' }
  return {
    meta: {
      title: 't',
      source_script_hash: 'h',
      created_at: '2026-09-17',
      dialect: 'h3',
      director_schema_version: 1,
      rating: 'safe',
      original_rating: 'explicit',
      strict_prompt_validation: false,
    },
    characters: [{ id: 'S1', name: '御姐', appearance_lock: 'a', wardrobe: 'w', notes: '' }],
    locations: [{ id: 'L1', name: '街道', spatial_landmarks: 'neon gate' }],
    props: [{ id: 'P1', name: 'phone', state_by_beat: { B01: '黑屏→亮屏通知→黑屏' } }],
    beats: [
      {
        id: 'B01',
        purpose: 'establish her presence',
        creative_intent: { ...intent },
        location_id: 'L1',
        character_ids: ['S1'],
        shots: [
          {
            id: 'B01-S1',
            purpose_tag: 'establish',
            what: 'Street and her stance in wide frame.',
            time: '00:00',
            duration_seconds: 3,
            shot_size: '全景',
            camera: '广角·慢推',
            sound: 'city hum',
            stage: 't2va',
            route_reason: 'no refs needed',
            shot_intent: { new_information: 'street and her stance', narrative_subject: 'street', contains_reaction: false },
            reference_plan: [],
            direction: { performance: 'stands tall', staging: 'center', cinematography: 'wide push', dialogue: null, micro_performance: 'breath steady' },
            continuity_handoff: { ...handoff },
            prompt: null,
            audit: null,
          },
          {
            id: 'B01-S2',
            purpose_tag: 'dialogue',
            what: 'She turns and speaks.',
            time: '00:03',
            duration_seconds: 2,
            shot_size: '中近景',
            camera: '平视·静止',
            sound: 'her voice',
            dialogue: { text: '太安静了。', language: 'Chinese' },
            stage: 'ref2va',
            route_reason: 'identity lock',
            shot_intent: { new_information: 'her line lands', narrative_subject: 'her line', contains_reaction: true },
            reference_plan: [{ role: 'identity_subject', target: 'S1', h3_label: 'Subject 1' }],
            direction: {
              performance: 'holds gaze',
              staging: 'center',
              cinematography: 'locked',
              dialogue: { speaker_id: 'S1', line: '太安静了。', addressee_id: null },
              micro_performance: 'smirk',
            },
            continuity_handoff: { ...handoff },
            prompt: null,
            audit: null,
          },
        ],
      },
      {
        id: 'B02',
        purpose: 'she departs',
        creative_intent: { ...intent },
        location_id: 'L1',
        character_ids: ['S1'],
        shots: [
          {
            id: 'B02-S1',
            purpose_tag: 'dialogue',
            what: 'He replies from off-frame.',
            time: '00:05',
            duration_seconds: 2,
            shot_size: '中近景',
            camera: '过肩·静止',
            sound: 'reply',
            dialogue: { text: '嗯。', language: 'Chinese' },
            stage: 'i2va',
            route_reason: 'first frame given',
            shot_intent: { new_information: 'reply lands', narrative_subject: 'reply', contains_reaction: true },
            reference_plan: [{ role: 'composition_picture', target: 'L1', h3_label: 'Picture 1' }],
            direction: { performance: 'turns', staging: 'center', cinematography: 'locked', dialogue: { speaker_id: 'S1', line: '嗯。', addressee_id: null }, micro_performance: 'nod' },
            continuity_handoff: { ...handoff },
            prompt: null,
            audit: null,
          },
          {
            id: 'B02-S2',
            purpose_tag: 'action',
            what: 'She walks away into the crowd.',
            time: '00:07',
            duration_seconds: 1,
            shot_size: '中远景',
            camera: '跟拍·快',
            sound: 'heels on wet asphalt',
            stage: 'fl2va',
            route_reason: 'state A to B',
            shot_intent: { new_information: 'she walks away', narrative_subject: 'her exit', contains_reaction: false },
            reference_plan: [
              { role: 'composition_picture', target: 'L1', h3_label: 'Picture 1' },
              { role: 'composition_picture', target: 'L1', h3_label: 'Picture 2' },
            ],
            direction: { performance: 'walks off', staging: 'exit right', cinematography: 'tracking', dialogue: null, micro_performance: 'coat flare' },
            continuity_handoff: { ...handoff },
            prompt: null,
            audit: null,
          },
          {
            id: 'B02-S3',
            purpose_tag: 'insert',
            what: 'Door latch closes.',
            time: '00:08',
            duration_seconds: 1,
            shot_size: '特写',
            camera: '俯拍·静止',
            sound: 'door latch',
            stage: 'l2va',
            route_reason: 'last frame given',
            shot_intent: { new_information: 'door closes', narrative_subject: 'door', contains_reaction: false },
            reference_plan: [{ role: 'composition_picture', target: 'L1', h3_label: 'Picture 1' }],
            direction: { performance: 'latch', staging: 'door', cinematography: 'static', dialogue: null, micro_performance: 'hand slips' },
            continuity_handoff: { ...handoff },
            prompt: null,
            audit: null,
          },
        ],
      },
    ],
    continuity_ledger: [],
  }
}

function withViolation(mutate: (ir: DirectingIr) => void): DirectingIr {
  const ir = buildGoodIr()
  mutate(ir)
  return ir
}

describe('validateDirectingIr（spec §4 契约）', () => {
  it('GOOD fixture → ok=true, missing=[]', () => {
    const r = validateDirectingIr(buildGoodIr())
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('creative_intent 四字段之一缺失 → 违规指明字段', () => {
    const ir = withViolation((ir) => {
      delete (ir.beats[0] as unknown as Record<string, unknown>).creative_intent
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('creative_intent'))).toBe(true)
  })

  it('shot_intent 数与 shots 数不等 → 违规', () => {
    const ir = withViolation((ir) => {
      delete (ir.beats[1].shots[2] as unknown as Record<string, unknown>).shot_intent
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('shot_intent'))).toBe(true)
  })

  it('对白 Beat 无 contains_reaction → 违规', () => {
    const ir = withViolation((ir) => {
      for (const s of ir.beats[1].shots) s.shot_intent!.contains_reaction = false
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('contains_reaction'))).toBe(true)
  })

  it('purpose_tag 非法 → 违规', () => {
    const ir = withViolation((ir) => {
      ;(ir.beats[0].shots[0].purpose_tag as unknown as string) = 'closeup'
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('purpose_tag'))).toBe(true)
  })

  it('stage 非法 → 违规', () => {
    const ir = withViolation((ir) => {
      ;(ir.beats[0].shots[0].stage as unknown as string) = 't2v'
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('stage'))).toBe(true)
  })

  it('duration 出 purpose_tag 区间（dialogue 5s）→ 违规', () => {
    const ir = withViolation((ir) => {
      ir.beats[0].shots[1].duration_seconds = 5
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('duration'))).toBe(true)
  })

  it('props.state_by_beat 非三态 → 违规', () => {
    const ir = withViolation((ir) => {
      ir.props[0].state_by_beat.B01 = '黑屏'
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('三态'))).toBe(true)
  })

  it('非首 Beat handoff 空通道 → 违规', () => {
    const ir = withViolation((ir) => {
      ir.beats[1].shots[0].continuity_handoff.positions = ''
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('continuity_handoff'))).toBe(true)
  })

  it('首 Beat handoff 空通道 → 合法（spec §6 G-handoff 限定非首 Beat）', () => {
    const ir = withViolation((ir) => {
      for (const s of ir.beats[0].shots) {
        s.continuity_handoff = { positions: '', emotion: '', props: '', audio: '' }
      }
    })
    const r = validateDirectingIr(ir)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })
})

describe('validateScriptIr（S1 输出契约）', () => {
  it('合法 ScriptIR → ok=true', () => {
    const r = validateScriptIr({
      characters: [{ id: 'S1', name: '御姐', appearance_lock: 'a', wardrobe: 'w', notes: '' }],
      locations: [{ id: 'L1', name: '街道', spatial_landmarks: 'x' }],
      props: [{ id: 'P1', name: 'phone' }],
      info_cuts: [{ beat_hint: 'B01', change: 'notification arrives' }],
    })
    expect(r.ok).toBe(true)
  })
  it('角色缺 appearance_lock → 违规', () => {
    const r = validateScriptIr({
      characters: [{ id: 'S1', name: '御姐' }],
      locations: [],
      props: [],
      info_cuts: [],
    })
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => m.includes('appearance_lock'))).toBe(true)
  })
})

describe('常量导出（spec §6 G-duration 数据源）', () => {
  it('PURPOSE_TAGS 六枚举 / STAGES 五枚举 / DURATION_RANGES 与 spec 一致', () => {
    expect(PURPOSE_TAGS).toEqual(['dialogue', 'mixed', 'action', 'establish', 'insert', 'reaction'])
    expect(STAGES).toEqual(['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'])
    expect(DURATION_RANGES.dialogue).toEqual([2, 4])
    expect(DURATION_RANGES.action).toEqual([0.4, 1.5])
    expect(DURATION_RANGES.insert).toEqual([0.5, 2])
    expect(DURATION_RANGES.reaction).toEqual([1, 2])
    expect(DURATION_RANGES.establish).toEqual([2, 4])
    expect(DURATION_RANGES.mixed).toEqual([1.5, 3])
  })
})
