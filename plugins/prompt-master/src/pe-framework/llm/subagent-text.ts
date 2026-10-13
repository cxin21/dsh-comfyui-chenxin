import { SubagentHostCtx } from './host-ctx.js'
/**
 * 共享子代理文本工厂（2026-09-15「全部 LLM 调用改子代理」用户定案）：
 * 管线内嵌套 LLM 调用（扩写 enrichBlueprint / 增量蓝图 analyzeBlueprintIncremental 等）
 * 统一经 ctx.subagents.start 以子代理形态执行——与 intent（subagentIntent）/judge
 * （createSubagentCriticProvider）同款三方可见。一次 one-shot 纯生成：
 * 架构级禁工具（toolFilter allow:[]）、parent 线穿、超时 AbortController——
 * 模式对齐 eval/critic.ts createSubagentCriticProvider（2026-09-12 P0 先例）。
 *
 * #16 T-01：新增可选外部取消信号（opts.signal）——与内部超时做 OR 合并（cancel.ts）：
 * 预中止快速失败（不发起 start）；进行中 abort 联动内部 controller 并以 CallerCancelledError
 * 结算；不传 signal 行为与历史版本完全一致。
 */
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '../intent/subagent-provider.js';
import { bindExternalAbort, CallerCancelledError } from './cancel.js';

export type SubagentTextRunner = (taskText: string) => Promise<string>;

export function createSubagentTextRunner(
  ownerCtx: SubagentHostCtx,
  opts?: { labelPrefix?: string; timeoutMs?: number; parent?: unknown; signal?: AbortSignal },
): SubagentTextRunner {
  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '');
  const timeoutMs =
    opts?.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_SUBAGENT_TIMEOUT_MS);
  const labelPrefix = opts?.labelPrefix ?? 'pm-text';

  return async function subagentTextRun(taskText: string): Promise<string> {
    if (!ownerCtx?.subagents?.start) {
      throw new Error('SubagentTextRunner 不可用：ctx.subagents 未注册（plugin 未注入 "subagents"）');
    }
    // parent 线穿（2026-09-12 P0 同款）：host 装配子代理时读取 parent.options，缺 parent 直接
    // TypeError（Cannot read properties of undefined (reading 'options')）→ 全量静默 skipped。
    const parent = opts?.parent ?? ownerCtx?.agent;
    if (!parent) {
      throw new Error(
        'SubagentTextRunner 需要调用 Agent 上下文（opts.parent / ownerCtx.agent 均不可用）：请从 Agent 会话内调用',
      );
    }
    if (opts?.signal?.aborted) throw new CallerCancelledError('SubagentTextRunner');
    const controller = new AbortController();
    const extAbort = bindExternalAbort(controller, opts?.signal, 'SubagentTextRunner');
    const timeoutError = new Error(`SubagentTextRunner 超时：未在 ${timeoutMs}ms 内收到结果`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    let run: {
      result: Promise<{ stopReason?: string; diagnostic?: unknown; output?: Array<{ type?: string; text?: string }> }>;
      dispose: () => Promise<void> | void;
    };
    try {
      try {
        run = await ownerCtx.subagents.start('spawn', {
          label: `${labelPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          prompt: [{ type: 'text', text: taskText }],
          parent,
          toolFilter: { allow: [] },
          signal: controller.signal,
        });
      } catch (error) {
        // 取消与超时区分：外部 signal 已中止 → 取消错误（可机检）；仅内部超时 → 维持超时语义
        if (opts?.signal?.aborted) throw new CallerCancelledError('SubagentTextRunner');
        if (controller.signal.aborted) throw timeoutError;
        throw error;
      }

      try {
        const result = await Promise.race([
          run.result,
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
        if (result.stopReason !== 'completed') {
          const detail = result.diagnostic === undefined ? '' : `；diagnostic: ${result.diagnostic}`;
          throw new Error(`SubagentTextRunner 子代理未完成：stopReason=${result.stopReason}${detail}`);
        }
        const text = (result.output ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        if (text.trim().length === 0) {
          throw new Error('SubagentTextRunner 子代理未产出 assistant 文本');
        }
        return text;
      } finally {
        try {
          // #16 P2-6（对抗审查）：dispose 有界等待——host 对已中止子代理的 dispose 若挂起，
          // 不得阻塞外层 finally 的监听器清理（否则 exec.signal 监听按调用累积）。
          await Promise.race([
            run.dispose(),
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
      extAbort.cleanup(); // 移除外部 signal 监听，防跨调用泄漏
    }
  };
}
