import { describe, expect, it, vi } from 'vitest'
import { orchestrateCompositing } from '../../../src/pe-framework/compositing/orchestrate.js'
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js'

// fixtures（spec 2026-09-17 agentic-pipeline-redesign：S3 writer / S4 auditor / S5 repairer 三 LLM）
const V0: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'paper lanterns along the corridor' },
    style_hints: ['cel shading'] },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal', negative_hints: [],
}

const ENRICH_PATCH = JSON.stringify({ set: { mood: 'nocturnal, quietly tense' }, additions: { core: { style_hints: ['cel shading'] } } })

// A6 回退直查缝：同步返回 canonical 命中
const SEARCH = (q: string) => [{ prompt_form: q, match_type: 'canonical', usage_count: 1000 }]

const VALID_OUT = JSON.stringify({
  tags: [
    { text: 'long black hair', source_concept: 'S1.appearance' },
    { text: 'standing', source_concept: 'S1.pose' },
    { text: 'full body', source_concept: 'composition.framing' },
    { text: 'paper lanterns along the corridor', source_concept: 'core.scene.lighting_idea' },
    { text: 'cel shading', source_concept: 'core.style_hints[0]' },
  ],
  nl: 'She sits on the right third of the frame. Lantern light keeps her face exposed with no silhouette.',
  negative: [],
})

const PASS_AUDITOR = JSON.stringify({ verdict: 'pass', findings: [] })
const NEEDS_AUDITOR = JSON.stringify({
  verdict: 'needs_revision',
  findings: [{ severity: 'major', dimension: 'D', problem: 'mood not expressed', requiredFix: 'express nocturnal mood in nl' }],
})

describe('orchestrateCompositing (agentic 三 LLM 管线)', () => {
  it('happy path: writer → auditor pass → ok, corrections=0, quality=passed', async () => {
    const outcome = await orchestrateCompositing(V0, 'explicit', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      auditorRunner: async () => PASS_AUDITOR,
      repairRunner: async () => { throw new Error('repair should not run') },
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.corrections).toBe(0)
    expect(outcome.fallbackUsed).toBe(false)
    expect(outcome.quality).toBe('passed')
    expect(outcome.positive).toContain('rating_explicit')
    expect(outcome.positive).toContain('long black hair')
    expect(outcome.v1.mood).toContain('quietly tense')
    expect(outcome.auditor?.verdict).toBe('pass')
    expect(outcome.advisories.some((a) => a.startsWith('enrich_path_violation'))).toBe(false)
  })

  it('A2：writer/auditor/repairer 是三个独立 runner（各自被调用，label 由装配层区分）', async () => {
    const writer = vi.fn(async () => VALID_OUT)
    const auditor = vi.fn(async () => PASS_AUDITOR)
    const repair = vi.fn(async () => VALID_OUT)
    await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: writer,
      auditorRunner: auditor,
      repairRunner: repair,
      search: SEARCH,
    }, { minTags: 0 })
    expect(writer).toHaveBeenCalledTimes(1)
    expect(auditor).toHaveBeenCalledTimes(1)
    expect(repair).not.toHaveBeenCalled()
  })

  it('fabricated tag（verifyTag 拒绝）→ repairer 产出修复版 → 每轮 auditor 必跑（A3）', async () => {
    const writerPrompts: string[] = []
    const auditorPrompts: string[] = []
    const repairPrompts: string[] = []
    const BAD = JSON.stringify({ tags: [{ text: 'neon glow', source_concept: 'S1.pose' }], nl: 'She stands alone.', negative: [], dropped_concepts: [] })
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async (p) => { writerPrompts.push(p); return VALID_OUT },
      auditorRunner: async (p) => { auditorPrompts.push(p); return auditorPrompts.length === 1 ? NEEDS_AUDITOR : PASS_AUDITOR },
      repairRunner: async (p) => { repairPrompts.push(p); return BAD },
      verifyTag: (tag) => tag !== 'neon glow',
      search: SEARCH,
    }, { minTags: 0 })
    // 第一轮：writer 产物被 auditor 判 needs_revision（无 critical）→ repairer 介入
    expect(repairPrompts.length).toBe(2) // r1 修复 BAD（仍含 fabricated tag）→ r2 再修 → 耗尽
    expect(repairPrompts[0]).toContain('<violations>')
    expect(repairPrompts[0]).toContain('express nocturnal mood in nl')
    // 修复产物持续含 verifyTag 拒绝的 neon glow → 机审 critical → 耗尽 → D7 fallback 兜底
    expect(outcome.corrections).toBe(2)
    expect(auditorPrompts.length).toBeGreaterThanOrEqual(2) // A3：auditor 每轮必跑
    expect(writerPrompts.length).toBe(1) // A4：writer 只跑一次，修复不重入 writer
    expect(outcome.advisories).toContain('loop_exhausted:true')
    expect(outcome.fallbackUsed).toBe(true)
  })

  it('auditor needs_revision 持续 → loop_exhausted, ok=true, quality=degraded', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      auditorRunner: async () => NEEDS_AUDITOR,
      repairRunner: async () => VALID_OUT,
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.corrections).toBe(2)
    expect(outcome.advisories).toContain('loop_exhausted:true')
    expect(outcome.ok).toBe(true)
    expect(outcome.quality).toBe('degraded')
    expect(outcome.auditorFeedback[0]).toContain('express nocturnal mood')
  })

  it('A1/A6：writer 解析失败 → fallback 直查字典，positive 无碎片倾泻', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => 'not json at all',
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.fallbackUsed).toBe(true)
    expect(outcome.ok).toBe(true)
    expect(outcome.quality).toBe('fallback')
    expect(outcome.advisories.some((a) => a.startsWith('writer_parse_failed'))).toBe(true)
    expect(outcome.positive).not.toContain('tall mature woman in') // 碎片倾泻不复存在
  })

  it('无 auditorRunner（judge_mode=off 语义）→ 仅机器门，auditor 缺席', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.auditor).toBeUndefined()
    expect(outcome.auditorFeedback).toEqual([])
  })

  it('auditor 故障 → auditor_skipped 降级，机器门独立成立', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => VALID_OUT,
      auditorRunner: async () => { throw new Error('llm down') },
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.advisories.some((a) => a.startsWith('auditor_skipped'))).toBe(true)
    expect(outcome.ok).toBe(true)
  })

  it('无 repairRunner 且机审 critical → repair_unavailable + loop_exhausted + D7 fallback', async () => {
    const outcome = await orchestrateCompositing(V0, 'safe', {
      enrichRunner: async () => ENRICH_PATCH,
      writerRunner: async () => JSON.stringify({ tags: [{ text: 'neon glow', source_concept: 'S1.pose' }], nl: 'She stands alone.', negative: [] }),
      verifyTag: (tag) => tag !== 'neon glow',
      search: SEARCH,
    }, { minTags: 0 })
    expect(outcome.advisories).toContain('repair_unavailable:no_runner')
    expect(outcome.advisories).toContain('loop_exhausted:true')
    expect(outcome.fallbackUsed).toBe(true)
    expect(outcome.ok).toBe(true)
  })
})
