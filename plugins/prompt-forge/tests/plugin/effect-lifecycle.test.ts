import { describe, expect, it, afterEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { apply } from '../../src/plugin/index.js';
import { getPresetRoot, setPresetRoot } from '../../src/pe-framework/resources/resolve.js';
import { getCustomProfileSource, setCustomProfileSource } from '../../src/resolver/profiles/source.js';
import { clearProfileCache, findProfileById, setBuiltinFilter } from '../../src/resolver/profiles/index.js';
import { getAuthorIntentProvider, setAuthorIntentProvider } from '../../src/tools/prompt-author.js';

/**
 * 公开缝 = plugin.apply 的挂载/卸载合同（issue 17）。
 * 观察口用既有 getter，不新开测试探针。
 * 验收：卸载后再挂载，槽指向新挂载；卸载后调用不得静默沿用旧 ctx。
 */

// The slot only has to round-trip whatever was mounted, but plugin.apply also
// reads assets/style-presets off presetRoot during registration — so derive the
// checkout root from this file instead of baking a machine path into the suite.
// tests/plugin/<file> -> plugins/prompt-forge/tests/plugin -> ../../../../ = checkout root
const PRESET = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type Disposer = () => void;

function mountingCtx(marker: string, profiles: Record<string, string> = {}, disabled: string[] = []) {
  const disposers: Disposer[] = [];
  const started: string[] = [];
  const overrides: Record<string, { enabled: boolean }> = {};
  for (const id of disabled) overrides[id] = { enabled: false };
  const ctx = {
    marker,
    tools: { register: () => () => undefined },
    // direct transport（host 0.2.2-rc.5 起是默认路径）：LLM 调用打在**当次挂载的 ctx** 上，
    // 所以这里记录 marker，用来断言「重挂载后只打到新 ctx」。
    llm: {
      stream: async function* () {
        started.push(marker);
      },
    },
    subagents: {
      start: async () => {
        started.push(marker);
        return { id: marker, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
      },
    },
    agent: { options: {} },
    settings: {
      register() {
        return {
          get: () => ({ customProfiles: profiles, builtinOverrides: overrides }),
          update: async () => {},
          replace: async () => {},
          watch: () => () => {},
        };
      },
      get: () => ({ customProfiles: profiles, builtinOverrides: overrides }),
      update: async () => {},
      replace: async () => {},
    },
    effect(cb: () => void | Disposer) {
      const dispose = cb();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };
  return { ctx: ctx as unknown as Context, disposers, started };
}

function unload(disposers: Disposer[]): void {
  for (const dispose of [...disposers].reverse()) dispose();
}

describe('plugin apply 的模块槽跟 effect 同生共死', () => {
  afterEach(() => {
    setPresetRoot(undefined);
    setCustomProfileSource(null);
    setBuiltinFilter(undefined);
    setAuthorIntentProvider(null);
    clearProfileCache();
  });

  it('卸载后 preset root 与 custom source 回到安全缺省，再挂载只指向新 ctx', () => {
    const first = mountingCtx('old', { 'custom-old': '{"id":"custom-old"}' });
    apply(first.ctx, { presetRoot: PRESET, temperature: 0.7 });
    expect(getPresetRoot()).toBe(PRESET);
    expect(getCustomProfileSource()().map((row) => row.id)).toEqual(['custom-old']);

    unload(first.disposers);

    expect(getPresetRoot()).toBeUndefined();
    expect(getCustomProfileSource()()).toEqual([]);

    const second = mountingCtx('new', { 'custom-new': '{"id":"custom-new"}' });
    apply(second.ctx, { presetRoot: PRESET, temperature: 0.7 });
    expect(getPresetRoot()).toBe(PRESET);
    expect(getCustomProfileSource()().map((row) => row.id)).toEqual(['custom-new']);
  });

  it('卸载后 intent provider 为 null，调用不会走进旧 ctx；重挂载的 provider 只打到新 ctx', async () => {
    const first = mountingCtx('old');
    apply(first.ctx, { temperature: 0.7 });
    const mounted = getAuthorIntentProvider();
    expect(mounted).not.toBeNull();

    unload(first.disposers);

    expect(getAuthorIntentProvider()).toBeNull();
    expect(first.started).toEqual([]);

    const second = mountingCtx('new');
    apply(second.ctx, { temperature: 0.7 });
    const rebound = getAuthorIntentProvider();
    expect(rebound).not.toBeNull();
    expect(rebound).not.toBe(mounted);
    // 2026-11-22 transport 抽象：provider 的 transport 在**调用期**按能力解析，
    // 模型路由完全跟随调用方（exec）——所以调用必须带上会话路由。
    await rebound!(
      { input: 'x', target: 'anima' } as never,
      { agent: { options: { provider: 'p', model: 'm' } }, signal: new AbortController().signal } as never,
    ).catch(() => undefined);
    expect(first.started).toEqual([]);
    expect(second.started).toEqual(['new']);
  });

  it('卸载后 builtin filter 不再藏起旧挂载禁用的 profile', () => {
    const sample = 'pe_reverse_descriptive';
    expect(findProfileById(sample)).toBeTruthy();

    const first = mountingCtx('old', {}, [sample]);
    apply(first.ctx, { temperature: 0.7 });
    expect(findProfileById(sample)).toBeUndefined();

    unload(first.disposers);
    expect(findProfileById(sample)).toBeTruthy();
  });
});
