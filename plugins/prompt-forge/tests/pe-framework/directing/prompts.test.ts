import { describe, expect, it } from 'vitest'
import {
  SCRIPT_ANALYST_PERSONA,
  buildScriptAnalystPrompt,
  parseScriptIrOutput,
  BEAT_DIRECTOR_PERSONA,
  buildBeatDirectorPrompt,
  parseBeatDirectorOutput,
  SHOT_WRITER_PERSONA,
  buildShotWriterPrompt,
  parseShotWriterOutput,
  CONTINUITY_AUDITOR_PERSONA,
  buildContinuityAuditorPrompt,
  parseContinuityAuditorOutput,
  REPAIRER_PERSONA,
  buildRepairerPrompt,
  parseRepairerOutput,
} from '../../../src/pe-framework/directing/prompts.js'
import { buildGoodIr } from './ir-schema.test.js'

describe('五槽位 persona 存在性与关键纪律（spec §5）', () => {
  it('S1 剧本分析：台词原文不改写 + appearance_lock', () => {
    expect(SCRIPT_ANALYST_PERSONA).toContain('台词原文')
    expect(SCRIPT_ANALYST_PERSONA).toContain('appearance_lock')
    expect(SCRIPT_ANALYST_PERSONA).toContain('不得暗改剧情')
  })
  it('S2 Beat 导演：双锚点 + WenWu 引擎 + stage 路由', () => {
    expect(BEAT_DIRECTOR_PERSONA).toContain('catalog_search')
    expect(BEAT_DIRECTOR_PERSONA).toContain('双锚点')
    expect(BEAT_DIRECTOR_PERSONA).toContain('叙事温度')
    expect(BEAT_DIRECTOR_PERSONA).toContain('stage')
    expect(BEAT_DIRECTOR_PERSONA).toContain('不得用抽象情绪词')
  })
  it('S3 成文：编译职位 + 官方对白契约 + 运镜三维', () => {
    expect(SHOT_WRITER_PERSONA).toContain('catalog_search')
    expect(SHOT_WRITER_PERSONA).toContain('编译职位')
    expect(SHOT_WRITER_PERSONA).toContain('says in an off-screen voiceover')
    expect(SHOT_WRITER_PERSONA).toContain('<scenetrans>')
    expect(SHOT_WRITER_PERSONA).toContain('<cutoff>')
    expect(SHOT_WRITER_PERSONA).toContain('amplitude')
    expect(SHOT_WRITER_PERSONA).toContain('镜头脉冲')
  })
  it('S4 审计：QC 八维 + P0/P1/P2 + 审片顺序', () => {
    expect(CONTINUITY_AUDITOR_PERSONA).toContain('catalog_search')
    expect(CONTINUITY_AUDITOR_PERSONA).toContain('Story')
    expect(CONTINUITY_AUDITOR_PERSONA).toContain('Rhythm')
    expect(CONTINUITY_AUDITOR_PERSONA).toContain('P0')
    expect(CONTINUITY_AUDITOR_PERSONA).toContain('先完整看一遍')
  })
  it('S5 修复：最小返工路由 + 保护表演 + 两次同类失败', () => {
    expect(REPAIRER_PERSONA).toContain('catalog_search')
    expect(REPAIRER_PERSONA).toContain('最小返工')
    expect(REPAIRER_PERSONA).toContain('保护好表演')
    expect(REPAIRER_PERSONA).toContain('两次同类失败')
  })
})

describe('buildXxxPrompt 分区模板（统一格式）', () => {
  const ir = buildGoodIr()
  it('S1: 剧本文本进数据块', () => {
    const p = buildScriptAnalystPrompt('深夜，她在街角点燃了一支烟。')
    expect(p).toContain('<task_persona>')
    expect(p).toContain('深夜')
    expect(p).toContain('<output_contract>')
  })
  it('S2: ScriptIR 进数据块 + catalog_search 工具协议', () => {
    const p = buildBeatDirectorPrompt({
      characters: [{ id: 'S1', name: '御姐', appearance_lock: 'tall' }],
      locations: [{ id: 'L1', name: 'street', spatial_landmarks: 'neon' }],
      props: [],
      info_cuts: [{ beat_hint: 'B01', change: 'she appears' }],
    })
    expect(p).toContain('<blueprint_v1>')
    expect(p).toContain('catalog_search')
  })
  it('S3: Beat 方案进数据块', () => {
    const p = buildShotWriterPrompt(ir.beats[0], ir.characters, ir.locations)
    expect(p).toContain('<blueprint_v1>')
    expect(p).toContain('catalog_search')
  })
  it('S4: 机检结果进数据块', () => {
    const p = buildContinuityAuditorPrompt(ir, ['G-duration(important): test'])
    expect(p).toContain('<response>')
    expect(p).toContain('G-duration')
  })
  it('S5: 违规清单进数据块', () => {
    const p = buildRepairerPrompt(ir.beats[0].shots[0], ['G-dialogue-official(critical): test'], ['[major] fix this'])
    expect(p).toContain('<violations>')
    expect(p).toContain('G-dialogue-official')
  })
})

describe('parse 函数契约校验', () => {
  it('S1 parseScriptIrOutput: 合法 ScriptIR 解析', () => {
    const r = parseScriptIrOutput(JSON.stringify({
      characters: [{ id: 'S1', name: 'n', appearance_lock: 'a' }],
      locations: [{ id: 'L1', name: 'l', spatial_landmarks: 'x' }],
      props: [],
      info_cuts: [],
    }))
    expect(r.characters).toHaveLength(1)
  })
  it('S2 parseBeatDirectorOutput: 返回 beats + meta/props 契约（R8/R9）', () => {
    const r = parseBeatDirectorOutput(JSON.stringify({
      beats: [{ id: 'B01', purpose: 'p', creative_intent: { state_before: 'a', trigger: 'b', state_after: 'c', audience_takeaway: 'd' }, location_id: 'L1', character_ids: ['S1'], shots: [] }],
      meta: { climax_segment: 'B01', sound_events: ['1 开场基底 底噪'] },
      props: [{ id: 'P1', name: 'phone', state_by_beat: { B01: '黑屏→亮屏→黑屏' } }],
    }))
    expect(r.beats).toHaveLength(1)
    expect(r.beats[0].id).toBe('B01')
    expect(r.meta?.climax_segment).toBe('B01')
    expect(r.props?.[0].state_by_beat.B01).toContain('→')
    const bare = parseBeatDirectorOutput(JSON.stringify({ beats: [] }))
    expect(bare.beats).toEqual([])
    expect(bare.meta).toBeUndefined()
  })
  it('S3 parseShotWriterOutput: 返回 H3Shot 兼容字段', () => {
    const r = parseShotWriterOutput(JSON.stringify({ shots: [{ what: 'x', who: 'S1' }] }))
    expect(r[0].what).toBe('x')
  })
  it('S4 parseContinuityAuditorOutput: verdict + findings', () => {
    const r = parseContinuityAuditorOutput(JSON.stringify({ verdict: 'pass', findings: [] }))
    expect(r.verdict).toBe('pass')
  })
  it('S5 parseRepairerOutput: 复用 H3Shot 契约', () => {
    const r = parseRepairerOutput(JSON.stringify({ what: 'fixed', who: 'S1' }))
    expect(r.what).toBe('fixed')
  })
})
