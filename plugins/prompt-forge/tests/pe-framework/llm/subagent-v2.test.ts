import { describe, expect, it } from 'vitest';
import { createSubagentV2Runner, hasSubagentV2Seam } from '../../../src/pe-framework/llm/subagent-v2.js';
import { CallerCancelledError } from '../../../src/pe-framework/llm/cancel.js';

/**
 * 团队执行器（host 0.2.2-rc.5 新 seam `ctx.subagents.startActivation`）的适配契约：
 *   - 没有 live parent → 不提供 runner（不发注定 UNAUTHORIZED 的请求，让调用方回退 direct）；
 *   - spec 形状：provider/label/name/prompt/parent/signal/delivery='caller'；
 *   - 结果按 output 里的 text 块拼接返回；
 *   - stopReason 非 completed → 抛错并带 diagnostic；
 *   - 预中止 signal → 取消错误；
 *   - 无论成败都 dispose。
 */

type Activation = {
  result: Promise<{ stopReason?: string; diagnostic?: unknown; output?: Array<{ type?: string; text?: string }> }>;
  dispose: () => Promise<void> | void;
};

function hostCtx(activation: Activation, specs: Array<Record<string, unknown>> = []) {
  return {
    agent: { id: 'parent-1' },
    subagents: {
      startActivation: async (spec: unknown) => {
        specs.push(spec as Record<string, unknown>);
        return activation;
      },
    },
  };
}

describe('createSubagentV2Runner', () => {
  it('host 没有新 seam → 不提供 runner', () => {
    expect(hasSubagentV2Seam({})).toBe(false);
    expect(createSubagentV2Runner({} as never)).toBeUndefined();
  });

  it('没有 live parent → 不提供 runner（回退 direct，而不是发 UNAUTHORIZED 请求）', () => {
    const ctx = {
      subagents: {
        startActivation: async () => {
          throw new Error('不应被调用');
        },
      },
    };
    expect(hasSubagentV2Seam(ctx)).toBe(true);
    expect(createSubagentV2Runner(ctx as never)).toBeUndefined();
  });

  it('正常路径：发 startActivation(spec) 并返回 output 里的 text', async () => {
    const specs: Array<Record<string, unknown>> = [];
    const ctx = hostCtx(
      {
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'role-output' }] }),
        dispose: async () => {},
      },
      specs,
    );
    const runner = createSubagentV2Runner(ctx as never, { name: 'writer' });
    expect(runner).toBeDefined();

    const text = await runner!('TASK TEXT');
    expect(text).toBe('role-output');

    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec.provider).toBe('spawn');
    expect(spec.name).toBe('writer');
    expect(spec.delivery).toBe('caller');
    expect(spec.prompt).toEqual([{ type: 'text', text: 'TASK TEXT' }]);
    expect(spec.parent).toBe(ctx.agent);
    expect(typeof spec.label).toBe('string');
  });

  it('stopReason 非 completed → 抛错并带 diagnostic', async () => {
    const ctx = hostCtx({
      result: Promise.resolve({ stopReason: 'failed', diagnostic: 'quota exceeded' }),
      dispose: async () => {},
    });
    const runner = createSubagentV2Runner(ctx as never)!;
    await expect(runner('TASK')).rejects.toThrow(/stopReason=failed.*quota exceeded/);
  });

  it('没有产出文本 → 抛错', async () => {
    const ctx = hostCtx({
      result: Promise.resolve({ stopReason: 'completed', output: [] }),
      dispose: async () => {},
    });
    const runner = createSubagentV2Runner(ctx as never)!;
    await expect(runner('TASK')).rejects.toThrow(/未产出 assistant 文本/);
  });

  it('预中止 signal → 取消错误，不发请求', async () => {
    const specs: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    controller.abort();
    const ctx = hostCtx(
      {
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'x' }] }),
        dispose: async () => {},
      },
      specs,
    );
    const runner = createSubagentV2Runner(ctx as never, { signal: controller.signal })!;
    await expect(runner('TASK')).rejects.toBeInstanceOf(CallerCancelledError);
    expect(specs).toHaveLength(0);
  });

  it('失败路径也会 dispose', async () => {
    let disposed = 0;
    const ctx = hostCtx({
      result: Promise.resolve({ stopReason: 'failed', diagnostic: 'x' }),
      dispose: async () => {
        disposed += 1;
      },
    });
    const runner = createSubagentV2Runner(ctx as never)!;
    await expect(runner('TASK')).rejects.toThrow();
    expect(disposed).toBe(1);
  });
});
