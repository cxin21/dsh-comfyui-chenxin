/**
 * LLM transport（2026-11-22）——把「一次 one-shot LLM 调用」从 host seam 里抽出来，做成插件自己的抽象。
 *
 * ## 为什么要有这一层（第一性原理）
 * 插件此前把**整条** LLM 编排能力押在 `ctx.subagents.start` 这一个 host seam 上：
 * intent 拆解、批判评审、成文/审计/修复、H3 五槽位导演，全部走「一次性 spawn 子代理」。
 * host 0.2.2-rc.5 把这个 seam 改名改形了（`start` → `startActivation(spec)`，且 spec 要求
 * `parent: Agent` 真实运行时实例、参数形状完全不同），插件在 apply 期硬接线它 →
 * 直接抛错 → fiber rejected → **14 个 prompt-forge 工具全灭**（预设显示正常、其它插件正常，
 * 只有 prompt-forge 静默失能）。
 *
 * 正确的修法不是给每个调用点打补丁，而是把「调用 LLM」这件事从 seam 中抽出来：
 *   - core（intent/critic 的 persona/taskText/parse）——与 transport 无关的纯逻辑；
 *   - transport ——「把一段 taskText 变成一段 assistant 文本」的两个实现。
 * 两条 transport 拿到**同一份 taskText**，行为等价由结构保证。
 *
 * ## 两个实现
 * - **direct**：`ctx.llm.stream` 直连。依赖面只有 LLM 服务本身，不随 host 的 subagent API 变形而失效。
 *   用户裁定「不通过调用 subagents 的方式」→ 默认走这条。
 * - **subagent**：`ctx.subagents.start` 一次性 spawn（保留旧行为，供回退与老 host）。
 *
 * ## 开关
 * `PM_TRANSPORT=direct|subagent`
 *   - `direct`（默认）：优先 direct，direct 不可用时回退 subagent。
 *   - `subagent`：优先 subagent（等价于旧行为），subagent 不可用时回退 direct。
 */
import type { Context } from '@deepseek-ai/cordis';
import { completeTaskText } from '../../llm/complete.js';
import { createSubagentTextRunner } from './subagent-text.js';

export type TransportKind = 'direct' | 'subagent';

export interface TransportOptions {
  /**
   * direct 路径的模型路由解析器（**惰性**——只在真的要发 LLM 请求时才解析，
   * 避免在不需要 LLM 的分支上提前抛「无法解析模型路由」）。
   */
  resolveRoute?: () => { provider: string; model: string };
  /** subagent 路径的 parent Agent（direct 路径忽略） */
  parent?: unknown;
  /** subagent 路径的 child label 前缀 */
  labelPrefix?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LlmTransport {
  readonly kind: TransportKind;
  /** 一次 one-shot 结构化产出：taskText → assistant 文本 */
  run(taskText: string): Promise<string>;
}

/** host 是否提供 subagents.start（旧 seam） */
export function hasSubagentSeam(ctx: unknown): boolean {
  return typeof (ctx as { subagents?: { start?: unknown } | undefined })?.subagents?.start === 'function';
}

/** host 是否提供 ctx.llm.stream（direct 路径依赖） */
export function hasLlmSeam(ctx: unknown): boolean {
  return typeof (ctx as { llm?: { stream?: unknown } | undefined })?.llm?.stream === 'function';
}

/**
 * direct transport：ctx.llm.stream 直连，taskText 逐字作为唯一一条 user 消息送出。
 * 与 subagent transport 的 prompt 形状一致（见 completeTaskText 注释）。
 */
export function createDirectTransport(ctx: Context, opts: TransportOptions = {}): LlmTransport | undefined {
  if (!hasLlmSeam(ctx)) return undefined;
  return {
    kind: 'direct',
    async run(taskText: string): Promise<string> {
      const route = opts.resolveRoute?.();
      if (!route) {
        throw new Error(
          'direct transport 无法解析模型路由：请先在当前会话选择 provider/model（Settings→Models）。插件不内置默认模型，完全跟随会话路由。',
        );
      }
      const { text } = await completeTaskText(ctx, {
        provider: route.provider,
        model: route.model,
        taskText,
        signal: opts.signal ?? new AbortController().signal,
      });
      if (!text.trim()) throw new Error('direct transport 未产出 assistant 文本');
      return text;
    },
  };
}

/**
 * subagent transport：包装既有的 createSubagentTextRunner（one-shot spawn，架构级禁工具）。
 * 保留旧行为，供 PM_TRANSPORT=subagent 回退与老 host 使用。
 */
export function createSubagentTransport(ctx: Context, opts: TransportOptions = {}): LlmTransport | undefined {
  if (!hasSubagentSeam(ctx)) return undefined;
  const parent = opts.parent ?? (ctx as { agent?: unknown } | undefined)?.agent;
  if (!parent) return undefined;
  const runner = createSubagentTextRunner(ctx as never, {
    labelPrefix: opts.labelPrefix,
    parent,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  return {
    kind: 'subagent',
    run: (taskText: string) => runner(taskText),
  };
}

/**
 * 按能力 + 开关选一条 transport。
 * 返回 undefined = 两条路都不可用（调用方应 fail-open 或给出可观测错误，不得静默出空稿）。
 */
export function resolveTransport(ctx: Context, opts: TransportOptions = {}): LlmTransport | undefined {
  const mode = (process.env.PM_TRANSPORT ?? 'direct').trim().toLowerCase();
  const order: TransportKind[] = mode === 'subagent' ? ['subagent', 'direct'] : ['direct', 'subagent'];
  for (const kind of order) {
    const transport = kind === 'direct' ? createDirectTransport(ctx, opts) : createSubagentTransport(ctx, opts);
    if (transport) return transport;
  }
  return undefined;
}

/**
 * runner 形态便捷封装：返回 `(taskText) => Promise<string>` 或 undefined。
 * 与既有 createSubagentTextRunner / createSubagentToolRunner 的签名同型，
 * 所以 compositing/directing 编排器的 deps 不用改。
 */
export function createTransportRunner(
  ctx: Context,
  opts: TransportOptions = {},
): ((taskText: string) => Promise<string>) | undefined {
  const transport = resolveTransport(ctx, opts);
  if (!transport) return undefined;
  return (taskText: string) => transport.run(taskText);
}
