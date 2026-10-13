/**
 * 取消原语（#16 exec-signal T-01/T-04）：
 *
 * 第一性原理：调用方取消（exec.signal）与内部超时是两个独立的中止源，任一触发
 * 都必须让在途工作尽快结算——即「中止 = 各来源的 OR 合并」。此前每个 runner 各自
 * new 私有 AbortController（只挂超时），调用方取消到不了子代理/LLM；编排层又因
 * D7 fail-open（writer 失败→兜底出稿）会把「取消」误当成「失败换个方式继续」。
 *
 * 本模块提供两件套：
 *  - bindExternalAbort：给 runner 的私有 controller 并上一个外部 signal（监听器一次性，
 *    settle 后 cleanup 防泄漏）
 *  - createCancelGuard：execute 级 race guard——abort 即以 CallerCancelledError 结算，
 *    优先于 fail-open 兜底；错误 name/message 可机检
 *
 * 不变量：不传 signal ⇒ 行为与历史版本完全一致；abort 晚于完成 ⇒ 不产生 unhandled
 * rejection（gate 预挂 no-op catch）。
 */

export class CallerCancelledError extends Error {
  constructor(label: string) {
    super(`[prompt-master] ${label} 已被调用方取消（exec.signal aborted）`);
    this.name = 'CallerCancelledError';
  }
}

interface Gate {
  /** 与任务 race 的拒绝门；abort 触发后以 CallerCancelledError 拒绝 */
  gate: Promise<never>;
  fired(): boolean;
  /** 已触发的取消错误（fired() 为 true 时非空） */
  error(): CallerCancelledError;
  cleanup(): void;
}

function makeGate(signal: AbortSignal | undefined | null, label: string, onAbort?: () => void): Gate {
  let rejectFn: ((e: CallerCancelledError) => void) | undefined;
  let fired: CallerCancelledError | undefined;
  const gate = new Promise<never>((_, reject) => {
    rejectFn = reject;
  });
  gate.catch(() => {}); // 标记已处理：abort 晚于任务完成时不产生 unhandled rejection
  const handler = () => {
    fired = new CallerCancelledError(label);
    try {
      onAbort?.();
    } catch {
      /* onAbort 自身的异常不得吞掉取消结算 */
    }
    rejectFn!(fired);
  };
  if (signal) {
    if (signal.aborted) handler();
    else signal.addEventListener('abort', handler, { once: true });
  }
  return {
    gate,
    fired: () => fired !== undefined,
    error: () => fired!,
    cleanup: () => signal?.removeEventListener('abort', handler),
  };
}

/**
 * runner 层：外部 signal 中止时联动 abort 内部 controller（让 subagents.start 的
 * signal 立即失效）并提供 race 门。调用方在任务 settle 后必须 cleanup()。
 */
export function bindExternalAbort(
  controller: AbortController,
  external: AbortSignal | undefined | null,
  label: string,
): Gate {
  return makeGate(external, label, () => controller.abort(new CallerCancelledError(label)));
}

export interface CancelGuard {
  /** race(task)：任务与取消门赛跑，abort 先到则以 CallerCancelledError 拒绝 */
  race<T>(task: Promise<T>): Promise<T>;
  /** 同步检查：已取消则立即抛 CallerCancelledError */
  throwIfCancelled(): void;
  /** 移除 signal 监听（execute 收口时调用，防跨调用泄漏） */
  dispose(): void;
}

/** execute 级 guard：整条工具调用的取消结算。signal 缺省时为恒等直通。 */
export function createCancelGuard(signal: AbortSignal | undefined | null, label: string): CancelGuard {
  const g = makeGate(signal, label);
  return {
    // 预中止场景必须显式短路：Promise.race 对「调用前就已 settlement」的 promise 按 .then
    // 注册顺序定胜负——task 先注册先赢，gate 的拒绝会永远轮不到（本模块单测钉住此坑）。
    race: (task) => {
      if (g.fired()) {
        // #16 P1-1（对抗审查）：短路时必须订阅 task——浮空 rejection 会在 task 稍后失败时变成
        // 进程级 unhandledRejection（本仓 M5-HOTFIX 有前科）。吞掉即可，取消错误由本门负责结算。
        task.catch(() => {});
        return Promise.reject(g.error());
      }
      return Promise.race([task, g.gate]);
    },
    throwIfCancelled: () => {
      if (g.fired()) throw g.error();
    },
    dispose: g.cleanup,
  };
}
