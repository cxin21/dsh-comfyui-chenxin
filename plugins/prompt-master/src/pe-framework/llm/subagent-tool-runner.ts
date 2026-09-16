/**
 * 子代理工具工厂（spec 2026-09-17 agentic-pipeline-redesign §2，A2）：
 * 成文/审计/修复三个 LLM 经 ctx.subagents.start 执行并**开放 catalog_search 工具**——
 * 与 createSubagentTextRunner 同构（parent 线穿、超时 AbortController），唯一差异是
 * toolFilter 从 `{ allow: [] }`（架构级禁工具）改为 allow 清单。
 * 降级语义：子代理环境工具不可用时不阻塞管线——writer 产出未验证 tag 由机审
 * fabricated_tag 兜底拦截进修复；auditor 凭语义审计降级（advisory 留痕）。
 */
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '../intent/subagent-provider.js'

export type SubagentToolRunner = (taskText: string) => Promise<string>

/** 允许子代理调用的工具清单（管线三 LLM 均只开放 tag 字典查询） */
export const PIPELINE_TOOL_ALLOW = ['catalog_search'] as const

export function createSubagentToolRunner(
  ownerCtx: any,
  opts?: { labelPrefix?: string; timeoutMs?: number; parent?: unknown; allow?: readonly string[] },
): SubagentToolRunner {
  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '')
  const timeoutMs = opts?.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_SUBAGENT_TIMEOUT_MS)
  const labelPrefix = opts?.labelPrefix ?? 'pm-tool'
  const allow = opts?.allow ?? PIPELINE_TOOL_ALLOW

  return async function subagentToolRun(taskText: string): Promise<string> {
    if (!ownerCtx?.subagents?.start) {
      throw new Error('SubagentToolRunner 不可用：ctx.subagents 未注册（plugin 未注入 "subagents"）')
    }
    const parent = opts?.parent ?? ownerCtx?.agent
    if (!parent) {
      throw new Error('SubagentToolRunner 需要调用 Agent 上下文（opts.parent / ownerCtx.agent 均不可用）')
    }
    const controller = new AbortController()
    const timeoutError = new Error(`SubagentToolRunner 超时：未在 ${timeoutMs}ms 内收到结果`)
    let timer: ReturnType<typeof setTimeout> | undefined

    let run: { result: Promise<{ stopReason?: string; diagnostic?: unknown; output?: Array<{ type?: string; text?: string }> }>; dispose: () => Promise<void> | void }
    try {
      run = await ownerCtx.subagents.start('spawn', {
        label: `${labelPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: [{ type: 'text', text: taskText }],
        parent,
        toolFilter: { allow: [...allow] },
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError
      throw error
    }

    try {
      const result = await Promise.race([
        run.result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(timeoutError)
            reject(timeoutError)
          }, timeoutMs)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (result.stopReason !== 'completed') {
        const detail = result.diagnostic === undefined ? '' : `；diagnostic: ${result.diagnostic}`
        throw new Error(`SubagentToolRunner 子代理未完成：stopReason=${result.stopReason}${detail}`)
      }
      const text = (result.output ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text.trim().length === 0) {
        throw new Error('SubagentToolRunner 子代理未产出 assistant 文本')
      }
      return text
    } finally {
      try {
        await run.dispose()
      } catch {
        /* 吞掉 dispose 异常 */
      }
    }
  }
}
