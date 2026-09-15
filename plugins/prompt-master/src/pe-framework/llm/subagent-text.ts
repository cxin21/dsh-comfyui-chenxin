/**
 * 共享子代理文本工厂（2026-09-15「全部 LLM 调用改子代理」用户定案）：
 * 管线内嵌套 LLM 调用（扩写 enrichBlueprint / 增量蓝图 analyzeBlueprintIncremental 等）
 * 统一经 ctx.subagents.start 以子代理形态执行——与 intent（subagentIntent）/judge
 * （createSubagentCriticProvider）同款三方可见。一次 one-shot 纯生成：
 * 架构级禁工具（toolFilter allow:[]）、parent 线穿、超时 AbortController——
 * 模式对齐 eval/critic.ts createSubagentCriticProvider（2026-09-12 P0 先例）。
 */
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '../intent/subagent-provider.js'

export type SubagentTextRunner = (taskText: string) => Promise<string>

export function createSubagentTextRunner(
  ownerCtx: any,
  opts?: { labelPrefix?: string; timeoutMs?: number; parent?: unknown },
): SubagentTextRunner {
  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '')
  const timeoutMs = opts?.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_SUBAGENT_TIMEOUT_MS)
  const labelPrefix = opts?.labelPrefix ?? 'pm-text'

  return async function subagentTextRun(taskText: string): Promise<string> {
    if (!ownerCtx?.subagents?.start) {
      throw new Error('SubagentTextRunner 不可用：ctx.subagents 未注册（plugin 未注入 "subagents"）')
    }
    // parent 线穿（2026-09-12 P0 同款）：host 装配子代理时读取 parent.options，缺 parent 直接
    // TypeError（Cannot read properties of undefined (reading 'options')）→ 全量静默 skipped。
    const parent = opts?.parent ?? ownerCtx?.agent
    if (!parent) {
      throw new Error('SubagentTextRunner 需要调用 Agent 上下文（opts.parent / ownerCtx.agent 均不可用）：请从 Agent 会话内调用')
    }
    const controller = new AbortController()
    const timeoutError = new Error(`SubagentTextRunner 超时：未在 ${timeoutMs}ms 内收到结果`)
    let timer: ReturnType<typeof setTimeout> | undefined

    let run: { result: Promise<{ stopReason?: string; diagnostic?: unknown; output?: Array<{ type?: string; text?: string }> }>; dispose: () => Promise<void> | void }
    try {
      run = await ownerCtx.subagents.start('spawn', {
        label: `${labelPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: [{ type: 'text', text: taskText }],
        parent,
        toolFilter: { allow: [] },
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
        throw new Error(`SubagentTextRunner 子代理未完成：stopReason=${result.stopReason}${detail}`)
      }
      const text = (result.output ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text.trim().length === 0) {
        throw new Error('SubagentTextRunner 子代理未产出 assistant 文本')
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
