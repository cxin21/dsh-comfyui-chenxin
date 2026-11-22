/**
 * LLM 工作流引擎（2026-11-22）——节点的执行纪律。
 *
 * 引擎只做四件事：
 *   1. 按节点策略解析执行器（direct / subagent / subagent-v2）；
 *   2. 跑节点（角色调用或任意节点体）；
 *   3. 失败分类 + 有限重试（取消不重试）；
 *   4. 记逐节点 trace（id / role / executor / ok / ms / attempts / error）。
 *
 * 它**不**吞掉控制流：修复轮、审计门、预算台账仍由编排器决定。
 * 「流程的形状」是业务语义，引擎只管「每个角色怎么被执行」。
 */
import type { Context } from '@deepseek-ai/cordis';
import { resolveTransport, type TransportKind } from '../llm/transport.js';
import type {
  RoleRunner,
  WorkflowExecutor,
  WorkflowNodeError,
  WorkflowNodeOutcome,
  WorkflowNodeResult,
  WorkflowNodeSpec,
  WorkflowTrace,
} from './types.js';

export interface WorkflowEngineOptions {
  ctx: Context;
  /** direct 路径的模型路由（惰性解析） */
  resolveRoute?: () => { provider: string; model: string };
  /** 团队执行器需要的 parent Agent（live runtime instance） */
  parent?: unknown;
  signal?: AbortSignal;
  /** 缺省执行器策略；缺省 = auto（跟随 PM_TRANSPORT / 能力探测） */
  defaultExecutor?: WorkflowExecutor;
}

function classify(err: unknown, aborted: boolean): WorkflowNodeError {
  const message = err instanceof Error ? err.message : String(err);
  if (aborted || /cancel|abort/i.test(message)) {
    return { code: 'cancelled', message };
  }
  return { code: 'llm_failed', message };
}

export class WorkflowEngine {
  private readonly nodes: WorkflowNodeOutcome[] = [];

  constructor(private readonly opts: WorkflowEngineOptions) {}

  /** 逐节点 trace（只读） */
  get trace(): readonly WorkflowNodeOutcome[] {
    return this.nodes;
  }

  snapshot(): WorkflowTrace {
    const totalMs = this.nodes.reduce((sum, n) => sum + n.ms, 0);
    return { nodes: [...this.nodes], totalMs };
  }

  /**
   * 角色节点：taskText → assistant 文本。
   * 失败时**抛出**（编排器既有的错误处理语义不变），但 trace 一定留下。
   */
  async runRole(spec: WorkflowNodeSpec, taskText: string): Promise<string> {
    const result = await this.run(spec, async ({ runner }) => {
      if (!runner) throw new Error('角色节点没有可用执行器');
      return runner(taskText);
    });
    if (!result.ok) {
      const err = result.error ?? { code: 'unknown', message: '角色节点失败' };
      throw new Error(err.message);
    }
    return result.value as string;
  }

  /**
   * 通用节点体。节点体拿到的 runner 是按本节点策略解析出来的
   * （策略='auto' 时跟随引擎默认；指定 'direct'/'subagent'/'subagent-v2' 时优先该执行器）。
   */
  async run<T>(
    spec: WorkflowNodeSpec,
    fn: (ctx: { runner?: RoleRunner; executor: TransportKind | 'none' }) => Promise<T>,
  ): Promise<WorkflowNodeResult<T>> {
    const started = Date.now();
    const maxAttempts = Math.max(1, (spec.maxAttempts ?? 0) + 1);
    let attempts = 0;
    let lastError: WorkflowNodeError | undefined;
    let executor: TransportKind | 'none' = 'none';

    while (attempts < maxAttempts) {
      attempts += 1;
      const resolved = this.resolveRunner(spec);
      executor = resolved?.executor ?? 'none';
      if (!resolved) {
        lastError = {
          code: 'transport_unavailable',
          message: `节点 ${spec.id}（角色 ${spec.role}）没有可用执行器：ctx.llm.stream 与 ctx.subagents 均不可用`,
        };
        break;
      }
      try {
        const value = await fn({ runner: resolved.runner, executor: resolved.executor });
        const outcome: WorkflowNodeOutcome = {
          id: spec.id,
          role: spec.role,
          executor: resolved.executor,
          ok: true,
          ms: Date.now() - started,
          attempts,
        };
        this.nodes.push(outcome);
        return { ok: true, value, outcome };
      } catch (err) {
        const aborted = this.opts.signal?.aborted === true;
        lastError = classify(err, aborted);
        if (aborted || attempts >= maxAttempts) break;
      }
    }

    const outcome: WorkflowNodeOutcome = {
      id: spec.id,
      role: spec.role,
      executor,
      ok: false,
      ms: Date.now() - started,
      attempts,
      ...(lastError ? { error: lastError } : {}),
    };
    this.nodes.push(outcome);
    return { ok: false, error: lastError, outcome };
  }

  /**
   * 某节点策略下是否至少有一条可用执行器。
   * 调用方用它保持既有的「runner 缺失 → 管线按 fail-open 降级」语义：
   * 不可用时返回 undefined runner，而不是在第一次调用时才炸。
   */
  hasExecutor(spec?: WorkflowNodeSpec): boolean {
    return this.resolveRunner(spec ?? { id: 'probe', role: 'probe' }) !== undefined;
  }

  private resolveRunner(spec: WorkflowNodeSpec): { runner: RoleRunner; executor: TransportKind } | undefined {
    const prefer = spec.executor && spec.executor !== 'auto' ? spec.executor : this.opts.defaultExecutor;
    const transport = resolveTransport(this.opts.ctx, {
      resolveRoute: this.opts.resolveRoute,
      parent: this.opts.parent,
      signal: this.opts.signal,
      labelPrefix: spec.labelPrefix,
      prefer: prefer && prefer !== 'auto' ? prefer : undefined,
    });
    if (!transport) return undefined;
    return { runner: (taskText: string) => transport.run(taskText), executor: transport.kind };
  }
}
