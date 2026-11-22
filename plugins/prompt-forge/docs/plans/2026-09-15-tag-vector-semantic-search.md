# Tag 向量语义检索（semantic search level）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Anima tag 查询级联末端新增向量语义层（`semantic`），使中文查询、错拼、词形变体、模糊发散能回填词表真实 tag，同时保持查询期零网络零 LLM 的确定性与防幻觉边界。

**Architecture:** 独立向量库 `tag-vector.sqlite`（sqlite-vec int8 384 维）+ Node 内嵌量化多语言 e5-small（transformers.js/onnxruntime）做查询期编码；`searchCatalog` auto 级联末端追加 semantic 层（仅前级全空触发）；审计侧 semantic 命中不发 `catalog_miss`，改发 `semantic_fallback` advisory，原文保留不自动替换。建库走 Python 脚本（wiki 全量分页拉取 + 断点续跑 + sentence-transformers 编码）。

**Tech Stack:** TypeScript / node:sqlite / sqlite-vec / @huggingface/transformers (onnxruntime-node) / Python sentence-transformers + sqlite-vec + requests

**Spec:** `docs/specs/2026-09-15-tag-vector-semantic-search-design.md`（本计划从 spec 出发，执行者须同时读两者）

## Global Constraints

- 查询期**零网络、零 LLM 调用、零外部常驻进程**；模型文件首次加载可联网下载，之后离线。
- semantic 层是**增强层**：任何故障（模型缺失/向量库缺失/embed 异常）只降级为空，不阻塞前四级级联。
- `catalog-recall.ts` 的 exact-only 注入边界**不改**；semantic 命中不得进入生成 persona。
- 不新增插件工具；14 个工具注册面不动；`catalog_build` / `catalog_relations` / `catalog_artist_add` 语义不动。
- 改 `src/**` 后提交前必须 `npm run build`（dist 同步，见插件 AGENTS.md）；dist 不入 git。
- 前四级匹配语义不变：`anima-catalog-golden.test.ts` 等既有测试必须原样通过。
- 提交规范：单意图提交，message 标注 spec 章节（如 `spec §3.2`）。
- 环境探测单路径：Task 1 探测后**删除未选中的分支代码**再提交，不留兼容层。

## 对 spec §4 的一处细化（不改意图）

spec 写"wiki 按标题逐 tag 查询"——139 万 tag × 2 req/s 不可行。改为：**分页全量拉取 wiki 页清单**（`GET /wiki_pages.json?limit=1000&page=N` 直到空页，约几百次请求），落地 JSONL 后按 title 本地 JOIN。语义等价（有页的都拿到），请求量从百万级降到几百级。

---

### Task 1: 运行时探测 + 依赖引入

**Files:**

- Create: `scripts/probe-sqlite-vec.mjs`
- Modify: `package.json`（dependencies）

**Interfaces:**

- Produces: 探测结论写入 spec §8 风险表（`loadExtension 可用` 或 `退路 hnswlib-node`），后续任务按结论走唯一路径。

- [ ] **Step 1: 写探测脚本**

```js
// scripts/probe-sqlite-vec.mjs — 探测 node:sqlite 能否加载 sqlite-vec
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
const db = new DatabaseSync(':memory:', { allowExtension: true });
db.loadExtension(getLoadablePath());
db.exec('CREATE VIRTUAL TABLE t USING vec0(embedding float[4])');
console.log('PROBE_OK: sqlite-vec loadable via node:sqlite loadExtension');
```

- [ ] **Step 2: 安装依赖**

```bash
cd plugins/prompt-master
npm install sqlite-vec @huggingface/transformers
```

- [ ] **Step 3: 运行探测**

```bash
node scripts/probe-sqlite-vec.mjs
```

Expected: `PROBE_OK` → 走 sqlite-vec 路径（Task 2/3 的代码即按此写）。若抛 `loadExtension is not a function` 或扩展加载失败 → 改用 `hnswlib-node`：`npm install hnswlib-node`，并把 Task 3 的 `openVectorDb` 换成 HNSW 索引文件实现（record_id 存 labels 映射表），**Task 4 以后的所有接口不变**。

- [ ] **Step 4: 把探测结论写入 spec §8 表格**（一行：探测日期 + 结论 + 选定路径），删除探测脚本未用分支，`git add package.json package-lock.json docs/specs/2026-09-15-tag-vector-semantic-search-design.md && git commit -m "chore: probe sqlite-vec runtime, deps for semantic search (spec §3.3)"`

---

### Task 2: 嵌入运行时与 embed seam（anima-vector.ts 第 1 部分）

**Files:**

- Create: `src/pe-framework/dialect/anima-vector.ts`
- Test: `tests/pe-framework/dialect/anima-vector.test.ts`

**Interfaces:**

- Produces:
  - `export type EmbedFn = (texts: string[], kind: 'query' | 'passage') => Promise<Float32Array[]>`（kind 决定 e5 前缀：`query: ` / `passage: `）
  - `export function createOnnxEmbedder(opts?: { model?: string }): EmbedFn` — 惰性单例；模型缺省 `Xenova/multilingual-e5-small`（env `PM_E5_MODEL` 可覆盖）；加载失败时返回的 EmbedFn 永久 throw，由调用方 Task 3 捕获降级。
  - `export const E5_QUERY_PREFIX = 'query: '`, `export const E5_PASSAGE_PREFIX = 'passage: '`

- [ ] **Step 1: 写失败测试（stub 驱动，不加载真模型）**

```ts
// tests/pe-framework/dialect/anima-vector.test.ts
import { describe, expect, it } from 'vitest';
import { E5_PASSAGE_PREFIX, E5_QUERY_PREFIX } from '../../src/pe-framework/dialect/anima-vector.js';

describe('e5 prefix constants', () => {
  it('query/passage prefixes follow e5 convention', () => {
    expect(E5_QUERY_PREFIX).toBe('query: ');
    expect(E5_PASSAGE_PREFIX).toBe('passage: ');
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/pe-framework/dialect/anima-vector.test.ts`，Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/pe-framework/dialect/anima-vector.ts
/** semantic 层嵌入运行时（spec §3.3）：transformers.js 量化 e5-small；embed seam 供测试注入 stub。
 *  增强层纪律：任何故障由调用方捕获降级，本模块 throw 不吞。 */
export const E5_QUERY_PREFIX = 'query: ';
export const E5_PASSAGE_PREFIX = 'passage: ';

export type EmbedFn = (texts: string[], kind: 'query' | 'passage') => Promise<Float32Array[]>;

export function createOnnxEmbedder(opts?: { model?: string }): EmbedFn {
  const model = opts?.model ?? process.env.PM_E5_MODEL ?? 'Xenova/multilingual-e5-small';
  let extractor: Awaited<ReturnType<typeof import('@huggingface/transformers').pipeline>> | null = null;
  let failed = false;
  return async (texts, kind) => {
    if (failed) throw new Error('embedder permanently failed');
    if (!extractor) {
      try {
        const tf = await import('@huggingface/transformers');
        extractor = await tf.pipeline('feature-extraction', model, { dtype: 'q8' });
      } catch (e) {
        failed = true;
        throw e;
      }
    }
    const prefix = kind === 'query' ? E5_QUERY_PREFIX : E5_PASSAGE_PREFIX;
    const out = await extractor!(
      texts.map((t) => prefix + t),
      { pooling: 'mean', normalize: true },
    );
    const dim = out.dims[out.dims.length - 1];
    const rows: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) rows.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)));
    return rows;
  };
}
```

- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令，Expected: PASS
- [ ] **Step 5: 真模型冒烟（手动，一次）** — `node -e "import('./dist/src/pe-framework/dialect/anima-vector.js').then(async m => { const e = m.createOnnxEmbedder(); const v = await e(['水手服'], 'query'); console.log(v[0].length, v[0].slice(0,4)) })"`（需先 `npm run build`）。Expected: 输出 `384` + 4 个浮点数。首次运行会联网下载 ~120MB 模型到本地缓存。
- [ ] **Step 6: Commit** — `npm run build && git add src/pe-framework/dialect/anima-vector.ts tests/pe-framework/dialect/anima-vector.test.ts && git commit -m "feat: embed runtime + seam for semantic layer (spec §3.3)"`

---

### Task 3: 向量库句柄与 KNN 查询（anima-vector.ts 第 2 部分）

**Files:**

- Modify: `src/pe-framework/dialect/anima-vector.ts`
- Test: `tests/pe-framework/dialect/anima-vector.test.ts`（追加）

**Interfaces:**

- Consumes: Task 1 的 sqlite-vec 路径、Task 2 的 `EmbedFn`
- Produces:
  - `export interface SemanticHit { record_id: string; score: number; text_source: 'wiki' | 'fallback' }`
  - `export function createVectorSearch(opts?: { dbPath?: string; embed?: EmbedFn; threshold?: number }): (query: string, k: number) => SemanticHit[]` — 同步对外（内部惰性初始化+缓存 embedder/句柄）；`dbPath` 缺省 `resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-vector.sqlite' })`，env `ANIMA_VECTOR_PATH` 可覆盖；threshold 缺省 0.55（env `PM_SEMANTIC_THRESHOLD`）。任何初始化/查询故障 → 返回 `[]`（增强层降级纪律），并用 `console.warn` 一次性提示。

- [ ] **Step 1: 追加失败测试**（fixture 向量库在测试内用 sqlite-vec 现建，stub embed，不加载真模型）

```ts
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { createVectorSearch } from '../../src/pe-framework/dialect/anima-vector.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIM = 384;
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
function unitVec(seed: number): Float32Array {
  const rnd = lcg(seed);
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = rnd();
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}
function int8Bytes(v: Float32Array): Uint8Array {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const out = new Uint8Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = Math.round((v[i] / max) * 127) + 128;
  return out;
}
function makeFixtureDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vec-fixture-'));
  const p = join(dir, 'tag-vector.sqlite');
  const db = new DatabaseSync(p, { allowExtension: true });
  db.loadExtension(getLoadablePath());
  db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding int8[${DIM}] distance_metric=cosine)`);
  db.exec(`CREATE TABLE payload(record_id TEXT PRIMARY KEY, text_source TEXT NOT NULL)`);
  // 5 个 tag，向量由 seed 决定；查询 stub 用相同 seed → 命中自身，score≈1
  const seeds: Array<[string, string, number]> = [
    ['serafuku', 'wiki', 101],
    ['twintails', 'fallback', 202],
    ['cat_ears', 'wiki', 303],
    ['school_uniform', 'fallback', 404],
    ['neon_signs', 'wiki', 505],
  ];
  const ins = db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)');
  const insP = db.prepare('INSERT INTO payload(rowid, record_id, text_source) VALUES (?, ?, ?)');
  seeds.forEach(([rid, src, seed], i) => {
    ins.run(i + 1, new Uint8Array(int8Bytes(unitVec(seed)).buffer));
    insP.run(i + 1, rid, src);
  });
  db.close();
  return p;
}

describe('createVectorSearch', () => {
  it('returns nearest tag with score and text_source (stub embed)', async () => {
    const p = makeFixtureDb();
    const stub: EmbedFn = async (texts) => {
      const seedBy: Record<string, number> = { 水手服: 101, 兔耳朵: 303, 未知词: 999 };
      return texts.map((t) => unitVec(seedBy[t] ?? 999));
    };
    const search = createVectorSearch({ dbPath: p, embed: stub });
    const hits = search('水手服', 3);
    expect(hits[0]).toMatchObject({ record_id: 'serafuku', text_source: 'wiki' });
    expect(hits[0].score).toBeGreaterThan(0.9);
    expect(hits.length).toBeLessThanOrEqual(3);
  });
  it('missing db file degrades to empty array', () => {
    const search = createVectorSearch({
      dbPath: join(tmpdir(), 'no-such-vec.sqlite'),
      embed: async () => [new Float32Array(DIM)],
    });
    expect(search('anything', 3)).toEqual([]);
  });
  it('below-threshold hits are dropped, not padded', async () => {
    const p = makeFixtureDb();
    const stub: EmbedFn = async (texts) => texts.map(() => unitVec(999)); // 与所有 fixture 向量近正交
    const search = createVectorSearch({ dbPath: p, embed: stub, threshold: 0.9 });
    expect(search('未知词', 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/pe-framework/dialect/anima-vector.test.ts`，Expected: 新增 3 条 FAIL（`createVectorSearch` 未导出）
- [ ] **Step 3: 实现**（追加到 `anima-vector.ts`）

```ts
import { DatabaseSync, type DatabaseSync as DB } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { statSync } from 'node:fs';
import { resolveKnowledgePath } from '../resources/resolve.js';

export interface SemanticHit {
  record_id: string;
  score: number;
  text_source: 'wiki' | 'fallback';
}

const DEFAULT_THRESHOLD = 0.55;

export function createVectorSearch(opts?: {
  dbPath?: string;
  embed?: EmbedFn;
  threshold?: number;
}): (query: string, k: number) => SemanticHit[] {
  const threshold =
    opts?.threshold ??
    (process.env.PM_SEMANTIC_THRESHOLD ? Number(process.env.PM_SEMANTIC_THRESHOLD) : DEFAULT_THRESHOLD);
  const dbPath =
    opts?.dbPath ??
    process.env.ANIMA_VECTOR_PATH ??
    resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-vector.sqlite' });
  const embed = opts?.embed ?? createOnnxEmbedder();
  let db: DB | null = null;
  let mtime = 0;
  let warned = false;
  const warn = (msg: string) => {
    if (!warned) {
      warned = true;
      console.warn(`[prompt-master] semantic layer degraded: ${msg}`);
    }
  };
  const open = (): DB | null => {
    let m = 0;
    try {
      m = statSync(dbPath).mtimeMs;
    } catch {
      return null;
    }
    if (db && m !== mtime) {
      db.close();
      db = null;
    } // G4 mtime 重开
    if (!db) {
      db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: true });
      db.loadExtension(getLoadablePath());
      mtime = m;
    }
    return db;
  };
  return (query: string, k: number): SemanticHit[] => {
    if (!query || k < 1) return [];
    try {
      const d = open();
      if (!d) return [];
      const vec = Math.round((await0(), 0)); // placeholder removed in real impl — see below
      return [];
    } catch (e) {
      warn(String(e));
      return [];
    }
  };
}
```

> 写实现时把查询体补全为（上面骨架仅示意结构，提交必须是完整代码）：

```ts
return (query: string, k: number): SemanticHit[] => {
  if (!query || k < 1) return [];
  try {
    const d = open();
    if (!d) return [];
    const q = await embed([query], 'query'); // 注意：EmbedFn 是异步 → createVectorSearch 返回 Promise<SemanticHit[]>
    const qv = int8Bytes(q[0]);
    const rows = d
      .prepare(
        `SELECT payload.record_id, payload.text_source, vec_items.distance
         FROM vec_items JOIN payload ON payload.rowid = vec_items.rowid
         WHERE vec_items.embedding MATCH ? AND k = ?`,
      )
      .all(new Uint8Array(qv.buffer), k) as Array<{
      record_id: string;
      text_source: 'wiki' | 'fallback';
      distance: number;
    }>;
    return rows
      .map((r) => ({ record_id: r.record_id, score: 1 - r.distance, text_source: r.text_source }))
      .filter((h) => h.score >= threshold)
      .slice(0, k);
  } catch (e) {
    warn(String(e));
    return [];
  }
};
```

最终签名（异步，接口以本块为准）：`createVectorSearch(...): (query: string, k: number) => Promise<SemanticHit[]>`。测试中的调用相应改 `await search(...)`。int8Bytes/unitVec 两个工具函数从测试文件移入 `src/pe-framework/dialect/anima-vector.ts` 导出（`export function quantizeInt8(v: Float32Array): Uint8Array`），测试改 import——保证建库（Python）与查询（Node）的量化口径一致：**per-vector max-abs 缩放到 int8，127 为满幅**。

- [ ] **Step 4: 跑测试确认通过** — Expected: 全部 PASS（含 Task 2 的 2 条）
- [ ] **Step 5: Commit** — `npm run build && git add -A src tests && git commit -m "feat: vector db handle + knn search with degrade semantics (spec §3.1/§3.3/§5)"`

---

### Task 4: searchCatalog 级联接入 semantic 层

**Files:**

- Modify: `src/pe-framework/dialect/anima-catalog.ts`（`CatalogHit`、`searchCatalog`；其余函数结构保持）
- Modify: `src/pe-framework/dialect/anima-vector.ts`（导出查询单例装配）
- Test: `tests/pe-framework/dialect/anima-catalog-semantic.test.ts`（新建）

**Interfaces:**

- Consumes: Task 3 的 `createVectorSearch`
- Produces:
  - `CatalogHit.match_type` 联合类型加 `'semantic'`；`CatalogHit` 增加 `score?: number; text_source?: 'wiki' | 'fallback'`
  - `searchCatalog` auto 级联：canonical → alias → artistRegistry → fuzzy → **semantic（前级全空才触发）**；`mode='exact'` 与单级直查不触发
  - `export function setVectorSearch(search: ((q: string, k: number) => Promise<SemanticHit[]>) | null): void` — 测试 seam，null=禁用语义层

- [ ] **Step 1: 写失败测试**（stub 向量层，不依赖真库）

```ts
// tests/pe-framework/dialect/anima-catalog-semantic.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { searchCatalog, setVectorSearch } from '../../src/pe-framework/dialect/anima-catalog.js';
import { setCatalogPath } from '../../src/pe-framework/dialect/anima-catalog.js';
import { createCatalogFixture } from '../helpers/catalog-fixture.js'; // 已有 fixture 机制则复用，没有则按 anima-catalog.test.ts 现有做法建临时库

afterAll(() => {
  setVectorSearch(null);
});

describe('semantic level in auto cascade', () => {
  it('fuzzy miss falls through to semantic hit', async () => {
    setCatalogPath(createCatalogFixture({ tags: ['serafuku'] })); // 只有 canonical serafuku
    setVectorSearch(async (q, k) =>
      q === '水手服' ? [{ record_id: 'serafuku', score: 0.82, text_source: 'wiki' }] : [],
    );
    const hits = searchCatalog('水手服', { mode: 'auto', limit: 5 });
    expect(hits[0]).toMatchObject({ match_type: 'semantic', prompt_form: 'serafuku', score: 0.82 });
  });
  it('exact mode never reaches semantic level', () => {
    const hits = searchCatalog('水手服', { mode: 'exact', limit: 5 });
    expect(hits.every((h) => h.match_type !== 'semantic')).toBe(true);
  });
  it('canonical hit shadows semantic level', () => {
    setCatalogPath(createCatalogFixture({ tags: ['水手服'] })); // 直接命中 canonical
    const hits = searchCatalog('水手服', { mode: 'auto', limit: 5 });
    expect(hits[0].match_type).toBe('canonical');
  });
});
```

> 若 `tests/helpers/catalog-fixture.js` 不存在：按 `tests/pe-framework/dialect/anima-catalog.test.ts` 里现有的临时库建法（同文件内已有 setCatalogPath 用法）构造；本任务的测试只要求「能精确控制 canonical/alias/fuzzy 命中与否」。

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/pe-framework/dialect/anima-catalog-semantic.test.ts`，Expected: FAIL
- [ ] **Step 3: 实现**——`anima-catalog.ts` 三处改动：

```ts
// ① CatalogHit 扩展
export interface CatalogHit {
  match_type: 'canonical' | 'alias' | 'fuzzy' | 'semantic' | 'miss';
  prompt_form?: string;
  record_id?: string;
  usage_count?: number;
  raw?: string;
  source?: string;
  /** semantic 层专有（spec §3.2） */
  score?: number;
  text_source?: 'wiki' | 'fallback';
}

// ② 向量层 seam（惰性装配，测试可注入/禁用）
import { createVectorSearch, type SemanticHit } from './anima-vector.js';
let vectorSearch: ((q: string, k: number) => Promise<SemanticHit[]>) | null | undefined;
export function setVectorSearch(s: ((q: string, k: number) => Promise<SemanticHit[]>) | null): void {
  vectorSearch = s;
}
function getVectorSearch() {
  if (vectorSearch === undefined) {
    try {
      vectorSearch = createVectorSearch();
    } catch {
      vectorSearch = null;
    }
  }
  return vectorSearch;
}

// ③ searchCatalog：levels 数组 auto 模式追加一级
if (mode === 'auto') {
  levels.push(() => fuzzyQuery(tag, limit, opts?.categories, opts?.sources));
  levels.push(() => null); // semantic 是异步占位——见下：级联改写为顺序 await
}
```

> 级联循环改写（同步 levels + 异步 semantic 的处理）：把 `for (const level of levels)` 改为 `async function runCascade()`，semantic 级不进 levels，在循环后单独执行：

```ts
for (const level of levels) {
  /* 原 canonical/alias/artistRegistry/fuzzy 逻辑不变 */
}
if (mode === 'auto' && cascadeHits.length === 0) {
  const vs = getVectorSearch();
  if (vs) {
    const sem = await vs(normalized, limit);
    if (sem.length) {
      const joined = joinWithCatalog(sem); // 按 record_id JOIN records 取 prompt_form/usage_count；JOIN 不到的丢弃
      if (joined.length) cascadeHits = joined.map((h) => ({ match_type: 'semantic' as const, ...h }));
    }
  }
}
```

`searchCatalog` 因此变为 `async`——**全部 6 处调用点必须同步加 `await`**（catalog-recall.ts L113、anima.ts L309/L690/L767、judge-assembly.ts L35、tools/catalog-search.ts L27）。`classifyTag` **不改**（关系提案端点校验要求权威存在性，语义近似不得放行——设计定案，写进函数注释）。

- [ ] **Step 4: 全量测试** — `npx vitest run`。Expected: 新测试 PASS；既有测试除因 `searchCatalog` 变 async 需要加 `await` 的调用点外**全部原样通过**（golden 保真不动）。
- [ ] **Step 5: Commit** — `npm run build && git add -A src tests && git commit -m "feat: semantic level appended to auto cascade (spec §3.2)"`

---

### Task 5: 审计集成——semantic_fallback advisory

**Files:**

- Modify: `src/pe-framework/dialect/anima.ts`（`auditAnima` 的 catalog_miss 闸门、`groundSlotTags`）
- Test: `tests/pe-framework/dialect/anima-audit-semantic.test.ts`（新建）

**Interfaces:**

- Consumes: Task 4 的 `match_type: 'semantic'` 命中形状
- Produces（行为契约）:
  - audit 闸门里片段 top hit 为 `semantic` → **不发** `catalog_miss:` assumption，改发 advisory `semantic_fallback:<原文>→<prompt_form>`；**原文保留不替换**（A14 语义延伸）
  - `groundSlotTags`/F2 自动采纳**不变**：只认 canonical/alias（semantic 命中不参与 grounding 与替换）

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/dialect/anima-audit-semantic.test.ts
import { describe, expect, it } from 'vitest';
import { auditAnima } from '../../src/pe-framework/dialect/anima.js';
import type { CatalogHit } from '../../src/pe-framework/dialect/anima-catalog.js';

const semHit = (pf: string): CatalogHit[] => [
  { match_type: 'semantic', prompt_form: pf, score: 0.8, text_source: 'wiki' },
];

describe('audit semantic fallback', () => {
  it('semantic top-hit suppresses catalog_miss and emits semantic_fallback advisory', async () => {
    const r = await auditAnima(
      { positive: '水手服', negative: '' },
      {
        search: (t) => semHit('serafuku'),
      },
    );
    expect(r.assumptions.join('\n')).not.toContain('catalog_miss:水手服');
    expect(r.advisories).toContain('semantic_fallback:水手服→serafuku');
  });
  it('true miss (no hits at all) still emits catalog_miss', async () => {
    const r = await auditAnima({ positive: 'totallyfaketag', negative: '' }, { search: () => [] });
    expect(r.assumptions.join('\n')).toContain('catalog_miss:totallyfaketag');
  });
  it('semantic hit does NOT auto-substitute the original text (F2 unchanged)', async () => {
    const r = await auditAnima({ positive: '水手服', negative: '' }, { search: (t) => semHit('serafuku') });
    expect(r.positive).toContain('水手服');
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/pe-framework/dialect/anima-audit-semantic.test.ts`，Expected: 第 1 条 FAIL（现在会发 catalog_miss）
- [ ] **Step 3: 实现**——`anima.ts` 的 `auditAnima` catalog_miss 块（L692 附近）判定改为：

```ts
const hits = search(tag, { limit: 5 }); // await
const top = hits[0];
if (top && (top.match_type === 'canonical' || top.match_type === 'alias')) {
  // 现状不变：不算 miss
} else if (top && top.match_type === 'semantic' && top.prompt_form) {
  advisories.push(`semantic_fallback:${text}→${top.prompt_form}`); // 不进 assumptions，不替换原文
} else {
  // 现状不变：assumptions.push(`catalog_miss:${text}`) + fuzzy 候选建议
}
```

`groundSlotTags`（L272）与 F2（L735 起）**零改动**——其判定已只认 canonical/alias，semantic 命中天然被当作未 grounding/未采纳。

- [ ] **Step 4: 跑测试 + 全量回归** — 新测试 PASS；`npx vitest run` 无回归。
- [ ] **Step 5: Commit** — `npm run build && git add src/pe-framework/dialect/anima.ts tests/pe-framework/dialect/anima-audit-semantic.test.ts && git commit -m "feat: semantic_fallback advisory, miss-gate integration (spec §3.2)"`

---

### Task 6: catalog_search 工具透传新字段

**Files:**

- Modify: `src/tools/catalog-search.ts`
- Test: `tests/plugin/catalog-search-semantic.test.ts`（新建）

**Interfaces:**

- Consumes: Task 4 的 `score`/`text_source` 字段、async `searchCatalog`
- Produces: `catalog_search` 工具 result.hits[] 增加可选 `score`、`text_source`；mode 取值不变（`auto`/`exact`，不新增 `semantic` 模式——YAGNI）

- [ ] **Step 1: 写失败测试**（沿 `tests/plugin/` 现有 catalog 相关测试的 mock 方式，如 `catalog-relations.test.ts` 的 registry mock 模式）

```ts
// tests/plugin/catalog-search-semantic.test.ts
import { describe, expect, it } from 'vitest';
// 断言：tool handler 把 searchCatalog 的 score/text_source 原样透传进 result.hits
// 具体 harness 沿用 tests/plugin/catalog-search 现有测试文件（若已有 catalog-search.test.ts 则在其中追加用例，不新建文件）
```

> 写测试时先查 `tests/plugin/` 下是否已有 `catalog-search` 测试文件：有 → 追加用例（保持同一 harness），没有 → 按 `catalog-relations.test.ts` 的 mock/registry 模式新建。断言核心：`result.hits[0]` 含 `score: expect.any(Number)` 与 `text_source: 'wiki'`（mock searchCatalog 返回 semantic 命中）。

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（字段未透传）
- [ ] **Step 3: 实现**——`tools/catalog-search.ts` 的 hit 映射处把 `score`/`text_source` 加进输出对象；`searchCatalog` 调用加 `await`（若 Task 4 未覆盖此调用点）。
- [ ] **Step 4: 跑测试确认通过 + 全量回归** — `npx vitest run`
- [ ] **Step 5: Commit** — `npm run build && git add src/tools/catalog-search.ts tests/plugin && git commit -m "feat: catalog_search passthrough of semantic hit fields (spec §3.2)"`

---

### Task 7: 建库脚本 build_tag_vector.py

**Files:**

- Create: `scripts/build_tag_vector.py`
- Modify: 无（依赖装进 preset `.venv`，不建 requirements 文件——沿 preset 惯例手动装）

**Interfaces:**

- Consumes: `knowledge/anima-prompt-v1/tag-catalog.sqlite`（records/names 表，只读）
- Produces: `knowledge/anima-prompt-v1/tag-vector.sqlite`（vec0 int8[384] + payload 表，schema 与 Task 3 fixture 完全一致）；JSONL wiki 缓存 `temp/anima-prompt-v1/wiki-cache/wiki-pages.jsonl`

- [ ] **Step 1: 安装 Python 依赖**

```powershell
.\.venv\Scripts\python.exe -m pip install sentence-transformers sqlite-vec requests
```

- [ ] **Step 2: 写脚本**（完整结构如下，一段不省）

```python
#!/usr/bin/env python
"""build_tag_vector.py — 建 tag-vector.sqlite（spec §4）。
用法: .\.venv\Scripts\python.exe plugins/prompt-master/scripts/build_tag_vector.py [--limit N] [--skip-wiki]
断点续跑: wiki 缓存 JSONL 逐条落盘，重跑只补缺。
"""
import argparse, json, os, re, sqlite3, sys, time
from pathlib import Path

PRESET = Path(__file__).resolve().parents[2]          # comfyui-chenxin preset root
CATALOG = PRESET / "knowledge/anima-prompt-v1/tag-catalog.sqlite"
OUT = PRESET / "knowledge/anima-prompt-v1/tag-vector.sqlite"
CACHE = PRESET / "temp/anima-prompt-v1/wiki-cache/wiki-pages.jsonl"
DIM = 384
MODEL = "intfloat/multilingual-e5-small"
WIKI_URL = "https://danbooru.donmai.us/wiki_pages.json"
TOKEN_RE = re.compile(r"[\r\n]+|\{\{[^}]*\}\}|\[[^\]]*\]|<[^>]*>")  # dokuwiki 标记粗剥

def load_catalog_tags():
    db = sqlite3.connect(f"file:{CATALOG}?mode=ro", uri=True)
    rows = db.execute(
        "SELECT r.record_id, r.category, r.usage_count, "
        "  (SELECT group_concat(n.value, ', ') FROM names n WHERE n.record_id=r.record_id AND n.name_type='alias') "
        "FROM records r ORDER BY r.usage_count DESC"
    ).fetchall()
    db.close()
    return rows  # [(record_id, category, usage_count, aliases|None)]

def fetch_all_wiki_pages():
    """分页全量拉 wiki 页清单（对 spec §4 的细化：不逐 tag 查询）。限速 2 req/s + 退避。"""
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    have = {}
    if CACHE.exists():
        for line in CACHE.read_text(encoding="utf-8").splitlines():
            if line.strip():
                p = json.loads(line); have[p["title"]] = p
    import requests
    s = requests.Session()
    if os.environ.get("DANBOORU_LOGIN"):
        s.auth = (os.environ["DANBOORU_LOGIN"], os.environ.get("DANBOORU_API_KEY", ""))
    page, done = 1, False
    with CACHE.open("a", encoding="utf-8") as f:
        while not done:
            for attempt in range(5):
                r = s.get(WIKI_URL, params={"limit": 1000, "page": page}, timeout=30)
                if r.status_code == 429:
                    time.sleep(2 ** attempt); continue
                r.raise_for_status(); break
            else:
                sys.exit(f"wiki fetch failed at page {page}")
            items = r.json()
            if not items: done = True; break
            for it in items:
                if it["title"] not in have:
                    body = TOKEN_RE.sub(" ", it.get("body") or "")
                    f.write(json.dumps({"title": it["title"], "body": body[:512]}, ensure_ascii=False) + "\n")
            f.flush()
            page += 1
            time.sleep(0.5)  # ~2 req/s
    return have

def first_sentence(body: str) -> str:
    return body.strip()[:400]

def build_text(record_id, category, aliases, wiki_by_title):
    parts = [record_id.replace("_", " ")]
    if aliases: parts.append(aliases)
    parts.append(f"category:{category}")
    w = wiki_by_title.get(record_id)
    src = "fallback"
    if w and w.get("body"):
        parts.append(first_sentence(w["body"])); src = "wiki"
    return " — ".join(parts), src

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只编码前 N 个 tag（调试用）")
    ap.add_argument("--skip-wiki", action="store_true", help="跳过 wiki 拉取（用缓存/纯 fallback）")
    args = ap.parse_args()

    tags = load_catalog_tags()
    if args.limit: tags = tags[: args.limit]
    wiki_by_title = {} if args.skip_wiki else fetch_all_wiki_pages()

    from sentence_transformers import SentenceTransformer
    import sqlite_vec
    model = SentenceTransformer(MODEL, device="cuda" if os.environ.get("FORCE_CUDA") else "cpu")

    texts, meta = [], []
    for record_id, category, _usage, aliases in tags:
        t, src = build_text(record_id, category, aliases, wiki_by_title)
        texts.append(t); meta.append((record_id, src))

    tmp = OUT.with_suffix(".sqlite.tmp")
    if tmp.exists(): tmp.unlink()
    db = sqlite3.connect(tmp)
    db.enable_load_extension(True); sqlite_vec.load(db)
    db.execute(f"CREATE VIRTUAL TABLE vec_items USING vec0(embedding int8[{DIM}] distance_metric=cosine)")
    db.execute("CREATE TABLE payload(rowid INTEGER PRIMARY KEY, record_id TEXT UNIQUE, text_source TEXT NOT NULL)")
    B = 512
    for i in range(0, len(texts), B):
        emb = model.encode(["passage: " + t for t in texts[i:i+B]], batch_size=B, normalize_embeddings=True)
        for j, v in enumerate(emb):
            rowid = i + j + 1
            m = max(abs(float(x)) for x in v) or 1.0
            q = bytes(min(255, max(0, int(round(float(x) / m * 127) + 128))) for x in v)
            db.execute("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)", (rowid, q))
            db.execute("INSERT INTO payload(rowid, record_id, text_source) VALUES (?, ?, ?)", (rowid, *meta[i + j]))
        db.commit()
        print(f"encoded {min(i+B, len(texts))}/{len(texts)}", flush=True)
    db.close()
    tmp.replace(OUT)  # 原子落盘
    print(f"done: {OUT}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: 小样验证** — `.\.venv\Scripts\python.exe plugins\prompt-master\scripts\build_tag_vector.py --limit 200 --skip-wiki`。Expected: `done: ...\tag-vector.sqlite`，文件 ~1MB，`sqlite3` 检查 payload 行数=200。
- [ ] **Step 4: Node 侧冒烟** — Task 3 的 `createVectorSearch` 用真库查 `serafuku`（e5 编码后应近邻自身）。Expected: 命中 `serafuku`，score > 0.6。
- [ ] **Step 5: 全量建库（后台长跑）** — `.\.venv\Scripts\python.exe plugins\prompt-master\scripts\build_tag_vector.py`（先跑 wiki 拉取，几小时；再编码，CPU 约 4-8h，`FORCE_CUDA=1` 走 GPU）。产物 mtime 对账由 Task 3 句柄自动重开。
- [ ] **Step 6: Commit** — `git add scripts/build_tag_vector.py && git commit -m "feat: tag-vector build pipeline with wiki fetch + resume (spec §4)"`

---

### Task 8: 验收探针 + 文档收口

**Files:**

- Modify: `docs/specs/2026-09-15-tag-vector-semantic-search-design.md`（§6 验收探针结果回填）

**Interfaces:**

- Consumes: 全量 `tag-vector.sqlite` + 真模型

- [ ] **Step 1: 跑 4 个验收探针**（`catalog_search` 工具直查，mode auto）：

| 输入       | 期望                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| `水手服`   | top hit `match_type=semantic`，prompt_form 含 serafuku                    |
| `selafuku` | top hit semantic → serafuku（或前级 fuzzy 未命中后 semantic 命中）        |
| `twintail` | top hit prompt_form 含 twintails                                          |
| `兔耳朵`   | 返回 ≥3 个耳型相关 tag（animal_ears / rabbit_ears / animal_ear_fluff 等） |

- [ ] **Step 2: 结果回填 spec §6**（每行：输入 → 实际 top hit + score；未达标项如实记录并附原因分析），`git commit -m "docs: acceptance probe results for semantic layer (spec §6)"`
- [ ] **Step 3: 全量回归收口** — `npx vitest run`，记录基线数字（files/passed/failed）到 commit message。若 `selafuku`/`兔耳朵` 探针不达标：调 `PM_SEMANTIC_THRESHOLD`（0.50~0.60）重测并记录取值依据；仍不达标 → 在 spec §8 记为已知限制（e5-small 天花板），不阻塞收口。

---

## Self-Review 结论

- **Spec 覆盖**：§3.1→Task 3/7（向量库+对账）；§3.2→Task 4/5/6；§3.3→Task 1/2；§4→Task 7；§5→Task 3（降级纪律）；§6→Task 8；§7 非目标未触碰（无新工具、recall 未改）；§8→Task 1 探测回填。无缺口。
- **占位符**：Task 3 Step 3 的骨架块已显式标注"提交必须是完整代码"并给出权威实现块与最终异步签名；Task 6 Step 1 的 harness 选择规则已写成可执行指令（优先追加已有文件）。除此之外无 TBD/TODO。
- **类型一致性**：`SemanticHit`/`EmbedFn`/`setVectorSearch`/`quantizeInt8` 在 Task 2/3/4 间签名一致；`searchCatalog` async 化的 6 处调用点已在 Task 4 Step 3 列举。
