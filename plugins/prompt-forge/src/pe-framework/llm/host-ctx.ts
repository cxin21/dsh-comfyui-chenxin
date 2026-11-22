/**
 * Host 上下文最小接口（audit F9 收口：此前 4 处 `ownerCtx: any`）。
 * 只声明插件实际消费的面（subagents.start + agent 引用）——DSH host 真实类型未公开，
 * 结构化子集（structural typing）即可通过；新增消费面时在此扩展，禁止回退 any。
 */
export interface SubagentHostCtx {
  agent?: unknown
  subagents?: {
    /** 方法签名（非箭头属性）：参数双变，允许调用方/测试传入更窄的 opts 形状 */
    start(
      kind: string,
      opts: Record<string, unknown>,
    ): Promise<{
      id?: string
      result: Promise<{
        stopReason?: string
        diagnostic?: unknown
        output?: Array<{ type?: string; text?: string }>
      }>
      dispose: () => Promise<void> | void
    }>
  }
}
