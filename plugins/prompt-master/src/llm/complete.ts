import { BlockAssembler, createUserMessage, type FinishReason, type TokenUsage, type GenerateOptions, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

export interface CompleteOptions {
  provider: string
  model: string
  system: string
  user: string
  /** M5-DIAG2（用户裁定 2026-09-14）：缺省不设上限——reasoning 模型思考预算不可预支，省略即宿主 defaultMaxTokens 语义 */
  maxTokens?: number
  temperature?: number
  signal: AbortSignal
}

export interface CompleteWithBlocksOptions extends Omit<CompleteOptions, 'user'> {
  blocks: ContentBlock[]
}

async function runStream(ctx: Context, opts: { provider: string; model: string; system?: string; content: ContentBlock[]; maxTokens?: number; temperature?: number; signal: AbortSignal }) {
  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({
    provider: opts.provider,
    model: opts.model,
    system: opts.system,
    messages: [createUserMessage({ content: opts.content, source: { kind: 'plugin', plugin: 'prompt-master' } })],
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
  } satisfies GenerateOptions)
  for await (const chunk of stream) assembler.push(chunk)
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    const failure = assembler.finish.failure
    const err = new Error(failure.message) as Error & { code?: string }
    err.code = failure.code
    throw err
  }
  const text = assembler.blocks()
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    // M5-DIAG2 续：适配器可能产出 text 块但 text 字段 undefined（流首 delta.content 空场景）——
    // 防御性空串合并（真实会话 trim 崩溃点，aecb720 后 text 流首次到达时暴露）
    .map((b) => (b.text ?? '').trim()).join('\n')
  return { text, usage: assembler.usage, finish: assembler.finish }
}

export async function complete(ctx: Context, opts: CompleteOptions): Promise<{ text: string; usage?: TokenUsage; finish: FinishReason }> {
  return runStream(ctx, { ...opts, content: [{ type: 'text', text: opts.user }] })
}

export async function completeWithBlocks(ctx: Context, opts: CompleteWithBlocksOptions): Promise<{ text: string; usage?: TokenUsage; finish: FinishReason }> {
  return runStream(ctx, { ...opts, content: opts.blocks })
}