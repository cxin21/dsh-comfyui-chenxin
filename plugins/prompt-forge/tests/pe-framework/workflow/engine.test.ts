import { describe, expect, it, afterEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { WorkflowEngine } from '../../../src/pe-framework/workflow/engine.js';
import {
  beginWorkflowScope,
  endWorkflowScope,
  isInsideWorkflow,
  isNestedWorkflowCall,
} from '../../../src/pe-framework/workflow/guard.js';
import { clearWorkflowEngine, getWorkflowEngine, setWorkflowEngine } from '../../../src/pe-framework/workflow/registry.js';
import { textStream } from '../../plugin/helpers.js';

/**
 * LLM 工作流引擎（2026-11-22）的执行纪律契约：
 *   1. 执行器解析（direct / subagent / subagent-v2，节点级 prefer 优先）；
 *   2. 失败分类（transport_unavailable / llm_failed / cancelled）；
 *   3. 重试（取消不重试）；
 *   4. 逐节点 trace（id / role / executor / ok / ms / attempts / error）。
 *
 * 引擎不吞控制流：控制流（修复轮、审计门）仍归编排器；这里只验节点的执行语义。
 */

type FakeCtx = {
  llm?: { stream(options: unknown): AsyncIterable<unknown> };
  subagents?: {
    start?: (provider: string, req: unknown) => Promise<{ result: Promise<unknown>; dispose(): void }>;
    startActivation?: (spec: unknown) => Promise<{ result: Promise<unknown>; dispose(): Promise<void> }>;
  };
  agent?: unknown;
};

function directCtx(text = 'ok'): FakeCtx {
  return {
    llm: {
      async *stream() {
        for (const chunk of textStream(text)) yield chunk;
      },
    },
  };
}

function teamCtx(text = 'team-output'): FakeCtx {
  const calls: Array<Record<string, unknown>> = [];
  return {
    agent: { id: 'parent-1' },
    subagents: {
      startActivation: async (spec: unknown) => {
        calls.push(spec as Record<string, unknown>);
        return {
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text }],
          }),
          dispose: async () => {},
        };
      },
    },
    // team 形态优先于 direct（PM_TRANSPORT=team）——本 fake 同时具备两个 seam 以验证排序
    llm: {
      async *stream() {
        for (const chunk of textStream('direct-output')) yield chunk;
      },
    },
    __calls: calls,
  } as FakeCtx;
}

function asContext(ctx: FakeCtx): Context {
  return ctx as unknown as Context;
}

const originalTransport = process.env.PM_TRANSPORT;

afterEach(() => {
  if (originalTransport === undefined) delete process.env.PM_TRANSPORT;
  else process.env.PM_TRANSPORT = originalTransport;
});

describe('WorkflowEngine', () => {
  it('direct 路径：角色节点返回 assistant 文本，trace 记录 executor=direct', async () => {
    const engine = new WorkflowEngine({
      ctx: asContext(directCtx('hello-from-direct')),
      resolveRoute: () => ({ provider: 'p', model: 'm' }),
    });

    expect(engine.hasExecutor()).toBe(true);
    const text = await engine.runRole({ id: 'intent', role: 'intent' }, 'TASK');
    expect(text).toBe('hello-from-direct');

    const snapshot = engine.snapshot();
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({ id: 'intent', role: 'intent', executor: 'direct', ok: true, attempts: 1 });
    expect(snapshot.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('两条 seam 都不可用：hasExecutor=false，节点失败分类 transport_unavailable', async () => {
    const engine = new WorkflowEngine({ ctx: asContext({}) });

    expect(engine.hasExecutor()).toBe(false);
    await expect(engine.runRole({ id: 'intent', role: 'intent' }, 'TASK')).rejects.toThrow(/没有可用执行器/);

    const outcome = engine.snapshot().nodes[0];
    expect(outcome.ok).toBe(false);
    expect(outcome.executor).toBe('none');
    expect(outcome.error?.code).toBe('transport_unavailable');
  });

  it('LLM 失败：分类 llm_failed，并按 maxAttempts 重试', async () => {
    let attempts = 0;
    const ctx: FakeCtx = {
      llm: {
        async *stream() {
          attempts += 1;
          throw new Error('boom');
        },
      },
    };
    const engine = new WorkflowEngine({ ctx: asContext(ctx), resolveRoute: () => ({ provider: 'p', model: 'm' }) });

    await expect(engine.runRole({ id: 'intent', role: 'intent', maxAttempts: 1 }, 'TASK')).rejects.toThrow(/boom/);
    expect(attempts).toBe(2); // 首次 + 1 次重试
    const outcome = engine.snapshot().nodes[0];
    expect(outcome.error?.code).toBe('llm_failed');
    expect(outcome.attempts).toBe(2);
  });

  it('取消不重试：signal 已中止时分类 cancelled 且只尝试一次', async () => {
    let attempts = 0;
    const controller = new AbortController();
    controller.abort();
    const ctx: FakeCtx = {
      llm: {
        async *stream() {
          attempts += 1;
          throw new Error('aborted by caller');
        },
      },
    };
    const engine = new WorkflowEngine({
      ctx: asContext(ctx),
      resolveRoute: () => ({ provider: 'p', model: 'm' }),
      signal: controller.signal,
    });

    await expect(engine.runRole({ id: 'intent', role: 'intent', maxAttempts: 3 }, 'TASK')).rejects.toThrow();
    expect(attempts).toBe(1);
    const outcome = engine.snapshot().nodes[0];
    expect(outcome.error?.code).toBe('cancelled');
    expect(outcome.attempts).toBe(1);
  });

  it('PM_TRANSPORT=team：团队执行器优先于 direct，节点 executor=subagent-v2', async () => {
    process.env.PM_TRANSPORT = 'team';
    const engine = new WorkflowEngine({
      ctx: asContext(teamCtx('team-role-output')),
      parent: { id: 'parent-1' },
      resolveRoute: () => ({ provider: 'p', model: 'm' }),
    });

    const text = await engine.runRole({ id: 'writer', role: 'writer' }, 'TASK');
    expect(text).toBe('team-role-output');
    expect(engine.snapshot().nodes[0].executor).toBe('subagent-v2');
  });

  it('节点级 prefer 覆盖全局开关：单个角色走 direct，其余走默认', async () => {
    process.env.PM_TRANSPORT = 'team';
    const engine = new WorkflowEngine({
      ctx: asContext(teamCtx()),
      parent: { id: 'parent-1' },
      resolveRoute: () => ({ provider: 'p', model: 'm' }),
    });

    await engine.runRole({ id: 'critic', role: 'critic', executor: 'direct' }, 'TASK');
    expect(engine.snapshot().nodes[0].executor).toBe('direct');
  });
});

describe('工作流守卫与注册表', () => {
  it('作用域在 begin/end 之间有效，结束后清除', () => {
    const ctx = {};
    expect(isInsideWorkflow(ctx)).toBe(false);
    beginWorkflowScope(ctx, 'agent-a');
    expect(isInsideWorkflow(ctx)).toBe(true);
    endWorkflowScope(ctx);
    expect(isInsideWorkflow(ctx)).toBe(false);
  });

  it('嵌套判据按调用者身份：teammate（另一个 agent）被拒，同一 agent 的并发顶层调用放行', () => {
    const ctx = {};
    beginWorkflowScope(ctx, 'agent-a');
    // teammate 继承父工具面后回头再调 → 调用者 agent 不同 → 判为自指回路
    expect(isNestedWorkflowCall(ctx, 'agent-b')).toBe(true);
    // 同一会话里另一个顶层调用（同一个 agent）→ 放行
    expect(isNestedWorkflowCall(ctx, 'agent-a')).toBe(false);
    // 拿不到调用者身份时无法判定 → 不误伤
    expect(isNestedWorkflowCall(ctx, undefined)).toBe(false);
    endWorkflowScope(ctx);
    expect(isNestedWorkflowCall(ctx, 'agent-b')).toBe(false);
  });

  it('嵌套 begin/end 计数：内层结束后外层作用域仍在', () => {
    const ctx = {};
    beginWorkflowScope(ctx, 'agent-a');
    beginWorkflowScope(ctx, 'agent-a');
    endWorkflowScope(ctx);
    expect(isInsideWorkflow(ctx)).toBe(true);
    endWorkflowScope(ctx);
    expect(isInsideWorkflow(ctx)).toBe(false);
  });

  it('注册表：set/get/clear 按 ctx 绑定引擎', () => {
    const ctx = {};
    expect(getWorkflowEngine(ctx)).toBeUndefined();
    const engine = new WorkflowEngine({ ctx: asContext(directCtx()) });
    setWorkflowEngine(ctx, engine);
    expect(getWorkflowEngine(ctx)).toBe(engine);
    clearWorkflowEngine(ctx);
    expect(getWorkflowEngine(ctx)).toBeUndefined();
  });
});
