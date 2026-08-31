import { describe, expect, it } from 'vitest'
import { registerReverseTool } from '../../src/tools/prompt-reverse.js'
import { stubCtx, textStream, runTool, stubExec } from './helpers.js'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

const imageBlock: ImageBlock = { type: 'image', attachment: { kind: 'file', id: 'att-1' } as any }

function sessionEvents(image?: ImageBlock): unknown[] {
  return [{ type: 'user/message' as const, data: { role: 'user', content: image ? [image] : [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, id: 'm1' } }]
}

describe('prompt_reverse (image path)', () => {
  it('uses the latest session image block when text is absent', async () => {
    const ctx = stubCtx({ stream: textStream('caption from image') })
    ctx.llm = { ...ctx.llm, resolveModelInfo: async () => ({ provider: 'deepseek', model: 'm', inputModalities: ['text', 'image'] }) } as any
    const def = registerReverseTool(ctx as any, { temperature: 0.7 })
    const v = await runTool(ctx, def, {}, stubExec({ events: sessionEvents(imageBlock), options: { provider: 'deepseek', model: 'm' } }))
    expect(ctx.llm.calls.length).toBe(1)
    expect(ctx.llm.calls[0].messages[0].content).toContainEqual(imageBlock)
    expect(String(v)).toBe('caption from image')
  })

  it('rejects with guidance when the current model has no image modality', async () => {
    const ctx = stubCtx({ stream: textStream('x') })
    ctx.llm = { ...ctx.llm, resolveModelInfo: async () => ({ provider: 'deepseek', model: 'chat', inputModalities: ['text'] }) } as any
    const def = registerReverseTool(ctx as any, { temperature: 0.7 })
    await expect(runTool(ctx, def, {}, stubExec({ events: sessionEvents(imageBlock), options: { provider: 'deepseek', model: 'chat' } }))).rejects.toThrow(/Settings→Models|支持图片输入/)
  })
})