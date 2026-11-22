# 质量飞轮实施计划（M1-M4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 prompt-author 建立质量飞轮：证据化 LLM 评审进主管线 → 人工反馈通道 → 离线自动优化 harness。

**Architecture:** 在 runStage 规则审计之后插入 EvidenceCritic 评审阶段（rubric 按方言注册，strict 模式带对抗二轮）；feedback store 用 node:sqlite（沿 relations.ts 读写模式）；optimize 为离线 CLI 级模块不注册 agent 工具。全程评审降级永不阻塞出稿。

**Tech Stack:** TypeScript (tsc → dist，ESM)、node:sqlite DatabaseSync、vitest、DSH subagent-provider（评审 LLM 路线）。

**Spec:** `docs/2026-09-08-quality-flywheel-design.md`（本计划逐节对应 spec，执行者两份都读）

## Global Constraints

- 运行时加载 dist：**每次改 src 后、提交前必须 `npm run build`**（plugin AGENTS.md 铁律）；提交只含 src+tests+docs，dist 不进 git
- 全量测试基线：`npx vitest run` 必须 ≥621 passed / 0 failed；类型检查 `npx tsc --noEmit`
- 评审层任何故障（LLM 不可用/超时/schema 不合）→ `judge: { skipped: true }` + advisory，**绝不阻塞出稿**
- 现有 golden 保真测试零破坏：评审不进确定性编译路径（compile/audit 纯函数不动）
- 修正闭环 max 2 轮不变；规则审计 critical 时跳过评审直接进闭环
- `judge` 默认 `'off'`（保守上线）
- 不落图片、不落 API key；input 只存 digest 哈希
- judge 走 DSH subagent-provider（复用 `intent/subagent-provider` 注入），不用 `llm/complete` HTTP 直连
- rubric 阈值进 rubric 不进代码：anima `passThreshold=80`、h3 `75`

---

## File Structure（责任地图）

```
src/pe-framework/eval/
  rubrics/contract.ts      新建   DialectRubric 接口（唯一类型源）
  rubrics/anima.ts         新建   anima 方言 rubric 常量
  rubrics/h3.ts            新建   h3 方言 rubric 常量
  evidence.ts              新建   证据工具桥（catalog/tokenizer/aesthetics 统一接口）
  critic.ts                新建   EvidenceCritic（judgeBlueprint 的替代者）
  judge.ts                 删除   （M1 Task 4 末尾，消费者迁移完后）
src/pe-framework/dialect/
  contract.ts              修改   +rubric?: DialectRubric
  anima.ts / h3.ts         修改   注册各自 rubric
src/pe-framework/pipeline/
  runStage.ts              修改   audit 后插入评审阶段
src/pe-framework/feedback/
  store.ts                 新建   generations + feedback 表
src/tools/
  prompt-author.ts         修改   judge_mode 参数、generation_id/debate/judge 输出
  prompt-feedback.ts       新建   反馈工具
src/pe-framework/optimize/
  harness.ts               新建   scoring 计算（纯函数）
  mutate.ts                新建   变异提案（LLM 调用，离线）
  report.ts                新建   diff 报告渲染
tests/pe-framework/eval/   新建   critic/rubrics/evidence 测试
tests/pe-framework/feedback/store.test.ts      新建
tests/pe-framework/optimize/harness.test.ts    新建
tests/plugin/author-judge.e2e.test.ts          新建
```

---

# M1：证据化评审基座

### Task 1: DialectRubric 契约 + DialectContract 挂载

**Files:**

- Create: `src/pe-framework/eval/rubrics/contract.ts`
- Modify: `src/pe-framework/dialect/contract.ts`（DialectContract 接口尾部）
- Test: `tests/pe-framework/eval/rubrics-contract.test.ts`

**Interfaces:**

- Produces: `interface DialectRubric { dimensions: ReadonlyArray<{ id: string; weight: number; instruction: string }>; severityRules: string; evidenceTools: ReadonlyArray<'catalog' | 'tokenizer' | 'aesthetics'>; passThreshold: number }`
- Produces: `DialectContract` 新可选字段 `rubric?: DialectRubric`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/eval/rubrics-contract.test.ts
import { describe, it, expect } from 'vitest';
import type { DialectRubric } from '../../../src/pe-framework/eval/rubrics/contract.js';
import { getDialect } from '../../../src/pe-framework/dialect/registry.js';

describe('DialectRubric contract', () => {
  it('anima/h3 方言带合法 rubric，权重归一化', () => {
    for (const target of ['anima', 'h3'] as const) {
      const rubric: DialectRubric | undefined = getDialect(target).rubric;
      expect(rubric).toBeDefined();
      const sum = rubric!.dimensions.reduce((s, d) => s + d.weight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      expect(rubric!.passThreshold).toBe(target === 'anima' ? 80 : 75);
      expect(rubric!.dimensions.length).toBeGreaterThanOrEqual(4);
    }
  });
  it('未注册 rubric 的方言缺省 undefined（向后兼容）', () => {
    const dialect = getDialect('sd'); // 或注册表中任一无 rubric 方言
    expect(dialect?.rubric ?? undefined).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/eval/rubrics-contract.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/pe-framework/eval/rubrics/contract.ts
/** 评审 rubric 契约（spec §2.2）：阈值进 rubric 不进代码。 */
export interface DialectRubricDimension {
  id: string; // 如 'tag-order' | 'cross-shot-consistency'
  weight: number; // 归一化权重（Σ=1），score 加权用
  instruction: string; // 注入评委 persona 的评审指令
}

export interface DialectRubric {
  dimensions: ReadonlyArray<DialectRubricDimension>;
  severityRules: string; // blocker/major/minor 判定标准文本
  evidenceTools: ReadonlyArray<'catalog' | 'tokenizer' | 'aesthetics'>;
  passThreshold: number; // 0-100；≥ 此值且无 blocker 才 verdict=pass
}
```

在 `src/pe-framework/dialect/contract.ts` 的 `DialectContract` 接口（`aesthetics?:` 行后）追加：

```ts
  rubric?: import('../eval/rubrics/contract.js').DialectRubric
```

- [ ] **Step 4: 跑测试通过**

Run: `npx vitest run tests/pe-framework/eval/rubrics-contract.test.ts`
Expected: anima 用例 PASS；无 rubric 方言用例 PASS；h3 用例仍 FAIL（Task 4 补内容）

- [ ] **Step 5: 提交 + 构建**

```bash
npm run build && npx tsc --noEmit
git add src/pe-framework/eval/rubrics/contract.ts src/pe-framework/dialect/contract.ts tests/pe-framework/eval/rubrics-contract.test.ts
git commit -m "feat(eval): DialectRubric 契约 + DialectContract.rubric 可选字段 (spec §2.2)"
```

---

### Task 2: 证据工具桥 evidence.ts

**Files:**

- Create: `src/pe-framework/eval/evidence.ts`
- Test: `tests/pe-framework/eval/evidence.test.ts`

**Interfaces:**

- Consumes: `catalog_search` 的查询函数（`dialect/anima-catalog.ts` 只读级联）、`audit/tokenizer-h3.ts` 计数、`aesthetics/check.ts`
- Produces: `createEvidenceBridge(opts: { target: Target; available: ReadonlyArray<'catalog'|'tokenizer'|'aesthetics'> }): EvidenceBridge`，其中 `EvidenceBridge = { list(): ToolId[]; async query(tool: ToolId, query: string): Promise<EvidenceResult> }`；`EvidenceResult = { tool: ToolId; query: string; summary: string; ok: boolean }`

- [ ] **Step 1: 写失败测试**（mock 三个底层依赖，验证：可用列表过滤、查询分发、单工具异常不抛只降级）

```ts
// tests/pe-framework/eval/evidence.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createEvidenceBridge } from '../../../src/pe-framework/eval/evidence.js';

describe('evidence bridge', () => {
  it('只暴露 available 里声明的工具', () => {
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['catalog', 'aesthetics'],
      deps: { catalog: vi.fn(), tokenizer: vi.fn(), aesthetics: vi.fn() },
    });
    expect(bridge.list()).toEqual(['catalog', 'aesthetics']);
  });
  it('query 分发到底层依赖并包装为 EvidenceResult', async () => {
    const catalog = vi.fn().mockResolvedValue({ hits: [{ tag: 'science fiction', n: 3 }] });
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['catalog'],
      deps: { catalog, tokenizer: vi.fn(), aesthetics: vi.fn() },
    });
    const r = await bridge.query('catalog', 'cyberpunk');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('science fiction');
    expect(catalog).toHaveBeenCalledWith('cyberpunk');
  });
  it('底层抛错 → ok=false + summary 含错误摘要，不抛', async () => {
    const catalog = vi.fn().mockRejectedValue(new Error('db locked'));
    const bridge = createEvidenceBridge({
      target: 'anima',
      available: ['catalog'],
      deps: { catalog, tokenizer: vi.fn(), aesthetics: vi.fn() },
    });
    const r = await bridge.query('catalog', 'x');
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('db locked');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/eval/evidence.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（`deps` 参数注入三个底层函数的适配器；真实装配在 Task 6 的 runStage 处完成——适配器内部分别调 `anima-catalog` 的级联查询、`tokenizer-h3` 的 token 计数、`aesthetics/check` 的检查函数，并把结果序列化成 ≤300 字摘要）

- [ ] **Step 4: 跑测试通过** → `npx vitest run tests/pe-framework/eval/evidence.test.ts` PASS

- [ ] **Step 5: 提交** `git commit -m "feat(eval): 证据工具桥 evidence.ts (spec §2.1)"`（build 后）

---

### Task 3: EvidenceCritic（critic.ts，替换 judge.ts 路线）

**Files:**

- Create: `src/pe-framework/eval/critic.ts`
- Modify: `src/pe-framework/intent/subagent-provider.ts`（导出可复用的 subagent 调用封装，若现签名不满足 critic 需要的 schema 约束输出则加参数，不改既有消费者）
- Modify/Delete: `src/pe-framework/eval/judge.ts`（本 Task 先保留，Task 4 末尾删除）
- Test: `tests/pe-framework/eval/critic.test.ts`

**Interfaces:**

- Consumes: `DialectRubric`（Task 1）、`EvidenceBridge`（Task 2）、subagent-provider 注入
- Produces: `judgeReview(input: { target: Target; rubric: DialectRubric; bridge: EvidenceBridge; compiled: unknown; ruleGates: AuditGate[]; originalIntent: string; provider: SubagentProvider }): Promise<CriticOutcome>`；`CriticOutcome = { verdict: 'pass' | 'needs_revision'; score: number; findings: CriticFinding[]; praise: string[]; skipped?: false } | { skipped: true; reason: string }`；`CriticFinding = { severity: 'blocker'|'major'|'minor'; dimension: string; problem: string; evidence: { tool: string; query: string; result: string }; requiredFix: string }`

- [ ] **Step 1: 写失败测试**（mock provider，全路径）

```ts
// tests/pe-framework/eval/critic.test.ts
import { describe, it, expect, vi } from 'vitest';
import { judgeReview } from '../../../src/pe-framework/eval/critic.js';
import { ANIMA_RUBRIC } from '../../../src/pe-framework/eval/rubrics/anima.js';

const okFindings = { verdict: 'pass', score: 92, findings: [], praise: ['顺序正确'] };
const badFindings = {
  verdict: 'needs_revision',
  score: 61,
  findings: [
    {
      severity: 'blocker',
      dimension: 'tag-evidence',
      problem: 'cyberpunk 无证据',
      evidence: { tool: 'catalog', query: 'cyberpunk', result: 'miss' },
      requiredFix: '换 science fiction',
    },
  ],
  praise: [],
};

function makeProvider(reply: unknown) {
  return vi.fn().mockResolvedValue(JSON.stringify(reply));
}

describe('EvidenceCritic', () => {
  it('规则审计含 critical → 不调 LLM 直接返回 skipped', async () => {
    const provider = makeProvider(okFindings);
    const out = await judgeReview({
      target: 'anima',
      rubric: ANIMA_RUBRIC,
      bridge: { list: () => [], query: vi.fn() },
      compiled: {},
      ruleGates: [{ rule: 'field_order', level: 'critical', detail: 'x' }],
      originalIntent: '一只猫',
      provider,
    });
    expect(out.skipped).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });
  it('LLM 输出合法 → 原样返回 verdict/score/findings', async () => {
    const out = await judgeReview({
      target: 'anima',
      rubric: ANIMA_RUBRIC,
      bridge: { list: () => ['catalog'], query: vi.fn() },
      compiled: {},
      ruleGates: [],
      originalIntent: 'x',
      provider: makeProvider(okFindings),
    });
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ verdict: 'pass', score: 92 });
  });
  it('verdict=pass 但 score < passThreshold 或含 blocker → 强制 needs_revision', async () => {
    const out = await judgeReview({
      target: 'anima',
      rubric: ANIMA_RUBRIC,
      bridge: { list: () => [], query: vi.fn() },
      compiled: {},
      ruleGates: [],
      originalIntent: 'x',
      provider: makeProvider({ ...okFindings, score: 70 }),
    });
    expect(out.verdict).toBe('needs_revision');
  });
  it('schema 不合 / provider 抛错 → skipped=true + reason', async () => {
    const bad = await judgeReview({
      target: 'anima',
      rubric: ANIMA_RUBRIC,
      bridge: { list: () => [], query: vi.fn() },
      compiled: {},
      ruleGates: [],
      originalIntent: 'x',
      provider: makeProvider({ foo: 1 }),
    });
    expect(bad.skipped).toBe(true);
    const thrown = await judgeReview({
      target: 'anima',
      rubric: ANIMA_RUBRIC,
      bridge: { list: () => [], query: vi.fn() },
      compiled: {},
      ruleGates: [],
      originalIntent: 'x',
      provider: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    expect(thrown.skipped).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/eval/critic.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 critic.ts**。要点：
  1. persona = rubric.dimensions[].instruction + rubric.severityRules 拼接；schema = CriticOutcome 的 JSON Schema（dimensions 作为合法 dimension 枚举注入）
  2. 调 provider（subagent-provider 封装）；输出 stripFences（沿用 judge.ts 现有工具函数，迁过来）+ JSON.parse + 逐字段校验，任何不符走 skipped
  3. 防御归一：`verdict=pass` 但 `score < rubric.passThreshold` 或 findings 含 blocker → 改判 needs_revision
  4. findings.evidence 逐条校验必填（spec 铁律：无 evidence 的 findings 丢弃并 console 摘要）
  5. 全函数 try/catch 包裹：任何异常 → `{ skipped: true, reason }`

- [ ] **Step 4: 跑测试通过** → `npx vitest run tests/pe-framework/eval/critic.test.ts` PASS

- [ ] **Step 5: 提交** `git commit -m "feat(eval): EvidenceCritic 证据化评审 (spec §2.1)"`（build 后）

---

### Task 4: anima / h3 rubric 内容 + judge.ts 退役

**Files:**

- Create: `src/pe-framework/eval/rubrics/anima.ts`
- Create: `src/pe-framework/eval/rubrics/h3.ts`
- Modify: `src/pe-framework/dialect/anima.ts`（注册 `rubric: ANIMA_RUBRIC`）
- Modify: `src/pe-framework/dialect/h3.ts`（注册 `rubric: H3_RUBRIC`）
- Delete: `src/pe-framework/eval/judge.ts`
- Modify: 全仓 grep `judgeBlueprint` / `eval/judge.js` 的消费者，逐一迁移到 critic.ts 或删除调用
- Test: Task 1 的 rubrics-contract 测试全绿 + `npx vitest run` 全量

**Interfaces:**

- Produces: `export const ANIMA_RUBRIC: DialectRubric`、`export const H3_RUBRIC: DialectRubric`

- [ ] **Step 1: 写 anima rubric**（dimensions 权重 Σ=1，指令写进 instruction，内容按 spec §2.2 表格）：

```ts
// src/pe-framework/eval/rubrics/anima.ts
import type { DialectRubric } from './contract.js';

export const ANIMA_RUBRIC: DialectRubric = {
  dimensions: [
    {
      id: 'tag-order',
      weight: 0.2,
      instruction: '检查 tag 顺序是否符合权重序：质量→主体→角色→特征→动作→构图→背景。顺序错=minor，整体混乱=major。',
    },
    {
      id: 'contradiction',
      weight: 0.25,
      instruction:
        '检测 tag 自相矛盾（如 1girl+multiple boys、smile+crying）、正负面提示词互相冲突。任何矛盾=blocker。',
    },
    {
      id: 'tag-evidence',
      weight: 0.2,
      instruction:
        '抽查非通用 tag 在 catalog 的证据（用 catalog 工具）；miss 的 tag 给出 canonical 替代。无证据 tag>2 个=blocker。',
    },
    {
      id: 'negative-template',
      weight: 0.15,
      instruction: '负面提示词须含标准模板 + 针对本图主体的排除项；缺模板=major，缺主体排除=minor。',
    },
    {
      id: 'aesthetics',
      weight: 0.2,
      instruction:
        '风格/氛围词的具体性（用 aesthetics 工具）：抽象词（beautiful）占比过高=major；正面具体化建议写进 requiredFix。',
    },
  ],
  severityRules: 'blocker=出图必然错误或严重偏离；major=明显降低质量但不致命；minor=可改进瑕疵。',
  evidenceTools: ['catalog', 'aesthetics'],
  passThreshold: 80,
};
```

- [ ] **Step 2: 写 h3 rubric**（同构；dimensions：`shot-structure` 0.2（六段式+主体→运动/镜头→场景→氛围语句序）、`shot-increment` 0.2（相邻镜头语义信息增量，冗余=major、完全重复=blocker）、`cross-shot-consistency` 0.3（同角色跨 shots 描述/ref 矛盾=blocker——spec 最高价值点）、`duration-fit` 0.1（镜头时长与内容量匹配）、`pacing` 0.1、`atmosphere-coupling` 0.1（氛围段与画面段呼应）；evidenceTools `['tokenizer','aesthetics']`；passThreshold `75`；severityRules 同 anima 措辞）

- [ ] **Step 3: 注册**——两个方言文件的 DialectContract 对象上加 `rubric: ANIMA_RUBRIC` / `rubric: H3_RUBRIC`

- [ ] **Step 4: judge.ts 退役**——`grep -r "judgeBlueprint\|eval/judge" src tests`，消费者迁移（预期只有 `tests/eval/judge.test.ts` 与可能的 eval 触发点；测试文件删除，触发点改走 critic 或移除）；删除 `src/pe-framework/eval/judge.ts`

- [ ] **Step 5: 验证 + 提交**

```bash
npx vitest run tests/pe-framework/eval/rubrics-contract.test.ts   # 4 用例全 PASS
npx vitest run                                                     # ≥621 passed 0 failed
npm run build && npx tsc --noEmit
git add -A && git commit -m "feat(dialect): anima/h3 rubric 注册 + judge.ts 退役 (spec §2.2, §9 迁移事实)"
```

---

### Task 5: runStage 评审阶段 + strict 对抗二轮

**Files:**

- Modify: `src/pe-framework/pipeline/runStage.ts`（audit 阶段后）
- Modify: `src/pe-framework/pipeline/types.ts`（阶段输出类型 +judge）
- Test: `tests/pe-framework/pipeline/judge-stage.test.ts`

**Interfaces:**

- Consumes: `judgeReview`（Task 3）、`getDialect(target).rubric`（Task 4）、evidence 适配器装配（Task 2 适配器在此接真实依赖）
- Produces: runStage 选项 `judge?: 'off' | 'fast' | 'strict'`（缺省 'off'）；阶段输出新增 `judge: { verdict, score, findings, praise } | { skipped: true, reason } | undefined`（off/无 rubric 方言 = undefined）与 `debate?: DebateRound[]`；`DebateRound = { round: number; reviewer: { findings: CriticFinding[]; score: number }; reviser?: { changes: string[]; rebuttals: Array<{ finding_id: string; rebuttal: string; evidence: string }> } }`

- [ ] **Step 1: 写失败测试**（mock provider + mock evidence 依赖，覆盖 6 分支）

```ts
// tests/pe-framework/pipeline/judge-stage.test.ts
// 分支矩阵（每个一条 it）：
// 1 judge=off → 输出 judge=undefined，零 LLM 调用
// 2 fast + 评审 pass → 出稿，debate 无 reviser
// 3 fast + needs_revision → 进现有修正闭环（repair_rounds 计数+1，feedback 含 findings.requiredFix）
// 4 fast + skipped → 照常出稿，judge.skipped=true，advisories 含 judge_skipped
// 5 strict + 首轮 needs_revision + 复审 pass → 出稿，debate 两轮、reviser 带 changes
// 6 strict + 复审仍 needs_revision → 计入修正闭环，loop_exhausted 行为与现状一致（max 2）
```

每个 it 用 helpers.ts 现有的 mock provider 模式（参考 `tests/plugin/helpers.ts`），断言：runStage 返回的 judge/debate 字段形状、provider 调用次数（分支 1=0 次、5=2 次、6=3 次：首评+修正+复审）。

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run tests/pe-framework/pipeline/judge-stage.test.ts` FAIL

- [ ] **Step 3: 实现**。要点：
  1. 插入点：audit 返回后；`if (judgeMode === 'off' || !rubric) → judge: undefined`（零改动路径）
  2. 规则审计含 critical gate → 直接走现有修正闭环，不调评审
  3. fast：`judgeReview(stage:'first')` 一次；needs_revision → feedback = findings.map(f=>`[${f.severity}] ${f.requiredFix}`) 并入现有闭环 feedback 拼接
  4. strict：修正稿产出后调 `judgeReview(stage:'revision')`——revision prompt 只含首轮 findings + 修正 changes，验证关闭/反驳成立，非全量重评；rebuttal 解析自修正稿结构化字段
  5. evidence 适配器装配：`createEvidenceBridge({ target, available: rubric.evidenceTools, deps: 真实依赖 })`；某依赖加载失败 → 从 available 剔除 + advisory `evidence_partial`（spec §2.1）
  6. 全评审包裹 try/catch → skipped 路径，advisories push `{ code: 'judge_skipped', ... }`

- [ ] **Step 4: 跑测试 + 全量回归** → 分支测试 PASS；`npx vitest run` ≥621 passed 0 failed（golden 零破坏在此确认）

- [ ] **Step 5: 提交** `git commit -m "feat(pipeline): runStage 评审阶段 + strict 对抗二轮 (spec §2.3, §2.4)"`（build 后）

---

### Task 6: prompt-author 工具面（judge_mode / generation_id / debate）

**Files:**

- Modify: `src/tools/prompt-author.ts`
- Test: `tests/plugin/author-judge.e2e.test.ts`

**Interfaces:**

- Consumes: runStage 新选项（Task 5）
- Produces: 工具入参 `judge_mode?: 'off'|'fast'|'strict'`；Envelope 顶层 `generation_id: string`（成功时）、`debate?: DebateRound[]`、`judge?: CriticOutcome`；e2e 测试可从此任务导入 envelope 断言 helper

- [ ] **Step 1: 写失败 e2e**（mock provider）：

```ts
// tests/plugin/author-judge.e2e.test.ts
// it: 默认（不传 judge_mode）→ envelope.judge === undefined，generation_id 存在且匹配 /^gen_\d+_\w+$/
// it: judge_mode='fast' + mock 评审 pass → envelope.judge.verdict === 'pass'，debate.length === 1
// it: judge_mode='strict' + 首评不过复审过 → envelope.debate[1].reviser.rebuttals/changes 存在
// it: judge 模式 LLM 全挂 → ok 仍为 true，judge.skipped === true，advisories 含 judge_skipped
// it: audit_only=true → 不触发评审（provider 调用次数仅 intent 拆解）
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 prompt-author.ts**：参数透传 judge_mode（缺省 'off'）；成功路径生成 `gen_<Date.now()>_<rand36>`；debate/judge 从 runStage 输出透传到 Envelope；audit_only 分支跳过评审参数

- [ ] **Step 4: 跑测试 + 全量** → e2e PASS；`npx vitest run` 全绿

- [ ] **Step 5: 提交** `git commit -m "feat(tools): prompt-author 评审参数与 Envelope 扩展 (spec §2.4, §3.1)"`（build 后）

---

# M2：人工反馈通道

### Task 7: feedback store（node:sqlite）

**Files:**

- Create: `src/pe-framework/feedback/store.ts`
- Test: `tests/pe-framework/feedback/store.test.ts`

**Interfaces:**

- Consumes: `node:sqlite DatabaseSync`（模式对齐 `anima-knowledge/relations.ts`：每次操作开/关连接）
- Produces:
  - `recordGeneration(dbPath: string, g: GenerationRow): void`，`GenerationRow = { id, created_at, target, variant, judge_mode, input_digest, final_output, judge_score?, judge_verdict?, debate_json?, repair_rounds }`
  - `recordFeedback(dbPath: string, f: FeedbackRow): { ok: true } | { ok: false; code: 'generation_not_found' }`，`FeedbackRow = { generation_id, rating: 1-5, tags?: string[], notes?, actual_output_path? }`
  - `listFeedback(dbPath, q: { target?, min_rating?, max_rating?, limit? }): FeedbackRow[]`
  - `statsFeedback(dbPath, target?): { count, avgRating, histogram: number[], topTags: Array<{ tag, n }> }`
  - `pruneGenerations(dbPath, retentionDays = 90): number`（写入时懒调用）
- 常量：`DEBATE_JSON_MAX = 64 * 1024`（超长裁 minor findings 保 blocker/major，置 `truncated:true`）、`FINAL_OUTPUT_MAX = 32 * 1024`

- [ ] **Step 1: 写失败测试**（内存/临时文件 DB）：record+get 往返、generation_not_found、64KB 裁剪（构造超长 debate_json 断言 blocker 保留 + truncated 标记）、list 过滤（target/min/max/limit）、stats 聚合（直方图 + topTags）、prune 删旧留新、联查「评委分 vs 人工分」（recordGeneration(judge_score=80) + recordFeedback(rating=4) 后 join 返回对齐对）
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现**：建表 `generations`/`feedback`（§3.2 schema 原样）；每次 `recordGeneration`/`recordFeedback` 前调 `pruneGenerations`（懒清理）；字段裁剪在写入前
- [ ] **Step 4: 跑测试通过 + 全量**
- [ ] **Step 5: 提交** `git commit -m "feat(feedback): node:sqlite 反馈存储 (spec §3.2)"`（build 后）

### Task 8: prompt-feedback 工具 + 文档同步

**Files:**

- Create: `src/tools/prompt-feedback.ts`
- Modify: `src/plugin/index.ts`（注册新工具）
- Modify: preset `docs/troubleshooting.md`（错误表加 `generation_not_found`）
- Modify: preset `AGENTS.md`（Envelope 新字段说明）
- Test: `tests/plugin/prompt-feedback.test.ts`

**Interfaces:**

- Consumes: store.ts（Task 7）
- Produces: agent 工具 `prompt_feedback`，入参 `action: 'record'|'list'|'get'|'stats'` + 各 action 参数（spec §3.3 原样）；record 成功/失败均 envelope（ok=false 时 code=`generation_not_found`）

- [ ] **Step 1: 写失败测试**：四 action 各一 it（mock dbPath 指向临时文件，先用 store.recordGeneration 造数据）；record 不存在 id → ok=false + code
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现工具 + plugin/index.ts 注册**（照 `prompt-audit.ts` 的工具定义模式抄结构）
- [ ] **Step 4: 文档同步**——troubleshooting 错误表与 AGENTS.md 补 `generation_not_found`、`prompt_feedback`、Envelope 新字段（spec §3.2「文档同步义务」，M2 验收项）
- [ ] **Step 5: 跑全量 + 提交**

```bash
npx vitest run && npm run build
git add src/tools/prompt-feedback.ts src/plugin/index.ts tests/plugin/prompt-feedback.test.ts
git commit -m "feat(tools): prompt_feedback 工具 (spec §3.3)"
# 文档单文件提交（preset 层路径不在插件 git 内则按 preset 提交惯例处理）
```

**M1+M2 验收门**（进入 M3 前）：`npx vitest run` ≥621+新增全过、`npx tsc --noEmit` 干净、golden 零破坏、评审降级路径实测（手动断 LLM 跑一次 author 确认 skipped 出稿）。

---

# M3：scoring harness（不跑迭代）

### Task 9: optimize/harness.ts

**Files:**

- Create: `src/pe-framework/optimize/harness.ts`
- Create: `assets/knowledge/anima/evalset/README.md`、`assets/knowledge/minimax-h3-prompt/evalset/README.md`（格式说明占位，数据后补）
- Test: `tests/pe-framework/optimize/harness.test.ts`

**Interfaces:**

- Consumes: feedback store（Task 7）、critic（Task 3）
- Produces: `loadEvalset(dbPath, target, opts?): Promise<EvalCase[]>`（三层来源 L1/L2/L3，字段 `tier: 'L1'|'L2'|'L3'`）；`scoreGeneration(c: EvalCase, m: { judgeScore: number; rulePass: boolean; humanRating?: number }): number`（`0.5*judge + 0.3*rule + 0.2*human`，无 human 时 `(0.5*judge+0.3*rule)/0.8` 归一）；`coldStartReady(dbPath, target): Promise<{ ready: boolean; l1: number; l2: number; need: string }>`（门槛 L1≥50 或 L1+L2≥80）

- [ ] **Step 1: 写失败测试**：scoreGeneration 三分支（有 human / 无 human 归一 / 极值夹取 0-100）；loadEvalset 分层 mock（L1 高分正例低分负例、L2 debate blocker 修复案例、L3 golden fixture 指针）；coldStartReady 三态（<50 全缺 / L1=50 ready / L1=30+L2=50 ready）
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现**（纯函数 + store 查询组合；evalset README 写明 case JSON 格式：`{ id, tier, input, expected_digest?, human_rating?, source_generation_id? }`）
- [ ] **Step 4: 跑测试通过 + 全量**
- [ ] **Step 5: 提交** `git commit -m "feat(optimize): scoring harness 纯函数层 (spec §4.2, §4.4)"`（build 后）

---

# M4：迭代循环 + 报告（代码交付；迭代执行 gated）

### Task 10: optimize/mutate.ts + report.ts（CLI 级）

**Files:**

- Create: `src/pe-framework/optimize/mutate.ts`
- Create: `src/pe-framework/optimize/report.ts`
- Test: `tests/pe-framework/optimize/mutate.test.ts`、`report.test.ts`

**Interfaces:**

- Consumes: harness（Task 9）、subagent-provider（变异 LLM）
- Produces:
  - `proposeMutation(input: { negativeCases: EvalCase[]; debates: DebateRound[]; currentPersona: string; provider }): Promise<PersonaCandidate>`，`PersonaCandidate = { id, diff: string, rationale: string, targetsFailures: string[] }`
  - `evaluateCandidate(c: PersonaCandidate, evalset: EvalCase[], runAuthor: (input: string) => Promise<{ judgeScore: number; rulePass: boolean }>): Promise<CandidateReport>`，`CandidateReport = { candidateId, perDimension: Record<string, number>, improved: string[], regressed: string[], pairedDelta: number, significant: boolean }`（配对比较：delta 超过评测集评分标准差 2×SE 才 significant）
  - `renderMarkdown(reports: CandidateReport[]): string`
- 铁律：候选**不自动生效**；本模块不注册 agent 工具（spec §0.3）

- [ ] **Step 1: 写失败测试**：proposeMutation mock provider 断言 prompt 含负例+findings；evaluateCandidate 用固定 evalset 断言配对显著性判定（构造显著/不显著两组）；renderMarkdown 含逐维得分与回归警告
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现**（evaluateCandidate 对 incumbent 与 candidate 各跑一遍 evalset；mutation prompt 引用 spec §4.3 循环）
- [ ] **Step 4: 跑测试通过 + 全量 + build**
- [ ] **Step 5: 提交** `git commit -m "feat(optimize): 变体迭代与 diff 报告（离线，人审闸门）(spec §4.3)"`

### Task 11: M4 冷启动验收（无代码，运行验证）

- [ ] 对两个 target 各跑 `coldStartReady` → 预期 `{ ready: false }`，报告 l1/l2 实数
- [ ] 手动用 3 条 golden 用例走一遍 harness→evaluateCandidate→renderMarkdown 链路（mock provider），确认报告可读
- [ ] 在 `docs/plans/TASK_TRACKING.md` 登记四里程碑完成状态
- [ ] 提交 `git commit -m "docs: 质量飞轮 M1-M4 完成登记 (spec §8)"`

---

## Self-Review 记录

1. **Spec 覆盖**：§2.1→T3、§2.2→T1/T4、§2.3/§2.4→T5、§2.5→T5 分支4+T6 分支4、§3.1→T6、§3.2→T7、§3.3→T8、文档同步→T8 Step4、§4.2/§4.4→T9、§4.3→T10、§6 降级→T5/T7、§7 测试→各任务、§8 里程碑→T11。无缺口。
2. **占位符**：T4 Step2 的 h3 rubric 以结构+权重+判则描述（内容为规格而非代码占位，权重数值已全部给出）；T9 evalset README 为数据占位符说明（数据本身 gated by §4.4 冷启动，属预期）。无 TBD/类占位。
3. **类型一致性**：`DialectRubric`（T1 定义，T3/T4/T5 消费）、`CriticFinding`/`DebateRound`（T3/T5 定义，T6/T7/T10 消费）签名一致；`judge_mode`/`generation_id` 命名全文统一。
