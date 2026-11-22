import { describe, expect, it, vi } from 'vitest';
import { analyzeIntent, analyzeBlueprintIncremental } from '../../../src/pe-framework/blueprint/analyzer.js';
import { enrichBlueprint } from '../../../src/pe-framework/enrichment/engine.js';
import { createSubagentCriticProvider } from '../../../src/pe-framework/eval/critic.js';
import { createProductionCriticProvider } from '../../../src/pe-framework/pipeline/judge-assembly.js';
import { textStream } from '../../plugin/helpers.js';
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js';

/**
 * T-02（#16 exec-signal）：主链直连兜底与 critic 装配必须把调用方 signal 交给
 * ctx.llm.stream / subagents.start。孤儿 AbortController 会让用户取消到不了在途 LLM。
 * 不变量：
 *  - 传入的 signal 对象身份进入 stream/start（不是新造的永不中止 controller）
 *  - 不传 signal：仍能完成（历史兜底，不要求调用方先造 controller）
 *  - critic 外部 abort 与内部超时是 OR：任一中止即 abort 交给 start 的 signal
 */

const v0 = {
  schema_version: 1,
  media: 'image',
  core: { concept: 'rain', negative: [] },
  media_layer: { image: {} },
};

function streamCtx() {
  const signals: Array<AbortSignal | undefined> = [];
  const ctx = {
    llm: {
      async *stream(opts: { signal?: AbortSignal }) {
        signals.push(opts.signal);
        for (const c of textStream(JSON.stringify(v0))) yield c;
      },
    },
  };
  return { ctx: ctx as never, signals };
}

const oldBp = v0 as unknown as BlueprintV1;

describe('主链直连兜底透传 exec.signal（#16）', () => {
  it('analyzeIntent 把 opts.signal 原样交给 ctx.llm.stream', async () => {
    const h = streamCtx();
    const ctrl = new AbortController();
    await analyzeIntent(h.ctx, { provider: 'p', model: 'm' }, 'rain', { signal: ctrl.signal });
    expect(h.signals).toEqual([ctrl.signal]);
  });

  it('analyzeBlueprintIncremental 直连兜底把 opts.signal 原样交给 stream', async () => {
    const h = streamCtx();
    const ctrl = new AbortController();
    await analyzeBlueprintIncremental(h.ctx, { provider: 'p', model: 'm' }, oldBp, 'add fog', {
      signal: ctrl.signal,
    });
    expect(h.signals).toEqual([ctrl.signal]);
  });

  it('enrichBlueprint 直连兜底把 opts.signal 原样交给 stream', async () => {
    const h = streamCtx();
    const ctrl = new AbortController();
    await enrichBlueprint(h.ctx, { provider: 'p', model: 'm' }, oldBp, { signal: ctrl.signal });
    expect(h.signals[0]).toBe(ctrl.signal);
  });

  it('不传 signal 时直连兜底仍能完成（历史行为）', async () => {
    const h = streamCtx();
    const r = await analyzeIntent(h.ctx, { provider: 'p', model: 'm' }, 'rain');
    expect(r.blueprint.media).toBe('image');
    expect(h.signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('critic 装配透传外部 signal（#16）', () => {
  function criticCtx() {
    const starts: Array<{ signal: AbortSignal }> = [];
    const start = vi.fn((_kind: string, opts: { signal: AbortSignal }) => {
      starts.push(opts);
      return Promise.resolve({
        id: 'run-1',
        result: new Promise(() => {}),
        dispose: vi.fn(),
      });
    });
    return {
      owner: { agent: { id: 'owner' }, subagents: { start } } as never,
      starts,
    };
  }

  it('createSubagentCriticProvider：外部 abort 中止交给 start 的 signal', async () => {
    const h = criticCtx();
    const ctrl = new AbortController();
    const provider = createSubagentCriticProvider(h.owner, { signal: ctrl.signal, timeoutMs: 5_000 });
    const p = provider({ persona: 'P', schema: 'S', user: 'U' });
    await vi.waitFor(() => expect(h.starts.length).toBe(1));
    ctrl.abort();
    await expect(p).rejects.toThrow(/已被调用方取消/);
    expect(h.starts[0]!.signal.aborted).toBe(true);
  });

  it('不传 signal：内部超时语义不变，按超时 reject 而不是取消错误', async () => {
    const h = criticCtx();
    const provider = createSubagentCriticProvider(h.owner, { timeoutMs: 15 });
    const p = provider({ persona: 'P', schema: 'S', user: 'U' });
    await vi.waitFor(() => expect(h.starts.length).toBe(1));
    await expect(p).rejects.toThrow(/超时/);
    expect(h.starts[0]!.signal.aborted).toBe(true);
  });

  it('createProductionCriticProvider 把 signal 传进 critic 装配', async () => {
    const h = criticCtx();
    const ctrl = new AbortController();
    const provider = createProductionCriticProvider(h.owner, { signal: ctrl.signal, timeoutMs: 5_000 });
    const p = provider({ persona: 'P', schema: 'S', user: 'U' });
    await vi.waitFor(() => expect(h.starts.length).toBe(1));
    expect(h.starts[0]!.signal).toBeDefined();
    ctrl.abort();
    await expect(p).rejects.toThrow(/已被调用方取消/);
  });
});
