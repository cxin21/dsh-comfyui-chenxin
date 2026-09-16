import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { registerAuthorTool, setAuthorIntentProvider, setAuthorJudgeDeps } from '../../src/tools/prompt-author.js';
import { createBlueprintRepo } from '../../src/pe-framework/blueprint/repo.js';
import { stubCtx, runTool, textStream } from './helpers.js';
import type { AuthorIntentFn } from '../../src/tools/prompt-author.js';
// 注入蓝图 provider：第一轮产出 v0，后续轮只补 duration
const fakeProvider: AuthorIntentFn = async (req: any) => {
  if (req.round === 0)
    return {
      blueprint: {
        schema_version: 1,
        media: 'video',
        core: { concept: '三镜头打斗CG', negative: [] },
        media_layer: {
          video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] },
        },
      } as any,
      missing: ['style'],
    };
  return {} as any;
};

describe('prompt_author blueprint pipeline', () => {
  beforeEach(() => setAuthorIntentProvider(fakeProvider as any));
  afterEach(() => setAuthorIntentProvider(null));

  it('runs analyze→enrich→project→stage and returns ok envelope with next_action', async () => {
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') });
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 });
    const v = JSON.parse(
      String(
        await runTool(ctx, def, { target: 'h3', input: '三镜头打斗CG', style_id: 'cinematic_real', judge_mode: 'off' }),
      ),
    );
    expect(v.next_action).toBeDefined();
    expect(v.audit).toBeDefined();
  });
});

// 预存蓝图到 repo（stub settings 作为 repo 后端），再传 blueprint_id 走增量路径。
// 修订留痕（M5-HOTFIX）：返回形状迁移——ctx.settings 现在必须是 settings 服务（register 返回
// owner scope，值形状 {blueprints: Record<string,string>}），repoScope 供测试侧直接 seed。
// 旧裸 owner-scope 直传形状依赖 Bug B 断言（生产 = parseSettingsNamespace TypeError），接线
// 修复后不可达；本文件 3 个 blueprint_id 用例随迁（断言语义不变）。
function settingsRepo() {
  const store: Record<string, string> = {};
  const service = {
    register(_ns: string, _schema: unknown) {
      return {
        get: () => ({ blueprints: { ...store } }),
        watch: () => () => {},
        update: async (patch: { blueprints?: Record<string, string> }) => {
          Object.assign(store, patch.blueprints ?? {});
        },
        replace: async (section: { blueprints?: Record<string, string> }) => {
          for (const k of Object.keys(store)) delete store[k];
          Object.assign(store, section.blueprints ?? {});
        },
      };
    },
    update: async () => undefined,
    get: async () => ({ blueprints: { ...store } }),
    replace: async () => undefined,
  };
  const repoScope = {
    get: () => ({ ...store }),
    update: async (p: Record<string, string>) => {
      Object.assign(store, p);
    },
    replace: async (s: Record<string, string>) => {
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, s);
    },
  };
  return { settings: service, repoScope };
}

// Task 14：blueprint_id 路径改走 <old_blueprint> 锚定的增量意图分析——stub stream 文本需为
// parseBlueprintJson 可解析的完整蓝图（同文本作为 enrich patch 输入时等价自合并，无副作用）；
// input 必填豁免已取消，blueprint_id 用例需携带 input。
const BP_JSON = JSON.stringify({
  schema_version: 1,
  media: 'video',
  core: { concept: '三镜头打斗CG', negative: [] },
  media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
});

describe('prompt_author blueprint_id incremental path', () => {
  it('reload by blueprint_id skips analyzeIntent (provider not called)', async () => {
    const { settings, repoScope } = settingsRepo();
    const repo = createBlueprintRepo({ settings: repoScope } as any);
    repo.save('fight-15s', {
      schema_version: 1,
      media: 'video',
      core: { concept: '三镜头打斗CG', aspect_ratio: '9:16', negative: [] },
      media_layer: {
        video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] },
      },
    } as any);

    let providerCalls = 0;
    const countingProvider: AuthorIntentFn = async (_req: any) => {
      providerCalls++;
      return {} as any;
    };
    setAuthorIntentProvider(countingProvider as any);

    const ctx = stubCtx({ stream: textStream(BP_JSON) }) as any;
    ctx.settings = settings;
    const def = registerAuthorTool(ctx, { temperature: 0.7 });
    const v = JSON.parse(
      String(
        await runTool(ctx, def, {
          target: 'h3',
          blueprint_id: 'fight-15s',
          input: '把第二镜改成雨夜',
          judge_mode: 'off',
        }),
      ),
    );

    expect(providerCalls).toBe(0); // intent provider seam 未被消费（增量分析走 complete/llm.stream）
    expect(v.next_action).toBeDefined();
    setAuthorIntentProvider(null);
  });
});

describe('prompt_author blueprint Level 3 (t22 F1/F3 回归锁)', () => {
  // provider 每轮返回同一「不可修复」蓝图（8 镜 × 5s 超 max_shots(5)=2，preflightRepair 只记建议不改结构）
  const alwaysBrokenProvider: AuthorIntentFn = async (_req: any) => ({
    blueprint: {
      schema_version: 1,
      media: 'video',
      core: { concept: '8镜打斗', negative: [] },
      media_layer: {
        video: { total_duration_seconds: 5, shots: Array.from({ length: 8 }, (_, i) => ({ beat: `镜${i + 1}` })) },
      },
    } as any,
    missing: [],
  });

  it('Level 3: loop exhausted → next_action=manual + loop_exhausted:true (非 auto_repair)', async () => {
    setAuthorIntentProvider(alwaysBrokenProvider as any);
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') });
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 });
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', input: '8镜打斗', judge_mode: 'off' })));
    // Level 1 已触发（shots 超限建议）+ Level 2 两轮耗尽仍 critical → 必须 manual，不能因 repaired=true 误报 auto_repair
    expect(v.next_action).toBe('manual');
    expect(v.advisories).toContain('loop_exhausted:true');
    expect(v.observability.repairs.length).toBeGreaterThan(0); // Level 1 修复记录存在
    setAuthorIntentProvider(null);
  });
});

// 2026-09-15 对称性修复回归锁（真实会话 gen_1789485485442 实证）：蓝图分支此前只认 critical gate，
// judge needs_revision 耗尽修正轮后 next_action=ok 静默出稿——标准路径 2026-09-12 P3 已补打点，
// 蓝图分支当时漏改。本用例钉住：judgeFeedback 持续非空 + corrections 达 MAX → loop_exhausted:true。
describe('prompt_author blueprint Level 3 对称性（judge needs_revision 耗尽 → loop_exhausted）', () => {
  // 最小合法 anima image 蓝图（同 orchestration 套件 MINI_IMAGE_BP 形状；scene 齐备过 checkFieldCompleteness）
  const imageBpProvider: AuthorIntentFn = async () => ({
    blueprint: {
      schema_version: 1,
      media: 'image',
      core: { concept: '黄昏天台的少女', scene: { environment: 'rooftop', lighting: 'golden hour' }, negative: [] },
      media_layer: {
        image: {
          count_gender: ['1girl'],
          pose_action: ['standing'],
          expression: ['smile'],
          scene_anchors: ['rooftop', 'sunset'],
          camera_angle: 'cowboy shot',
        },
      },
    } as any,
    missing: [],
  });

  // anima 7 维 rubric 维度分（与 author-judge.e2e 的 dimScores 同源形状）+ 恒 needs_revision critic
  const dimScores = (v: number) => ({
    'tag-order': v,
    contradiction: v,
    'tag-evidence': v,
    'negative-template': v,
    composition: v,
    'lighting-color': v,
    'aesthetic-vocabulary': v,
  });
  const NEEDS_JSON = JSON.stringify({
    verdict: 'needs_revision',
    dimensionScores: dimScores(50),
    findings: [
      {
        severity: 'major',
        dimension: 'tag-evidence',
        problem: 'ungrounded tags',
        evidence: { tool: 'catalog', query: '1girl', result: 'canonical,n=120' },
        requiredFix: 'replace with canonical tags',
      },
    ],
    praise: [],
  });
  const mockEvidence = {
    catalog: (q: string) => [{ tag: q, kind: 'canonical', count: 1 }],
    aesthetics: (q: string) => ({ concreteness: 'pass', query_len: q.length }),
  };

  it('judgeFeedback 持续 needs_revision + 修正轮耗尽 → loop_exhausted:true（镜像标准路径 P3 口径）', async () => {
    setAuthorIntentProvider(imageBpProvider as any);
    setAuthorJudgeDeps({ criticProvider: async () => NEEDS_JSON, evidenceDeps: mockEvidence } as any);
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') });
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 });
    const v = JSON.parse(
      String(await runTool(ctx, def, { target: 'anima', input: '黄昏天台的少女', judge_mode: 'fast', enrich: false })),
    );
    expect(v.observability.corrections).toBe(2); // 评审闭环跑了整整 2 轮修正
    expect(v.judge).toMatchObject({ verdict: 'needs_revision' }); // 末轮评审仍 needs_revision
    expect(v.advisories).toContain('loop_exhausted:true'); // 此前静默缺失的打点（本回归锁的存在意义）
    expect(v.observability.loopExhausted).toBe(true);
    setAuthorIntentProvider(null);
    setAuthorJudgeDeps(null);
  });
});

// Round7 T6：blueprint_id 路径忽略 enrich 参数（blueprint 分支自带 enrichBlueprint 扩展）——
// 显式 enrich=true 时必须补 advisory 消除静默忽略；不传 enrich（缺省忽略）不打扰
describe('prompt_author blueprint_id enrich advisory (Round7 T6)', () => {
  function savedRepo() {
    const { settings, repoScope } = settingsRepo();
    const repo = createBlueprintRepo({ settings: repoScope } as any);
    repo.save('bp-enrich-check', {
      schema_version: 1,
      media: 'video',
      core: { concept: '三镜头打斗CG', aspect_ratio: '9:16', negative: [] },
      media_layer: {
        video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] },
      },
    } as any);
    return settings;
  }

  beforeEach(() => setAuthorIntentProvider(async () => ({}) as any));
  afterEach(() => setAuthorIntentProvider(null));

  it('blueprint_id + enrich=true → advisory enrich_ignored_blueprint', async () => {
    const ctx = stubCtx({ stream: textStream(BP_JSON) }) as any;
    ctx.settings = savedRepo();
    const def = registerAuthorTool(ctx, { temperature: 0.7 });
    const v = JSON.parse(
      String(
        await runTool(ctx, def, {
          target: 'h3',
          blueprint_id: 'bp-enrich-check',
          input: '修改一个镜头',
          judge_mode: 'off',
          enrich: true,
        }),
      ),
    );
    expect(v.advisories).toContain('enrich_ignored_blueprint');
  });

  it('blueprint_id 不传 enrich → 无 enrich_ignored_blueprint advisory', async () => {
    const ctx = stubCtx({ stream: textStream(BP_JSON) }) as any;
    ctx.settings = savedRepo();
    const def = registerAuthorTool(ctx, { temperature: 0.7 });
    const v = JSON.parse(
      String(
        await runTool(ctx, def, {
          target: 'h3',
          blueprint_id: 'bp-enrich-check',
          input: '修改一个镜头',
          judge_mode: 'off',
        }),
      ),
    );
    expect(v.advisories).not.toContain('enrich_ignored_blueprint');
  });
});
