import { describe, expect, it } from 'vitest';
import { createSubagentTextRunner } from '../../../src/pe-framework/llm/subagent-text.js';
import { enrichBlueprint } from '../../../src/pe-framework/enrichment/engine.js';
import { analyzeBlueprintIncremental } from '../../../src/pe-framework/blueprint/analyzer.js';

const fakeOwnerCtx = (outputText: string) => {
  const startCalls: Array<{ label: string; prompt: Array<{ type: string; text?: string }>; parent: unknown }> = [];
  const ownerCtx = {
    subagents: {
      start: async (
        _provider: string,
        req: { label: string; prompt: Array<{ type: string; text?: string }>; parent: unknown },
      ) => {
        startCalls.push(req);
        return {
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: outputText }] }),
          dispose: async () => {},
        };
      },
    },
    agent: { options: {} },
  };
  return { ownerCtx, startCalls };
};

describe('createSubagentTextRunner（全部 LLM 调用改子代理，用户定案 2026-09-15）', () => {
  it('taskText 经子代理 prompt 发出、parent 线穿、返回 assistant 文本', async () => {
    const { ownerCtx, startCalls } = fakeOwnerCtx('SUBAGENT_OK');
    const run = createSubagentTextRunner(ownerCtx, { labelPrefix: 'pm-enrich', parent: { options: {} } });
    const out = await run('TASK_TEXT_BODY');
    expect(out).toBe('SUBAGENT_OK');
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].label.startsWith('pm-enrich-')).toBe(true);
    expect(JSON.stringify(startCalls[0].prompt)).toContain('TASK_TEXT_BODY');
    expect(startCalls[0].parent).toEqual({ options: {} });
  });

  it('ownerCtx 缺 subagents → 调用期 throw（由调用方降级）', async () => {
    const run = createSubagentTextRunner({}, { parent: { options: {} } });
    await expect(run('x')).rejects.toThrow('ctx.subagents 未注册');
  });
});

describe('enrichBlueprint 子代理 seam（opts.llm）', () => {
  const v0 = { schema_version: 1, media: 'image', core: { concept: '赛博朋克御姐' } } as any;

  it('注入 opts.llm 时走子代理 runner（persona+user 传入，complete 直连不触达）', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    // ctx.llm.stream 一被调用就 throw——证明直连路径未触达
    const ctx = {
      llm: {
        async *stream() {
          throw new Error('complete 直连不应被调用');
        },
      },
    } as any;
    const out = await enrichBlueprint(ctx, { provider: 'p', model: 'm' }, v0, {
      llm: async (req) => {
        seen.push(req);
        return '{"set":{"core":{"concept":"黄昏赛博朋克御姐"}},"expansions":["subagent-path"]}';
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toContain('美学扩展');
    expect(seen[0].user).toContain('v0 蓝图');
    expect(out.blueprint.core.concept).toBe('黄昏赛博朋克御姐');
    expect(out.expansions).toContain('subagent-path');
  });

  it('llm runner 抛错 → 既有降级纪律（fallback_to_v0 + reason 可观测）', async () => {
    const ctx = {
      llm: {
        async *stream() {
          throw new Error('complete 直连不应被调用');
        },
      },
    } as any;
    const out = await enrichBlueprint(ctx, { provider: 'p', model: 'm' }, v0, {
      llm: async () => {
        throw new Error('subagent boom');
      },
    });
    expect(out.blueprint).toEqual(v0);
    expect(out.expansions.some((e) => e.includes('enrichment_failed'))).toBe(true);
  });
});

describe('analyzeBlueprintIncremental 子代理 seam（opts.llm）', () => {
  it('注入 opts.llm 时走子代理 runner（增量锚定 persona 传入），直连不触达', async () => {
    const oldBp = { schema_version: 1, media: 'image', core: { concept: '旧蓝图' } } as any;
    const seen: Array<{ system: string; user: string }> = [];
    const ctx = {
      llm: {
        async *stream() {
          throw new Error('complete 直连不应被调用');
        },
      },
    } as any;
    const bp = await analyzeBlueprintIncremental(ctx, { provider: 'p', model: 'm' }, oldBp, '把场景换成雪原', {
      llm: async (req) => {
        seen.push(req);
        return JSON.stringify({ schema_version: 1, media: 'image', core: { concept: '雪原旧蓝图' } });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toContain('创作蓝图分析引擎');
    expect(seen[0].system).toContain('【增量锚定】');
    expect(seen[0].user).toContain('把场景换成雪原');
    expect(bp.core.concept).toBe('雪原旧蓝图');
  });
});
