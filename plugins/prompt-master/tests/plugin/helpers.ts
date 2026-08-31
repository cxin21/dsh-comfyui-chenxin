import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'

export function textStream(text: string, usage?: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage ? [{ type: 'usage' as const, usage }] : []),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function errorStream(message: string, code = 'E_TEST'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }]
}

export function abortedStream(message: string, code = 'E_TEST'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'aborted', failure: { message, code } } }]
}

export interface ToolDefLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render: (args: unknown, value: JsonValue) => unknown[] }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

export interface StubContext {
  tools: { registered: ToolDefLike[]; register(def: ToolDefLike): () => void }
  llm: { calls: GenerateOptions[]; stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
  settings?: { get(): Record<string, string>; update(p: object): Promise<void>; replace(s: object): Promise<void> }
  effect(): void
}

export function stubCtx(opts: { stream?: StreamChunk[]; settings?: StubContext['settings'] } = {}): StubContext {
  const calls: GenerateOptions[] = []
  const llm = {
    calls,
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      for (const chunk of opts.stream ?? textStream('ok')) yield chunk
    },
  }
  const ctx: StubContext = {
    tools: { registered: [], register(def) { this.registered.push(def); return () => {} } },
    llm,
    settings: opts.settings,
    effect() {},
  }
  return ctx
}

export interface ExecOverrides {
  events?: unknown[]
  options?: { provider?: string; model?: string }
}

export function stubExec(overrides: ExecOverrides = {}) {
  return {
    signal: new AbortController().signal,
    agent: {
      session: { events: overrides.events ?? [], requestHeader: () => undefined },
      // R1：agent 模型走 options（默认已配置，模拟 DSH 会话；route/抛错语义由 complete.test 显式 exec 覆盖）
      options: overrides.options ?? { provider: 'p', model: 'm' },
    },
  }
}

export async function runTool(ctx: StubContext, def: ToolDefLike, args: unknown, exec: unknown = stubExec()): Promise<unknown> {
  return def.execute(args, exec)
}