/**
 * 新 seam 的子代理执行器（2026-11-22）——host 0.2.2-rc.5 把 `ctx.subagents.start`
 * 改名改形成 `ctx.subagents.startActivation(spec)`。这是「团队形态」的落点：
 * 每个工作流节点 = 一个有名有姓的 teammate（`spec.name`），带自己的角色 prompt、
 * 自己的输出契约（`outputSchema`）、自己的模型路由覆盖（`agentOptions`），
 * 结果按 `delivery: 'caller'` 回给**插件**（而不是塞进父 agent 的一轮对话）。
 *
 * ## 与旧 seam 的差异（迁移时必须知道）
 * | | 旧 `start(provider, req)` | 新 `startActivation(spec)` |
 * |---|---|---|
 * | 必填 | provider + parent + prompt + signal | 同，另加 `delivery` |
 * | parent | 宽松 | **必须是 host 认得的 live Agent 实例**（`ctx.get('agents')?.get(parent.id) === parent`），否则 UNAUTHORIZED |
 * | 工具白名单 | `toolFilter: { allow: [...] }` | **spec 里没有**——子代理的工具集由它自己的 composition/preset 决定 |
 * | 结构化产出 | 无 | `outputSchema`（provider 需 `capabilities.outputSchema`）→ `result.structured` |
 * | 模型/推理覆盖 | 无 | `agentOptions`（provider/model/reasoning-effort/output-token） |
 *
 * 结论：**角色化节点**在新 seam 上比旧 seam 更强（有契约、有独立模型），
 * 但「按调用限制子代理可用工具」这一项**没了**——需要工具时改为
 * 在 prompt 里注入确定性检索结果（catalog 直查），而不是让模型去调工具。
 */
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '../intent/subagent-provider.js';
import { bindExternalAbort, CallerCancelledError } from './cancel.js';

export type SubagentV2TextRunner = (taskText: string) => Promise<string>;

export interface SubagentV2Activation {
  childId?: string;
  name?: string;
  result: Promise<{
    stopReason?: string;
    diagnostic?: unknown;
    output?: Array<{ type?: string; text?: string }>;
    structured?: unknown;
  }>;
  dispose: () => Promise<void> | void;
}

export interface SubagentV2HostCtx {
  subagents?: {
    startActivation(spec: {
      provider: string;
      label: string;
      name?: string;
      prompt: Array<{ type: 'text'; text: string }>;
      parent: unknown;
      signal: AbortSignal;
      delivery: 'parent' | 'caller';
      outputSchema?: unknown;
      agentOptions?: unknown;
    }): Promise<SubagentV2Activation>;
  };
}

/** host 是否提供新 seam */
export function hasSubagentV2Seam(ctx: unknown): boolean {
  return (
    typeof (ctx as { subagents?: { startActivation?: unknown } | undefined })?.subagents?.startActivation ===
    'function'
  );
}

export interface SubagentV2RunnerOptions {
  /** provider 名（host 注册的 backend）：spawn / fork / acp */
  provider?: string;
  /** parent：必须是 host 认得的 live Agent 实例 */
  parent?: unknown;
  signal?: AbortSignal;
  labelPrefix?: string;
  /** teammate 名字（1–32 位小写字母/数字/连字符，不能叫 lead） */
  name?: string;
  timeoutMs?: number;
  /** 节点级输出契约（provider 需 capabilities.outputSchema） */
  outputSchema?: unknown;
  /** 节点级模型路由覆盖 */
  agentOptions?: unknown;
}

export function createSubagentV2Runner(
  ownerCtx: SubagentV2HostCtx,
  opts: SubagentV2RunnerOptions = {},
): SubagentV2TextRunner | undefined {
  if (!hasSubagentV2Seam(ownerCtx)) return undefined;
  const parent = opts.parent ?? (ownerCtx as { agent?: unknown } | undefined)?.agent;
  // 没有 live parent 就没法满足 host 的「exact live parent agent」校验——直接不提供，
  // 让调用方回退到 direct，而不是发起一个注定 UNAUTHORIZED 的请求。
  if (!parent) return undefined;

  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '');
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_SUBAGENT_TIMEOUT_MS);
  const labelPrefix = opts.labelPrefix ?? 'pm-role';
  const provider = opts.provider ?? 'spawn';
  let seq = 0;

  return async function subagentV2Run(taskText: string): Promise<string> {
    if (opts.signal?.aborted) throw new CallerCancelledError('SubagentV2Runner');
    const controller = new AbortController();
    const extAbort = bindExternalAbort(controller, opts.signal, 'SubagentV2Runner');
    const timeoutError = new Error(`SubagentV2Runner 超时：未在 ${timeoutMs}ms 内收到结果`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    let activation: SubagentV2Activation;
    try {
      try {
        activation = await ownerCtx.subagents!.startActivation({
          provider,
          label: `${labelPrefix}-${Date.now()}-${(seq += 1)}`,
          ...(opts.name ? { name: opts.name } : {}),
          prompt: [{ type: 'text', text: taskText }],
          parent,
          signal: controller.signal,
          delivery: 'caller',
          ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema } : {}),
          ...(opts.agentOptions !== undefined ? { agentOptions: opts.agentOptions } : {}),
        });
      } catch (error) {
        if (opts.signal?.aborted) throw new CallerCancelledError('SubagentV2Runner');
        if (controller.signal.aborted) throw timeoutError;
        throw error;
      }

      try {
        const result = await Promise.race([
          activation.result,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort(timeoutError);
              reject(timeoutError);
            }, timeoutMs);
          }),
          extAbort.gate,
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        if (result.stopReason !== undefined && result.stopReason !== 'completed') {
          const detail = result.diagnostic === undefined ? '' : `；diagnostic: ${String(result.diagnostic)}`;
          throw new Error(`SubagentV2Runner 子代理未完成：stopReason=${result.stopReason}${detail}`);
        }
        const text = (result.output ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        if (text.trim().length === 0) {
          throw new Error('SubagentV2Runner 子代理未产出 assistant 文本');
        }
        return text;
      } finally {
        try {
          await Promise.race([
            activation.dispose(),
            new Promise<void>((resolve) => {
              const t: ReturnType<typeof setTimeout> = setTimeout(resolve, 5000);
              (t as unknown as { unref?: () => void }).unref?.();
            }),
          ]);
        } catch {
          /* 吞掉 dispose 异常 */
        }
      }
    } finally {
      extAbort.cleanup();
    }
  };
}
