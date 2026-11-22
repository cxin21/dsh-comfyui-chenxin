import { describe, expect, it } from 'vitest';
import { createSubagentToolRunner, PIPELINE_TOOL_ALLOW } from '../../../src/pe-framework/llm/subagent-tool-runner.js';

/** mock host ctx：捕获 subagents.start 的 spawn opts */
function mockCtx(outputText: string) {
  const captured: Array<Record<string, unknown>> = [];
  return {
    captured,
    ctx: {
      agent: { options: {} },
      subagents: {
        start: async (_kind: string, opts: Record<string, unknown>) => {
          captured.push(opts);
          return {
            result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: outputText }] }),
            dispose: async () => {},
          };
        },
      },
    },
  };
}

describe('createSubagentToolRunner（A2：三 LLM 开放 catalog_search 工具）', () => {
  it('toolFilter.allow = [catalog_search]（区别于 text runner 的空 allow）', async () => {
    const { ctx, captured } = mockCtx('ok');
    const run = createSubagentToolRunner(ctx, { labelPrefix: 'pm-writer' });
    const out = await run('task text');
    expect(out).toBe('ok');
    expect(captured[0].toolFilter).toEqual({ allow: ['catalog_search'] });
    expect(PIPELINE_TOOL_ALLOW).toEqual(['catalog_search']);
  });

  it('labelPrefix 进入子代理 label', async () => {
    const { ctx, captured } = mockCtx('ok');
    await createSubagentToolRunner(ctx, { labelPrefix: 'pm-auditor' })('t');
    expect(String(captured[0].label)).toContain('pm-auditor');
  });

  it('stopReason 非 completed → 抛错（含 diagnostic）', async () => {
    const ctx = {
      agent: { options: {} },
      subagents: {
        start: async () => ({
          result: Promise.resolve({ stopReason: 'aborted', diagnostic: 'boom' }),
          dispose: async () => {},
        }),
      },
    };
    await expect(createSubagentToolRunner(ctx)('t')).rejects.toThrow(/aborted.*boom/);
  });

  it('无 subagents 注册 → 显式报错', async () => {
    await expect(createSubagentToolRunner({})('t')).rejects.toThrow(/subagents/);
  });

  it('空输出 → 报错', async () => {
    const { ctx } = mockCtx('   ');
    await expect(createSubagentToolRunner(ctx)('t')).rejects.toThrow(/未产出/);
  });
});
