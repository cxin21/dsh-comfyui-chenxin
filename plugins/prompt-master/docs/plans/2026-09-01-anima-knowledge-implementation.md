# Anima 知识资产管理面吸收 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐插件对 anima-prompt-v1 skill 的知识资产管理面吸收——relation 生命周期（G1）、author 载荷投影（G2）、browse/stats/verify 深检（G3）、catalog 重建后的句柄刷新与重新对账（G4）、candidate/阈值契约标记（G5）、subject 校验（G6）、单模式/过滤查询（G7）。

**Architecture:** 三批增量：第一批（G4/G3/G5）在现有 `anima-catalog.ts` 上加 mtime 刷新 + 新建 `anima-knowledge/{browse,verify}.ts` + catalog_search 输出投影；第二批（G2）扩展 `compileAnima` 返回值并投影 Envelope；第三批（G1/G7）新建 `anima-knowledge/relations.ts`（可写 overlay 库 + 校验链）+ `catalog_relations` 工具 + CatalogQueryOptions 扩展。

**Tech Stack:** TypeScript（NodeNext/ES2022）、node:sqlite（DatabaseSync 只读 catalog + 读写 overlay）、vitest、@deepseek-ai/{cordis,dsh-tools,dsh-settings}。

**Spec:** `docs/2026-09-01-anima-knowledge-spec.md`（同目录）

## Global Constraints

- 插件根 `$P` = `C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`
- 测试：`Push-Location $P; npx vitest run <file>`；全量 `npx vitest run`（400 基线）；构建 `npm run build`
- git 根 = preset 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`
- **catalog（tag-catalog.sqlite）恒只读**；relation overlay（temp/anima-prompt-v1/relation-overlay.sqlite）独立可写
- **接口红线（spec §5）**：只用已验证接口（node:sqlite 只读/读写、statSync、ctx.logger、resolveKnowledgePath、randomUUID/createHash）；新接口需求 → 停下验证
- **schemastery 禁止 `.optional()`**（无 default 即可选）
- 纯函数层零日志；工具层 `ctx.logger?.info?.()` 摘要级（不含正文）
- **fidelity 52 测试任何批次后保持全绿**；golden（positive/negative 逐字节）不允许变化——G2 的 segments/phaseStatus 是附加投影
- overlay 库 schema（第三批）：`proposals(proposal_id TEXT PRIMARY KEY, source_tag TEXT, target_tag TEXT, relation TEXT, confidence REAL, note TEXT, model TEXT, status TEXT DEFAULT 'candidate', created_at INTEGER)`

---

### Task 1: G4 catalog 句柄刷新 + 重新对账

**Files:**

- Modify: `src/pe-framework/dialect/anima-catalog.ts`（db() 加 mtime 检测；新增 `lastManifestCheck()`）
- Test: `tests/pe-framework/dialect/anima-catalog-refresh.test.ts`（新增）

**Interfaces:**

- Consumes: 现有 `verifyManifestOnce()`/`assertAnimaCatalog`/`catalogPath`/`closeCatalog`
- Produces:
  - `export function lastManifestCheck(): { ok: boolean; reason?: string } | undefined`（undefined = 未对账过）
  - db() 打开时：statSync mtime 与缓存不同 → close + `_manifestChecked=false` + 重开 + 重新对账

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/dialect/anima-catalog-refresh.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setCatalogPath,
  closeCatalog,
  classifyTag,
  lastManifestCheck,
} from '../../../src/pe-framework/dialect/anima-catalog.js';

// fixture：最小 sqlite 无法徒手建——用真实 catalog 副本太大；
// 改用 mtime 语义测试：setCatalogPath 指向同一真实库，仅验证 lastManifestCheck 存在且形状正确；
// mtime 变化 → reopen 的行为用 vi.mock('node:fs') 的 statSync 间隔桩测试（见 Step 3 说明）。
describe('G4 catalog refresh', () => {
  it('lastManifestCheck shape', () => {
    setCatalogPath(undefined); // 回落默认（真实库）
    classifyTag('1girl'); // 触发首开 + 对账
    const s = lastManifestCheck();
    expect(s).toBeDefined();
    expect(typeof s!.ok).toBe('boolean');
  });
});
```

> mtime→reopen 的行为测试用 `vi.mock` 拦截 `node:fs` 的 statSync 返回可变 mtime（两段式：首次 m1，classifyTag 后改 m2，再 classifyTag 断言 db 被重开——可通过 spy close 调用或 manifest 重对账 warn 触发观察）。执行者以「能确定性断言」为准编写；若 mock node:sqlite + statSync 过于脆弱，降级为「导出 `_testOnlyState()` 返回 {_db 存在性, _lastMtimeMs}」内部探针断言（允许，注明）。

- [ ] **Step 2: 确认失败 → Step 3: 实现**

```ts
// anima-catalog.ts 改动点（保留现有全部导出）：
let _lastMtimeMs = 0;
let _lastManifest: { ok: boolean; reason?: string } | undefined;

export function lastManifestCheck() {
  return _lastManifest;
}

function verifyManifestOnce(): void {
  if (_manifestChecked) return;
  _manifestChecked = true;
  const r = assertAnimaCatalog();
  _lastManifest = r.ok ? { ok: true } : { ok: false, reason: r.reason };
  if (!r.ok) console.warn(`[prompt-master] ${r.reason}：资产与 golden 基线不同，请 re-run fidelity capture`);
}

function db(): DatabaseSync {
  const path = catalogPath();
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    /* 打开前缺失由 assert 报 */
  }
  if (_db && mtime !== _lastMtimeMs) {
    _db.close();
    _db = null;
    _manifestChecked = false; // 重新对账
  }
  if (!_db) {
    verifyManifestOnce();
    _db = new DatabaseSync(path, { readOnly: true });
    _lastMtimeMs = mtime;
  }
  return _db;
}
```

- [ ] **Step 4: 通过 + 全量 + 提交**

Run: `npx vitest run tests/pe-framework/dialect/anima-catalog-refresh.test.ts` → PASS；`npm run build` exit 0；全量绿

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G4 catalog handle refresh on mtime change + manifest re-check"
```

---

### Task 2: G3 browse/stats/verify（`anima-knowledge/`）

**Files:**

- Create: `src/pe-framework/anima-knowledge/browse.ts`
- Create: `src/pe-framework/anima-knowledge/verify.ts`
- Test: `tests/pe-framework/anima-knowledge/browse-verify.test.ts`

**Interfaces:**

- Consumes: `db()`/`normalizeTag`/`CatalogHit`（anima-catalog.ts——需把 db/ftsQuery 导出或经内部 import；**执行者先 read anima-catalog.ts 定导入方式**，必要时新增 `export function queryCatalogInternal(sql, params)` 避免导出 _db）
- Produces:
  - `export function browseCatalog(opts?: { category?: string; source?: string; limit?: number }): CatalogHit[]`
  - `export function catalogStats(): { records: number; names: number; ftsRows: number }`
  - `export interface VerifyCheck { name: string; ok: boolean; detail?: string }`
  - `export interface VerifyResult { ok: boolean; checks: VerifyCheck[] }`
  - `export function verifyCatalog(): VerifyResult`（① checksum ② COUNT(fts)==COUNT(names) ③ 4 表存在 records/names/catalog_fts/sources）

- [ ] **Step 1: 失败测试（fixture：真实库只读跑 browse/stats/verify 的正向断言 + mock/小库跑失败分支）**

```ts
// tests/pe-framework/anima-knowledge/browse-verify.test.ts
// 正向（真实库，只读）：browse limit=3 → 3 hits 全含 usage_count；stats 三计数 > 0 且 records≈1.37M 量级；verifyCatalog().ok === true
// 失败分支（tmp 小库 or mock）：verifyCatalog 对缺 FTS 表/行数不齐 → checks 含对应失败项
```

> 真实库的 verify 正向跑一次 sha256 秒级——vitest.config.ts 已 30s 超时，可接受。失败分支用 tmp fixture（Task 2 of redesign 已有 fixture 模式参考 `tests/pe-framework/resources/manifest.test.ts`）。

- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过**

- [ ] **Step 5: 构建 + 全量 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/anima-knowledge plugins/prompt-master/tests/pe-framework/anima-knowledge
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G3 catalog browse/stats/verify deep checks"
```

---

### Task 3: G5 candidate/阈值 advisory + G4 manifest 可见（catalog_search 扩展）

**Files:**

- Modify: `src/tools/catalog-search.ts`（hits 投影 candidate；顶层 advisory + manifest 状态）
- Test: `tests/plugin/catalog-search.test.ts`（追加用例）

**Interfaces:**

- Consumes: `lastManifestCheck()`（Task 1）；现有 searchCatalog
- Produces: catalog_search 输出形状扩展：
  - `hits[].candidate: boolean`（= match_type==='fuzzy'）
  - 顶层 `advisories?: string[]`（fuzzy 且 usage_count<1000 → 'fuzzy_below_threshold: usage_count=N'）
  - 顶层 `manifest: { ok: boolean; reason?: string } | undefined`

- [ ] **Step 1: 失败测试（追加到现有 catalog-search.test.ts）**

```ts
it('G5: fuzzy hits carry candidate=true; canonical without', async () => {
  const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 3 })));
  for (const h of raw.hits) expect(h.candidate).toBe(h.match_type === 'fuzzy');
});
it('G5: fuzzy_below_threshold advisory when usage_count < 1000', async () => {
  // 用会触发 fuzzy 且低 usage 的 tag（执行者从 golden fixtures 找实证 tag；或直接断言 advisory 数组存在性语义）
  const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 5 })));
  const lowUse = (raw.hits ?? []).some((h: any) => h.match_type === 'fuzzy' && (h.usage_count ?? 0) < 1000);
  if (lowUse) expect((raw.advisories ?? []).some((a: string) => a.includes('fuzzy_below_threshold'))).toBe(true);
});
it('G4: manifest status surfaced in output', async () => {
  const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: '1girl' })));
  expect(raw.manifest).toBeDefined();
  expect(typeof raw.manifest.ok).toBe('boolean');
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现（hits.map 加 candidate；advisories 数组构建；manifest = lastManifestCheck()）→ Step 4: 通过**

- [ ] **Step 5: 全量 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/tools/catalog-search.ts plugins/prompt-master/tests/plugin/catalog-search.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G5 candidate/threshold advisory + G4 manifest visibility in catalog_search"
```

---

### Task 4: G2 segments/phaseStatus/metadata（compileAnima 扩展）

**Files:**

- Modify: `src/pe-framework/dialect/anima.ts`（compileAnima 返回值扩展；citations 补 source 查询）
- Test: `tests/plugin/compile-anima.test.ts`（追加）+ `tests/fidelity/anima-brief-golden.test.ts`（回归确认不变）

**Interfaces:**

- Consumes: 现有 compileAnima 内部（3c 循环的 base/slotName/citation）、`SLOT_ORDER`、sources 表
- Produces（CompileAnimaResult 新增字段）:
  - `segments: Array<{ text: string; channel: 'positive'|'negative'; origin: 'policy'|'grounded'|'user-fuzzy'|'narrative'|'exclusion'; priority: number; slot?: string; citation?: AnimaCitation }>`
  - `phaseStatus: { policy: 'PASS'; grounding: 'PASS'|'ADVISORY'; composition: 'PASS'; inspection: 'PASS'|'ADVISORY' }`
  - `metadata: { variant: string; subject?: string }`
  - AnimaCitation 增加 `source?: string`（citations 建立时 `SELECT s.value FROM sources s JOIN records r ON r.source_id=s.source_id WHERE r.record_id=?`——**执行者先 read 真实库 schema**：`PRAGMA table_info(sources)` 确认列名）

- [ ] **Step 1: 失败测试（追加到 compile-anima.test.ts）**

```ts
it('G2: segments projection (origin/priority/slot provenance)', async () => {
  const ctx = stubCtx();
  const raw = JSON.parse(
    String(
      await runTool(ctx, def(), {
        target: 'anima',
        slots: { count_gender: ['1girl'], appearance: ['long hair'], narrative: '一段描述', exclusions: ['lowres'] },
      }),
    ),
  );
  const segs = raw.result.segments as Array<{
    text: string;
    channel: string;
    origin: string;
    priority: number;
    slot?: string;
  }>;
  expect(segs.filter((s) => s.origin === 'policy').length).toBeGreaterThan(0); // quality 前缀
  expect(segs.some((s) => s.origin === 'grounded' && s.slot === 'count_gender')).toBe(true);
  expect(segs.some((s) => s.origin === 'narrative' && s.channel === 'positive')).toBe(true);
  expect(segs.some((s) => s.origin === 'exclusion' && s.channel === 'negative')).toBe(true);
  expect(segs.every((s) => typeof s.priority === 'number')).toBe(true);
});

it('G2: phase_status four stages', async () => {
  const raw = JSON.parse(
    String(
      await runTool(stubCtx(), def(), {
        target: 'anima',
        slots: { count_gender: ['1girl'] },
      }),
    ),
  );
  expect(raw.result.phase_status).toEqual({
    policy: 'PASS',
    grounding: 'PASS',
    composition: 'PASS',
    inspection: 'PASS',
  });
});

it('G2: metadata carries variant', async () => {
  const raw = JSON.parse(
    String(
      await runTool(stubCtx(), def(), {
        target: 'anima',
        slots: { count_gender: ['1girl'] },
        variant: 'aesthetic',
      }),
    ),
  );
  expect(raw.result.metadata).toEqual({ variant: 'aesthetic' });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

要点：

- 3c 循环改为收集 `segments.push({ text, channel:'positive', origin, priority: base + tagIndex, slot: slotName, citation })`；3a policy 段 origin='policy' priority=100；3b safety origin='policy' priority=99；3d narrative origin='narrative' priority=2000；3e exclusions channel='negative' origin='exclusion' priority=900
- `positive = segments.filter(channel==='positive').map(text).join(', ')`——**字符串拼接结果必须与现状逐字节一致**（golden 闸门）；negative 同理
- phaseStatus：grounding = citations 有 record_id → 'PASS' else 'ADVISORY'；inspection = gates.some(important+) → 'ADVISORY' else 'PASS'
- metadata = { variant }
- citations.source：groundSlotTags 的 citation 建立处补 sources 查询（**先 PRAGMA table_info(sources) 核实列名**；若 sources 表无 value 列则按实际列调整或 source 留 null 并注明）
- **注意**：`validateAnimaSlots`（G6 顺带）对 `subject` 加「可选 string」校验；compileAnima metadata.subject = slots.subject

- [ ] **Step 4: 通过（重点：fidelity anima-brief-golden 13 用例必须全绿——positive/negative 逐字节不变）**

- [ ] **Step 5: 全量 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect/anima.ts plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G2 author payload projection (segments/phase_status/citations.source/metadata)"
```

---

### Task 5: G2 Envelope 投影（顶层 phase_status + dialectTopLevel 参）

**Files:**

- Modify: `src/pe-framework/render/envelope.ts`（assembleEnvelope 第四可选参 `dialectTopLevel?: Record<string, unknown>`）
- Modify: `src/tools/prompt-compile.ts`（anima 分支从 stage.result 提取 phase_status 传给 envelope 顶层）
- Test: `tests/pe-framework/pipeline/runStage.test.ts`（assembleEnvelope 用例追加）+ compile-anima 断言顶层 phase_status

**Interfaces:**

- Produces: `assembleEnvelope(stage, trail?, observability?, dialectTopLevel?: Record<string, unknown>)`——dialectTopLevel 键并入 envelope 顶层（方言特有载荷；h3 不传则无变化）

- [ ] **Step 1: 失败测试**

```ts
// runStage.test.ts assembleEnvelope describe 追加：
it('dialectTopLevel keys merge into envelope top level', () => {
  const s = JSON.parse(
    assembleEnvelope(
      { ok: true, result: { x: 1 }, gates: [], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
      [],
      { phase_status: { policy: 'PASS' } },
    ),
  );
  expect(s.phase_status).toEqual({ policy: 'PASS' });
});
// compile-anima.test.ts 追加：raw.phase_status 存在且 policy='PASS'（顶层，非 result 内）
```

- [ ] **Step 2: 确认失败 → Step 3: 实现（envelope 组装 `...(dialectTopLevel ?? {})`）→ compile-anima h3/anima 分支传 result.phase_status → Step 4: 通过**

- [ ] **Step 5: 全量 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/render/envelope.ts plugins/prompt-master/src/tools/prompt-compile.ts plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G2 envelope top-level phase_status via dialectTopLevel"
```

---

### Task 6: G1 relation 校验链 + overlay 库（`anima-knowledge/relations.ts`）

**Files:**

- Create: `src/pe-framework/anima-knowledge/relations.ts`
- Test: `tests/pe-framework/anima-knowledge/relations.test.ts`

**Interfaces:**

- Consumes: `resolveKnowledgePath`（overlay 路径）；`classifyTag`/`searchCatalog`（端点存在性）
- Produces:
  - `export function openOverlayDb(): DatabaseSync`（读写模式；目录不存在则 mkdir -p）
  - `export function validateProposal(input: { source_tag: string; target_tag: string; relation: string }, catalog: { classify(tag: string): 'canonical'|'alias'|'fuzzy'|'miss' }): { ok: true } | { ok: false; issues: string[] }`（① 端点 canonical/alias ② cooccurrence 拒收 ③ signature 去重说明）
  - `export function proposalSignature(source: string, target: string, relation: string): string`（归一化后 `sha256(normalized_src|normalized_tgt|relation)`）
  - `export function submitProposal(input, opts?: { model?: string }): { proposal_id: string; status: 'candidate' } | { ok: false; issues: string[] }`
  - `export function listProposals(opts?: { status?: 'candidate'|'accepted'|'rejected'|'all' }): ProposalRow[]`
  - `export function decideProposal(proposalId: string, decision: 'accept'|'reject'): { proposal_id: string; status: string }`

- [ ] **Step 1: 失败测试（tmp overlay 库 fixture）**

```ts
// tests/pe-framework/anima-knowledge/relations.test.ts
// fixture: mkdtemp + setPresetRoot(tmp)（overlay 落 <tmp>/temp/...？—— relations.ts 的库路径 =
//   join(dirname(resolveKnowledgePath({skillDir:'anima-prompt-v1', asset:'tag-catalog.sqlite'})), '..', '..', 'temp', 'anima-prompt-v1')
//   执行者可简化为独立 env ANIMA_OVERLAY_PATH 优先 + tmp 路径注入（与 setCatalogPath 同模式，导出 setOverlayPath）
describe('relation validation chain', () => {
  it('proposal_id deterministic (same input → same sha256 signature)', ...)
  it('signature normalization: a→b == b→a reversed pair distinct relation kept separate', ...)  // 按 skill 语义：同 relation 反向 = 不同提案或同一？read relation_submission.py 定稿——executor 先 read 再断言
  it('endpoint missing → issues contains 端点', ...)
})
describe('overlay lifecycle (tmp db)', () => {
  it('submit → candidate; list shows it; accept → accepted; list filter by status', ...)
  it('duplicate signature → same proposal_id (idempotent upsert)', ...)
})
```

> **执行者先 read** `skills/anima-prompt-v1/anima_prompt_v1/catalog/relation_submission.py` + `relation_overlay.py`：签名构成（是否含 relation）、proposal_id 算法、accepted UPSERT 语义、校验链顺序——以 deob/源码为准逐条移植，测试断言跟源码行为对齐。

- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过（fixture tmp 库，只测链与生命周期，不碰真实 overlay）**

- [ ] **Step 5: 构建 + 全量 + 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/anima-knowledge/relations.ts plugins/prompt-master/tests/pe-framework/anima-knowledge/relations.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G1 relation validation chain + overlay lifecycle"
```

---

### Task 7: G1 catalog_relations 工具 + G7 查询扩展

**Files:**

- Create: `src/tools/catalog-relations.ts`
- Modify: `src/plugin/index.ts`（注册新工具）
- Modify: `src/pe-framework/dialect/anima-catalog.ts`（CatalogQueryOptions 扩 mode 单选/categories/sources + applyRelationOverlay 升级为真实 overlay 别名读取）
- Test: `tests/plugin/catalog-relations.test.ts` + `tests/pe-framework/dialect/anima-catalog.test.ts`（单模式追加）

**Interfaces:**

- Consumes: Task 6 的 relations.ts 全套；`classifyTag`
- Produces:
  - 工具 `catalog_relations`（actions: submit/list/accept/reject/status）
  - `CatalogQueryOptions.mode` 扩为 `'auto'|'exact'|'canonical'|'alias'|'fuzzy'`；新增 `categories?: string[]`、`sources?: string[]`
  - `searchCatalog` 在 auto/exact 级联后追加 overlay accepted 别名命中（alias 级，canonical 保护）
- [ ] **Step 1: 失败测试**
- [ ] **Step 2-4: 实现 + 通过**（catalog-relations 工具的 action dispatch 参照 profile-list.ts 模式；单模式 SQL 复用 exactQuery 模板；overlay 命中经 `applyRelationOverlay` 的真实化——read 现有壳函数后升级）
- [ ] **Step 5: 全量（golden 不动）+ 提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G1 catalog_relations tool + G7 single-mode/category query"
```

---

### Task 8: 收尾 —— 文档 + 端到端

- [ ] **Step 1: 全量回归**（~400+新增全绿；fidelity 52 绿）
- [ ] **Step 2: usage 文档**——catalog_search 新输出（candidate/manifest/advisories）、catalog_relations 五 action、G2 的 phase_status/segments 载荷、G4 自动刷新语义
- [ ] **Step 3: 端到端（用户配合）**——① skill 侧 `relation.submit` 后 catalog_search 能看到 overlay；或直接用 `catalog_relations submit/accept` 闭环；② skill 重建 catalog（catalog.build）后插件**不重启**即用新库（G4）；③ prompt_author anima Envelope 出现 phase_status/segments
- [ ] **Step 4: 最终提交**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/docs
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "docs(prompt-master): anima knowledge management docs (relations, browse/stats/verify, refresh)"
```
