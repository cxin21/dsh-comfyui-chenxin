import { describe, expect, it, vi } from 'vitest';
import { createSubagentTextRunner } from '../../../src/pe-framework/llm/subagent-text.js';
import { createSubagentToolRunner } from '../../../src/pe-framework/llm/subagent-tool-runner.js';
import type { SubagentHostCtx } from '../../../src/pe-framework/llm/host-ctx.js';

/**
 * T-01（#16 exec-signal）：runner 层外部取消信号合并。
 * 不变量：
 *  - 外部 abort ∨ 内部超时，任一即中止（OR 合并）
 *  - 预中止的 signal：不发起 subagents.start，立即结算
 *  - 不传 signal：行为与历史版本完全一致（零变化）
 *  - 中止后 dispose 必被调用；listener 必被移除（无泄漏）
 */

interface StartedOpts {
  label: string;
  signal: AbortSignal;
  prompt: Array<{ type: string; text: string }>;
}

function makeCtx() {
  const starts: StartedOpts[] = [];
  const dispose = vi.fn();
  let settle: (v: { stopReason?: string; diagnostic?: unknown; output?: Array<{ type?: string; text?: string }> }) => void =
    () => {};
  const ctx: SubagentHostCtx = {
    agent: { options: { provider: 'p', model: 'm' } },
    subagents: {
      start: (_kind: string, opts: Record<string, unknown>) => {
        starts.push(opts as unknown as StartedOpts);
        return Promise.resolve({
          result: new Promise((res) => {
            settle = res as typeof settle;
          }),
          dispose,
        });
      },
    },
  };
  return {
    ctx,
    starts,
    dispose,
    complete: (text: string) => settle({ stopReason: 'completed', output: [{ type: 'text', text }] }),
  };
}

const factories = [
  { name: 'text runner', make: createSubagentTextRunner },
  { name: 'tool runner', make: createSubagentToolRunner },
] as const;

describe.each(factories)('$name 外部取消信号合并', ({ make }) => {
  it('外部 abort 中止进行中的子代理：reject 取消错误 + start 收到已中止 signal + dispose 调用', async () => {
    const h = makeCtx();
    const ctrl = new AbortController();
    const runner = make(h.ctx, { labelPrefix: 'pm-x', timeoutMs: 5_000, signal: ctrl.signal, parent: {} });
    const p = runner('task');
    await vi.waitFor(() => expect(h.starts.length).toBe(1));
    ctrl.abort();
    await expect(p).rejects.toThrow(/已被调用方取消/);
    expect(h.starts[0]!.signal.aborted).toBe(true);
    expect(h.dispose).toHaveBeenCalled();
  });

  it('预中止的 signal：不发起 start，立即 reject 取消错误', async () => {
    const h = makeCtx();
    const ctrl = new AbortController();
    ctrl.abort();
    const runner = make(h.ctx, { timeoutMs: 5_000, signal: ctrl.signal, parent: {} });
    await expect(runner('task')).rejects.toThrow(/已被调用方取消/);
    expect(h.starts.length).toBe(0);
    expect(h.dispose).not.toHaveBeenCalled();
  });

  it('不传 signal：行为与历史版本一致（正常完成返回文本）', async () => {
    const h = makeCtx();
    const runner = make(h.ctx, { timeoutMs: 5_000, parent: {} });
    const p = runner('task');
    await vi.waitFor(() => expect(h.starts.length).toBe(1));
    h.complete('hello world');
    await expect(p).resolves.toBe('hello world');
    expect(h.starts[0]!.signal.aborted).toBe(false);
  });

  it('内部超时语义保持：未完成时按超时 reject（不受 signal 参数影响）', async () => {
    const h = makeCtx();
    const runner = make(h.ctx, { timeoutMs: 15, parent: {} });
    const p = runner('task');
    await vi.waitFor(() => expect(h.starts.length).toBe(1));
    await expect(p).rejects.toThrow(/超时/);
    expect(h.dispose).toHaveBeenCalled();
  });

  it('外部 abort 晚于完成：不影响已成功的结果，且 listener 被清理', async () => {
    const h = makeCtx();
    const ctrl = new AbortController();
    const removeEventListenerSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    const runner = make(h.ctx, { timeoutMs: 5_000, signal: ctrl.signal, parent: {} });
    const p = runner('task');
    await vi.waitFor(() => expect(h.starts.length).toBe(1));
    h.complete('done');
    await expect(p).resolves.toBe('done');
    expect(removeEventListenerSpy).toHaveBeenCalled();
    ctrl.abort(); // 完成后再 abort 不得产生 unhandled rejection（gate 已被标记处理）
  });
});
