import { describe, expect, it, afterAll } from 'vitest';
import {
  registerAuthorTool,
  setAuthorIntentProvider,
  setDirectingDeps,
  type AuthorIntentRequest,
} from '../../src/tools/prompt-author.js';
import { stubCtx, runTool, dDeps, dBeat, dShot } from '../plugin/helpers.js';

const cfg = { temperature: 0.7 };

async function runH3(args: Record<string, unknown> = {}) {
  return JSON.parse(
    String(
      await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), {
        target: 'h3',
        input: 'x',
        judge_mode: 'off',
        ...args,
      }),
    ),
  );
}

describe('prompt_author directing loop (P4, spec §7)', () => {
  it('bad → critical → S5 repair fixes on 1st round → passed', async () => {
    let repairs = 0;
    // Beat 总时长 2s < 4 → G-duration critical；repairer 修复 duration → 5s → 收敛
    setDirectingDeps(dDeps({
      beatDirectorRunner: async () => JSON.stringify({ beats: [dBeat('B01', [dShot('B01-S1', 2)])] }),
      repairerRunner: async () => { repairs++; return JSON.stringify({ duration_seconds: 4 }); },
    }));
    const raw = await runH3();
    expect(repairs).toBe(1); // S5 修复真走一轮
    expect(raw.ok).toBe(true);
    expect(raw.observability.corrections).toBe(1);
    expect(raw.audit.gates.some((g: any) => g.rule === 'G-duration')).toBe(false);
    setDirectingDeps(null);
  });

  it('two repairs still failing → loop_exhausted advisory + ok=false', async () => {
    let repairs = 0;
    // 2 镜均 1s（tag 区间 + Beat 总时长双 critical），repairer 永不修复
    setDirectingDeps(dDeps({
      beatDirectorRunner: async () => JSON.stringify({ beats: [dBeat('B01', [dShot('B01-S1', 1), { ...dShot('B01-S2', 1), time: '00:01' }])] }),
      repairerRunner: async () => { repairs++; return JSON.stringify({ what: 'still bad' }); },
    }));
    const raw = await runH3();
    expect(repairs).toBe(4); // P0-1（A 路审查）：按镜预算 ≤2 轮/镜——2 镜 × 2 轮 = 4（旧「全局共 2 次」语义已废）
    expect(raw.ok).toBe(false);
    expect(raw.advisories).toContain('loop_exhausted:true');
    expect(raw.next_action).toBe('manual');
    setDirectingDeps(null);
  });

  it('F1: i2va with identity_subject reference → G-refbinding critical gate fires', async () => {
    setDirectingDeps(dDeps({
      beatDirectorRunner: async () => JSON.stringify({ beats: [dBeat('B01', [dShot('B01-S1', 4, { stage: 'i2va', reference_plan: [{ role: 'identity_subject', target: 'S1', h3_label: 'Subject 1' }] })])] }),
      repairerRunner: async () => JSON.stringify({ what: 'x' }),
    }));
    const raw = await runH3();
    expect(raw.audit.gates.some((g: any) => g.rule === 'G-refbinding' && g.severity === 'critical')).toBe(true);
    setDirectingDeps(null);
  });

  it('F2: dialogue speaker_id not in characters → G-dialogue-official critical gate', async () => {
    setDirectingDeps(dDeps({
      beatDirectorRunner: async () => JSON.stringify({ beats: [dBeat('B01', [dShot('B01-S1', 4, {
        direction: { performance: 'p', staging: 's', cinematography: 'c', dialogue: { speaker_id: 'S99', line: 'x', addressee_id: null }, micro_performance: 'm' },
        shot_intent: { new_information: 'x', narrative_subject: 'y', contains_reaction: true },
      })])] }),
      repairerRunner: async () => JSON.stringify({ what: 'x' }),
    }));
    const raw = await runH3();
    expect(raw.audit.gates.some((g: any) => g.rule === 'G-dialogue-official' && g.severity === 'critical')).toBe(true);
    setDirectingDeps(null);
  });

  afterAll(() => {
    setAuthorIntentProvider(null);
    setDirectingDeps(null);
  });

  // Round7 T6：三期 T3 闭环联动的行为级锚定——中文片段触发 cjk_in_positive critical 后，
  // 修正闭环必须真走（intent provider 第二次调用 + feedback 携带 gate detail），修正后英文稿出稿 ok
  it('cjk_in_positive critical (Chinese fragment) truly drives the correction loop → English draft ok', async () => {
    const reqs: AuthorIntentRequest[] = [];
    setAuthorIntentProvider(async (req) => {
      reqs.push(req);
      return req.round === 0
        ? { slots: { count_gender: ['1girl'], appearance: ['蓝色短发'] } } // 含中文片段 → cjk_in_positive critical
        : { slots: { count_gender: ['1girl'], appearance: ['blue short hair'] } }; // 修正轮纯英文
    });
    const raw = JSON.parse(
      String(
        await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), {
          target: 'anima',
          input: 'x',
          judge_mode: 'off',
          enrich: false,
        }),
      ),
    );
    expect(reqs.map((r) => r.round)).toEqual([0, 1]); // intent provider 第二次调用——闭环真走
    // feedback 携带 cjk gate 的 detail 片段文本（闭环驱动内容可观测）
    expect(reqs[1].feedback).toContain('cjk_in_positive');
    expect(reqs[1].feedback).toContain('cjk fragment in positive (invalid for anima tag library)');
    expect(reqs[1].feedback).toContain('蓝色短发');
    // 修正后英文稿出稿 ok=true，cjk gate 不再出现
    expect(raw.ok).toBe(true);
    expect(raw.audit.passed).toBe(true);
    expect(raw.audit.gates.some((g: any) => g.rule === 'cjk_in_positive')).toBe(false);
  });

  // Round 8 F7：tag_budget_exceeded（important）随修正 feedback 拼接传达——闭环触发仍只认
  // critical（cjk 驱动），但首轮超预算的软预算裁剪指令必须真的到达 intent 修正轮（feedback 含
  // tag_budget_exceeded detail），修正轮裁剪到预算内 → 最终出稿 ok=true 且 gate 消失
  it('F7: over-budget important gate detail rides correction feedback → trimmed draft ok', async () => {
    // 2026-09-12 P2'：夹具 tag 改用真 canonical danbooru 外观 tag——假 tag 会被证据流删除，
    // 预算 gate 不触发（drop 仅生产 compile 开启；runTool 走生产路径）
    const CANON = [
      'long hair',
      'short hair',
      'twintails',
      'ponytail',
      'braid',
      'bob cut',
      'ahoge',
      'hime cut',
      'blunt bangs',
      'side ponytail',
      'black hair',
      'brown hair',
      'blue hair',
      'red hair',
      'white hair',
      'purple hair',
      'pink hair',
      'grey hair',
      'green hair',
      'blonde hair',
      'blue eyes',
      'red eyes',
      'green eyes',
      'brown eyes',
      'purple eyes',
      'gold eyes',
      'heterochromia',
      'glasses',
      'blush',
      'mole',
      'freckles',
      'hair ornament',
      'hair ribbon',
      'hairclip',
      'headband',
      'hair bobbles',
      'cone hairbun',
      'double bun',
      'hair flower',
    ];
    const reqs: AuthorIntentRequest[] = [];
    setAuthorIntentProvider(async (req) => {
      reqs.push(req);
      if (req.round === 0) {
        // 40 appearance（39 英文 + 1 中文片段→cjk critical 驱动闭环）+ 1 count_gender = 41 槽位
        // tag + 4 质量前缀 = 45 段 > 40 → tag_budget_exceeded（important）
        return { slots: { count_gender: ['1girl'], appearance: [...CANON, '蓝色短发'] } };
      }
      // 修正轮：裁剪到预算内——29 appearance + 1 count_gender + 4 前缀 = 34 段 ≤ 40，纯英文
      return { slots: { count_gender: ['1girl'], appearance: CANON.slice(0, 29) } };
    });
    const raw = JSON.parse(
      String(
        await runTool(stubCtx(), registerAuthorTool(stubCtx() as never, cfg as never), {
          target: 'anima',
          input: 'x',
          judge_mode: 'off',
          enrich: false,
        }),
      ),
    );
    expect(reqs.map((r) => r.round)).toEqual([0, 1]); // 闭环真走（cjk critical 驱动），修正轮后收敛
    // 软预算裁剪指令随 feedback 到达 intent 修正轮（F7 链路实测）
    expect(reqs[1].feedback).toContain('tag_budget_exceeded');
    expect(reqs[1].feedback).toContain('场景细节>氛围词>次要动作');
    // 闭环驱动源不变：critical gate 照旧在 feedback 里
    expect(reqs[1].feedback).toContain('cjk_in_positive');
    // 修正稿在预算内 → 最终出稿 ok，预算 gate 消失
    expect(raw.ok).toBe(true);
    expect(raw.audit.passed).toBe(true);
    expect(raw.audit.gates.some((g: any) => g.rule === 'tag_budget_exceeded')).toBe(false);
  });

  afterAll(() => setAuthorIntentProvider(null));
});
