/**
 * 模型路由（R1 修复：零 provider 配置，完全跟随 DSH 会话）。
 * 三环语义（按用户新裁决修订 spec §5.1）：①当前会话 route（requestHeader().config）→ ②当前 agent 模型（agent.options）
 * → ③无任何信息 → 报可操作错误（不硬编码默认、不回落插件 Config）。
 */
export interface ExecLike {
  agent?: { session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }; options?: { provider?: string; model?: string } }
  signal: AbortSignal
}

export function resolveRoute(exec: ExecLike): { provider: string; model: string } {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model }
  const opts = exec.agent?.options
  if (opts?.provider && opts?.model) return { provider: opts.provider, model: opts.model }
  throw new Error('无法解析模型路由：请先在当前会话选择 provider/model（Settings→Models）。插件不内置默认模型，完全跟随会话路由。')
}