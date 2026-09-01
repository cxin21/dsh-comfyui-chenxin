import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { registerMinimaxTool } from '../../src/tools/minimax-scenario.js'
import { stubCtx, runTool, type StubContext } from './helpers.js'

const cfg = { temperature: 0.7 }
const def = (ctx: any) => registerMinimaxTool(ctx, cfg)

/** 半截六段输出：只有 subject_definitions / summary / detailed_description 三段 */
const PART1 =
  'subject_definitions: <Subject 1> is Alice from <Picture 1>.\n' +
  'summary: [reference generation] Alice appears in a 10-second, 2-shot video with synchronized audio.\n' +
  'detailed_description: [Shot 1] Alice walks through the garden.'
/** 续写返回的余下三段 */
const PART2 =
  'retention_analysis: <Subject 1> from <Picture 1> remains fully_preserved: identity, face, outfit, and styling unchanged.\n' +
  'overall_soundscape: gentle wind; birdsong\n' +
  'non_diegetic_music: soft piano'

const SIX_LABELS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
]

function streamWith(text: string, finishKind: 'stop' | 'max-tokens'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: finishKind } },
  ]
}

/** 顺序 mock：每次 ctx.llm.stream 调用从队列取下一段 chunk 流（复用 stubCtx 的 calls 记录） */
function seqCtx(streams: StreamChunk[][]): StubContext {
  const ctx = stubCtx()
  const calls = ctx.llm.calls
  ctx.llm.stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls.push(options)
    for (const chunk of streams.shift() ?? []) yield chunk
  }
  return ctx
}

describe('minimax_scenario continue (contract-declared)', () => {
  it('truncated six-section output → continues once, merged prompt has all six sections', async () => {
    const ctx = seqCtx([streamWith(PART1, 'max-tokens'), streamWith(PART2, 'stop')])
    const v = JSON.parse(
      String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })),
    )
    // 合并后六段齐全
    for (const label of SIX_LABELS) expect(String(v.prompt)).toContain(label)
    // 续写确实发生：llm 调用 ≥ 2（首轮 + 1 轮续写）
    expect(ctx.llm.calls.length).toBeGreaterThanOrEqual(2)
    // zh 续写提示词正确渲染：已写出 / 缺失内容 + 累积文本
    const contMsg = (ctx.llm.calls[1].messages[0] as { content: { type: string; text: string }[] }).content[0].text
    expect(contMsg).toContain('已写出')
    expect(contMsg).toContain('缺失内容')
    expect(contMsg).toContain('field:retention_analysis')
    expect(contMsg).toContain(PART1)
  })

  it('complete output with stop finish → no continuation round', async () => {
    const full = SIX_LABELS.map((l) => `${l}: content-${l}`).join('\n')
    const ctx = seqCtx([streamWith(full, 'stop')])
    const v = JSON.parse(
      String(await runTool(ctx, def(ctx), { scenario_id: 'full_reference', form_fields: { subject: 'cat' } })),
    )
    expect(String(v.prompt)).toContain('non_diegetic_music: content-non_diegetic_music')
    expect(ctx.llm.calls.length).toBe(1)
  })
})
