import { describe, expect, it } from 'vitest'
import { registerReverseTool } from '../../src/tools/prompt-reverse.js'
import { stubCtx, textStream, errorStream, runTool, stubExec } from './helpers.js'

const cfg = { temperature: 0.7 }
const def = (ctx: any) => registerReverseTool(ctx, cfg)

describe('prompt_reverse', () => {
  it('requires an image description or session image', async () => {
    const ctx = stubCtx()
    await expect(runTool(ctx, def(ctx), {})).rejects.toThrow(/image/)
  })

  it('reverses with all options (en/long/anima3/quality)', async () => {
    const ctx = stubCtx({ stream: textStream('caption') })
    const v = await runTool(ctx, def(ctx), { image_description: 'a cat photo', output_lang: 'en', length: 'long', anima3_enhance: true, quality_prompt_enabled: true })
    expect(ctx.llm.calls.length).toBe(1)
    expect(ctx.llm.calls[0].maxTokens).toBe(512)
    expect(String(v)).toBe('caption')
  })

  it('passes system prompt with resolved profile', async () => {
    const ctx = stubCtx()
    await runTool(ctx, def(ctx), { image_description: 'cat' })
    expect(ctx.llm.calls[0].system).toBeTruthy()
  })

  it('propagates upstream stream errors', async () => {
    const ctx = stubCtx({ stream: errorStream('upstream down') })
    await expect(runTool(ctx, def(ctx), { image_description: 'cat' })).rejects.toThrow('upstream down')
  })

  it('dry_run skips llm', async () => {
    const ctx = stubCtx()
    const v = await runTool(ctx, def(ctx), { image_description: 'a cat photo', dry_run: true })
    expect(ctx.llm.calls.length).toBe(0)
    expect(String(v)).toContain('debug')
  })

  it('embeds original description in message and returns generated text', async () => {
    const ctx = stubCtx({ stream: textStream('gen') })
    const v = await runTool(ctx, def(ctx), { image_description: 'a cat sits' })
    const serialized = JSON.stringify(ctx.llm.calls[0].messages)
    expect(serialized).toContain('a cat sits') // 输入嵌入 message（[画面描述] 段）
    expect(String(v)).toBe('gen') // 生成文本为工具返回值
  })

  it('media_target anima passes through', async () => {
    const ctx = stubCtx({ stream: textStream('x') })
    await runTool(ctx, def(ctx), { image_description: 'cat', media_target: 'anima' })
    expect(ctx.llm.calls.length).toBe(1)
  })

  it('session image events used in R1 route path', async () => {
    const ctx = stubCtx({ stream: textStream('cap') })
    const events = [{ type: 'image' as const, image: 'data:image/png;base64,AAAA' }]
    await runTool(ctx, def(ctx), { image_description: 'cat desc' }, stubExec({ events, options: { provider: 'p', model: 'm' } }))
    expect(ctx.llm.calls.length).toBe(1)
  })
})