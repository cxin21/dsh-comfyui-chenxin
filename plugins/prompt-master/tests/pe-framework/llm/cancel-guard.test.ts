import { describe, expect, it } from 'vitest';
import { CallerCancelledError, createCancelGuard } from '../../../src/pe-framework/llm/cancel.js';

/**
 * T-04（#16 exec-signal）：execute 级取消 guard。
 *  - race：abort 后以 CallerCancelledError 结算（可机检 name/message）
 *  - 预中止：throwIfCancelled 立即抛
 *  - dispose 后 abort：不产生 unhandled rejection，race 直通任务结果
 *  - 无 signal：guard 是恒等直通
 */
describe('createCancelGuard', () => {
  it('abort 后 race 以 CallerCancelledError 拒绝（消息含取消标记）', async () => {
    const ctrl = new AbortController();
    const guard = createCancelGuard(ctrl.signal, 'prompt_author');
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5_000));
    setTimeout(() => ctrl.abort(), 10);
    await expect(guard.race(slow)).rejects.toBeInstanceOf(CallerCancelledError);
    await expect(guard.race(slow)).rejects.toThrow(/已被调用方取消/);
  });

  it('预中止 signal：throwIfCancelled 立即抛，race 也拒绝', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const guard = createCancelGuard(ctrl.signal, 'x');
    expect(() => guard.throwIfCancelled()).toThrow(CallerCancelledError);
    await expect(guard.race(Promise.resolve(1))).rejects.toBeInstanceOf(CallerCancelledError);
  });

  it('dispose 后 abort：race 直通任务结果，无 unhandled rejection', async () => {
    const ctrl = new AbortController();
    const guard = createCancelGuard(ctrl.signal, 'x');
    guard.dispose();
    ctrl.abort();
    await expect(guard.race(Promise.resolve('ok'))).resolves.toBe('ok');
    await new Promise((r) => setTimeout(r, 20)); // 给潜在 unhandled rejection 略出窗口
  });

  it('无 signal（undefined）：恒等直通，dispose 安全', async () => {
    const guard = createCancelGuard(undefined, 'x');
    await expect(guard.race(Promise.resolve(7))).resolves.toBe(7);
    expect(() => guard.throwIfCancelled()).not.toThrow();
    expect(() => guard.dispose()).not.toThrow();
  });

  // #16 P2-5（对抗审查 mutation 杀手）：dispose 必须移除 abort 监听（execute finally 依赖
  // 此语义防跨调用泄漏）；变异「删 dispose 的 removeEventListener」在此变红。
  it('dispose 移除 abort 监听；之后 abort 不抛错（no-op）', () => {
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    const removed: string[] = [];
    // 记录后必须委托真实移除——只记录不放行会让监听器残留，abort 后 handler 照跑
    const target = signal as unknown as { removeEventListener: (t: string, f: unknown) => void };
    const original = signal.removeEventListener.bind(signal);
    target.removeEventListener = (type, fn) => {
      removed.push(type);
      (original as (t: string, f: EventListenerOrEventListenerObject) => void)(
        type,
        fn as EventListenerOrEventListenerObject,
      );
    };
    const guard = createCancelGuard(signal, 'x');
    guard.dispose();
    expect(removed).toEqual(['abort']);
    expect(() => ctrl.abort()).not.toThrow();
    expect(() => guard.throwIfCancelled()).not.toThrow();
  });
});
