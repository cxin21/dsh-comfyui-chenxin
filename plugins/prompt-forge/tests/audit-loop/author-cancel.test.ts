import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAuthorTool, setAuthorIntentProvider, setDirectingDeps } from '../../src/tools/prompt-author.js';
import { stubCtx, runTool, dDeps } from '../plugin/helpers.js';

/**
 * T-04（#16 exec-signal）：execute 级取消结算集成测试。
 * 契约：exec.signal 中止后 prompt_author ≤1s 内结算（reject CallerCancelledError），
 * 不再继续出稿（不落库、不返回 envelope）。第一性原理：取消与 D7 fail-open 冲突——
 * writer 被取消后 fail-open 会换 deterministicCompose 继续出稿，取消必须优先于兜底。
 */
const cfg = { temperature: 0.7 };

describe('prompt_author 取消结算（exec.signal 贯穿）', () => {
  // P2-6（对抗审查）：全局 seam 复位放 afterEach——用例断言失败也能复位，不泄漏到后续用例
  afterEach(() => {
    setDirectingDeps(null);
    setAuthorIntentProvider(null);
  });

  // SKIP 依据（#16）：directing/orchestrate.ts 在途 WIP 存在既有 TS2304（scriptIr/validateDirectingIr
  // 未定义，工作树半成品，属 #24 R1-R27 范围）——h3 全链在任何用例都到不了取消点。
  // 解除条件已满足（#24 全量回归转绿）——h3 链路取消结算回归
  it('h3 directing 管线进行中 abort → ≤1s reject，不返回出稿', async () => {
    // S2 Beat 导演挂起（模拟进行中的 LLM 子代理）；abort 必须穿透编排器结算整个调用
    setDirectingDeps(
      dDeps({
        beatDirectorRunner: () => new Promise<string>(() => {}),
      }),
    );
    const ctrl = new AbortController();
    const exec = { signal: ctrl.signal, agent: { options: { provider: 'p', model: 'm' } } };
    const p = runTool(
      stubCtx(),
      registerAuthorTool(stubCtx() as never, cfg as never),
      { target: 'h3', input: 'x', judge_mode: 'off' },
      exec,
    );
    const t0 = Date.now();
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toThrow(/已被调用方取消/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('anima compositing 管线进行中 abort → ≤1s reject', async () => {
    // anima：intent provider 挂起（S1 语义蓝图阶段）
    setAuthorIntentProvider(() => new Promise(() => {}));
    const ctrl = new AbortController();
    const exec = { signal: ctrl.signal, agent: { options: { provider: 'p', model: 'm' } } };
    const p = runTool(
      stubCtx(),
      registerAuthorTool(stubCtx() as never, cfg as never),
      { target: 'anima', input: 'a girl in the rain', judge_mode: 'off' },
      exec,
    );
    const t0 = Date.now();
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toThrow(/已被调用方取消/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  // #16 P1-2/P2-5（对抗审查 mutation 杀手）：取消必须优先于 intent 校验失败重试。
  // 变异「catch 吞掉取消继续重试」会 provider 被调 2 次 → 调用计数断言变红。
  it('预中止时取消优先于校验失败重试：provider 只调 1 次，结算为取消错误', async () => {
    const provider = vi.fn(async () => {
      throw new Error('mock 蓝图校验失败');
    });
    setAuthorIntentProvider(provider as never);
    const ctrl = new AbortController();
    ctrl.abort(); // 预中止：guard 在 provider 首调前已 fired
    const exec = { signal: ctrl.signal, agent: { options: { provider: 'p', model: 'm' } } };
    await expect(
      runTool(
        stubCtx(),
        registerAuthorTool(stubCtx() as never, cfg as never),
        { target: 'anima', input: 'a girl in the rain', judge_mode: 'off' },
        exec,
      ),
    ).rejects.toThrow(/已被调用方取消/);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
