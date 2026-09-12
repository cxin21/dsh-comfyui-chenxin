/**
 * A6（外部基准 2026-09）：design_notes 设计说明投影回归。
 * designNotesOf：segments → 槽位中文标签汇总 / narrative 职责 / 排除项 / catalog 锚定率；
 * assembleEnvelope：observability.designNotes 透传。
 */
import { describe, expect, it } from 'vitest'
import { designNotesOf } from '../../src/tools/prompt-author.js'
import { assembleEnvelope } from '../../src/pe-framework/render/envelope.js'
import type { StageResult } from '../../src/pe-framework/pipeline/types.js'

function stageWith(segments: unknown): StageResult {
  return { ok: true, target: 'anima', result: { positive: 'x', negative: 'y', segments }, advisories: [], gates: [] } as unknown as StageResult
}

describe('designNotesOf', () => {
  it('anima segments → 槽位中文标签汇总（截断 6 个加「等」）', () => {
    const stage = stageWith([
      { text: 'masterpiece', channel: 'positive', origin: 'policy', priority: 100, slot: null, citation: null },
      { text: '1girl', channel: 'positive', origin: 'grounded', priority: 200, slot: 'count_gender', citation: { record_id: 'r1' } },
      { text: 'white hair', channel: 'positive', origin: 'grounded', priority: 300, slot: 'appearance', citation: { record_id: 'r2' } },
      { text: 'silver armor', channel: 'positive', origin: 'user-fuzzy', priority: 350, slot: 'clothing', citation: null },
      { text: 'close-up', channel: 'positive', origin: 'grounded', priority: 500, slot: 'camera', citation: { record_id: 'r3' } },
    ])
    const notes = designNotesOf(stage)
    expect(notes.some((n) => n.startsWith('人数（1）: 1girl'))).toBe(true)
    expect(notes.some((n) => n.startsWith('外观（1）: white hair'))).toBe(true)
    expect(notes.some((n) => n.startsWith('服装（1）: silver armor'))).toBe(true)
    expect(notes.some((n) => n.startsWith('景别（1）: close-up'))).toBe(true)
    expect(notes.some((n) => n.includes('catalog 锚定: 3/4'))).toBe(true)
  })

  it('narrative 与 exclusions 各自成行', () => {
    const stage = stageWith([
      { text: 'A girl stands... cool blue tones dominate.', channel: 'positive', origin: 'narrative', priority: 2000, slot: null, citation: null },
      { text: 'lowres', channel: 'negative', origin: 'exclusion', priority: 900, slot: null, citation: null },
      { text: 'watermark', channel: 'negative', origin: 'exclusion', priority: 901, slot: null, citation: null },
    ])
    const notes = designNotesOf(stage)
    expect(notes.some((n) => n.startsWith('场景叙述（构图/曝光/色彩职责）: A girl stands'))).toBe(true)
    expect(notes.some((n) => n.includes('lowres, watermark'))).toBe(true)
  })

  it('同槽 7 个 tag → 展示前 6 个 + 「等」', () => {
    const segs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t, i) => ({
      text: t, channel: 'positive', origin: 'user-fuzzy', priority: 300 + i, slot: 'scene', citation: null,
    }))
    const notes = designNotesOf(stageWith(segs))
    expect(notes.some((n) => n.startsWith('场景（7）: a / b / c / d / e / f 等'))).toBe(true)
  })

  it('非 anima（无 segments）返回 []', () => {
    expect(designNotesOf({ ok: true, target: 'h3', result: { text: 'x' }, advisories: [], gates: [] } as unknown as StageResult)).toEqual([])
  })
})

describe('assembleEnvelope designNotes passthrough', () => {
  it('observability.designNotes 进入 envelope', () => {
    const stage = stageWith([{ text: '1girl', channel: 'positive', origin: 'grounded', priority: 200, slot: 'count_gender', citation: { record_id: 'r1' } }])
    const env = JSON.parse(assembleEnvelope(stage, [], { designNotes: designNotesOf(stage) }, { generation_id: 'g1' })) as Record<string, any>
    const notes = env.observability?.designNotes as string[]
    expect(Array.isArray(notes)).toBe(true)
    expect(notes.some((n) => n.startsWith('人数（1）: 1girl'))).toBe(true)
  })
})
