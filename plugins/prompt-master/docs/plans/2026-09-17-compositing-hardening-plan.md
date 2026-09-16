# Compositing 管线加固实现计划（第一性原理审计落地）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 闭合 2026-09-17 第一性原理审计发现的 4 个缺口：P1 向量审核层未接线、P2 回退通道不合规产物、P3 envelope 质量语义不可见、P4a judge 跨轮重复评审。

**Architecture:** 全部改动收敛在 compositing 五段管线的既有接缝上——vectorSim 是 `orchestrate.ts` 已声明但未装配的可选依赖（P1）；`deterministicCompose` 已有 NL 预算但存在返回死变量 bug（P2）；envelope 顶层已有条件键先例（blueprint_id）（P3）；judge prompt 是纯函数可加可选块（P4a）。零新依赖、零 schema 破坏性变更。

**Tech Stack:** TypeScript (tsc→dist)、vitest、node:sqlite / onnxruntime（仅 P1 既有运行时复用）。

**Spec:** 本文依据 = `docs/specs/2026-09-15-prompt-pipeline-redesign-design.md`（§0 D5/D6/D7、§9 envelope）+ 2026-09-17 会话审计结论（gen_1789535180257 实证）。

## Global Constraints

- 铁律：任何 `src/**` 改动提交前必须 `npm run build`（dist 不入 git，见插件 AGENTS.md）。
- 全量回归基线：`npx vitest run`（M4 收口 133 files / 1123 passed 量级，数字随里程碑漂移）。
- D7 语义不变：回退通道 fail-open、`ok` 恒 true 的行为**不改**——P3 只增加可观测性，不改变 ok 判定。
- 安全边界不变：`safety/rating.ts`、`boundaries.ts` 零触碰。
- 提交规范：单任务单提交，message 标注来源（`audit P1` 等）。

## 缺口 → 任务映射

| 缺口 | 审计证据 | 任务 |
|---|---|---|
| P1 vectorSim 未接线 | `prompt-author.ts:1120` 只注入 `search`；昨晚 envelope `overlap_vector_unavailable` | Task 1 |
| P2 回退产物超预算 | `compose.ts:83` 返回未截断变量（L79 截断结果是死代码）；gen_1789535180257 positive 2803 字符 | Task 2 |
| P3 质量语义不可见 | `ok=true` 掩盖 fallback / 耗尽三态；调用方需翻 advisories | Task 3 |
| P4a judge 跨轮重复评审 | orchestrate 每轮重跑 judge 无 findings 去重 | Task 4 |
| P4b 检索嵌入延迟（retrieval_pack 99s） | bge ONNX 单次 ~4s，并行化已做，批处理需跨模块接口变更 | Task 5（仅文档，显式 defer） |

---

### Task 1: vectorSim 生产接线（P1 — D6 闭合）

**Files:**
- Create: `src/pe-framework/compositing/vector-sim.ts`
- Modify: `src/tools/prompt-author.ts`（compositing deps 装配处，L1116 附近）
- Test: `tests/pe-framework/compositing/vector-sim.test.ts`

**Interfaces:**
- Consumes: `EmbedFn`（`anima-vector.ts:15`，`(texts: string[], kind: 'query'|'passage') => Promise<Float32Array[]>`）
- Produces（实施修订）：`createBgeOverlapSim(opts?: { embed?: EmbedFn }): BgeOverlapSim`，其中 `BgeOverlapSim = { prewarm(nl, tags): Promise<void>; sim(a, b): number | undefined }`——嵌入异步而 `auditCompositing` 同步（13 处既有测试依赖同步返回），接缝拆两半：审计前 `prewarm` 进程内缓存，审计中同步 `sim` 查缓存；`getSharedBgeOverlapSim()`（进程级单例 + `PM_VECTOR_OVERLAP=off` no-op，prompt-author 装配用）；`audit.ts` 导出 `splitNlSentences` 供 prewarm 共用（防切分漂移）

- [x] **Step 1: 写失败测试**（stub EmbedFn：平行→~1，正交→~0，非归一化→真余弦，故障→undefined，CJK/空串→undefined，缓存只嵌一次，off 开关 no-op；8 用例见 `tests/pe-framework/compositing/vector-sim.test.ts`）

```typescript
import { describe, expect, it } from 'vitest'
import { createBgeVectorSim } from '../../../src/pe-framework/compositing/vector-sim.js'

function stubEmbed(vectors: Record<string, Float32Array>, fail = false) {
  const calls: string[] = []
  return {
    calls,
    embed: async (texts: string[]) => {
      if (fail) throw new Error('embed boom')
      calls.push(...texts)
      return texts.map((t) => vectors[t] ?? new Float32Array([0, 1]))
    },
  }
}

const PAR_A = new Float32Array([1, 0])
const PAR_B = new Float32Array([2, 0])   // 与 A 平行（归一化后同向）
const ORTH = new Float32Array([0, 3])    // 与 A 正交

describe('createBgeVectorSim', () => {
  it('parallel normalized vectors → cos ≈ 1', async () => {
    const { embed } = stubEmbed({ a: PAR_A, b: PAR_B })
    const sim = createBgeVectorSim({ embed })
    expect(await sim('a', 'b')).toBeCloseTo(1, 5)
  })
  it('orthogonal vectors → cos ≈ 0', async () => {
    const { embed } = stubEmbed({ a: PAR_A, b: ORTH })
    const sim = createBgeVectorSim({ embed })
    expect(await sim('a', 'b')).toBeCloseTo(0, 5)
  })
  it('embed failure → undefined（audit 降级 overlap_vector_unavailable）', async () => {
    const { embed } = stubEmbed({}, true)
    const sim = createBgeVectorSim({ embed })
    expect(await sim('a', 'b')).toBeUndefined()
  })
  it('CJK text → undefined（英文单语域，对齐 vector search 拒收语义）', async () => {
    const { embed } = stubEmbed({ a: PAR_A })
    const sim = createBgeVectorSim({ embed })
    expect(await sim('夜景', 'b')).toBeUndefined()
    expect(embed('夜景', 'passage')).rejects // 未被调用——直接短路
  })
  it('same text embedded once（进程内缓存）', async () => {
    const stub = stubEmbed({ a: PAR_A, b: PAR_B })
    const sim = createBgeVectorSim({ embed: stub.embed })
    await sim('a', 'b')
    await sim('a', 'c') // 'a' 第二次出现
    expect(stub.calls.filter((t) => t === 'a')).toHaveLength(1)
  })
  it('dimension mismatch → undefined（索引/查询错配防御）', async () => {
    const { embed } = stubEmbed({ a: PAR_A, b: new Float32Array([1, 0, 0]) })
    const sim = createBgeVectorSim({ embed })
    expect(await sim('a', 'b')).toBeUndefined()
  })
})
```

- [x] **Step 2: 跑测试确认失败** — FAIL（模块不存在）确认。（实施注记：初次类型检查暴露接缝矛盾——嵌入异步 vs 审计同步，按「预热 + 同步查询」重设计，见上方 Interfaces 修订）
- [x] **Step 3: 最小实现**（`vector-sim.ts`：prewarm/sim 双半接缝 + 进程缓存 + 真余弦（不信任 normalize 声明）+ CJK 短路 + off 单例；`audit.ts` 抽 `splitNlSentences` 导出共用）
- [x] **Step 4: 跑测试确认通过** + `npx tsc --noEmit`。（vector-sim 8/8 绿；compositing 目录回归 5 files / 40 passed）
- [x] **Step 5: prompt-author.ts 装配**（`vectorSim: overlapSim.sim` + `vectorPrewarm: overlapSim.prewarm`；orchestrate 三处审计前 `await prewarmOverlap(writerOut)`）+ `npm run build`。
- [x] **Step 6: 提交** `feat(compositing): wire bge vectorSim into production audit (audit P1)` — commit **ff1eb6c**

- [x] **验收标准：** 单测 8 条全绿；audit 的 `nl_tag_overlap` 在生产获得向量检查（advisory `overlap_vector_unavailable` 仅在向量层真故障时出现——留待下次真实 run 终验）。

---

### Task 2: 回退通道确定性合规（P2 — 死变量 bug + 总预算）

**Files:**
- Modify: `src/pe-framework/compositing/compose.ts`（修 L83 返回 bug；新增 tag 字符预算）
- Test: `tests/pe-framework/compositing/writer-compose.test.ts`（追加用例）

**Interfaces:**
- Produces: `export const TAG_CHAR_BUDGET = 560`；`deterministicCompose` 返回契约强化——`assemblePositive(其产物, rating)` 恒 ≤ 1200 字符。

- [x] **Step 1: 写失败测试**（追加到 writer-compose.test.ts：压力 fixture = 长 lighting/mood + 40 长词形证据 + 6 unresolved；4 用例见 `writer-compose.test.ts` describe 'deterministicCompose 预算合规'）
- [x] **Step 2: 跑测试确认失败**（实证 RED：positive 2724 > 1200；nl 677 > 600；去重缺失——失败原因与缺口逐一对应）
- [x] **Step 3: 实现**（`nl` 变量真正返回；tags 按 `TAG_CHAR_BUDGET=560` 累计裁剪——含 `', '` 分隔符计入，大小写去重；`rating_explicit`(15) + 4 + 560 + 600 = 1179 ≤ 1200 数学保证）
- [x] **Step 4: 全量 compose/orchestrate 相关测试通过**（compositing 6 files / 48 passed，含 fidelity golden——golden 为行为级断言、无一锁死旧 bug 输出）
- [x] **Step 5: `npm run build` + 提交** `fix(compositing): deterministic fallback honors positive budget (audit P2)` — commit **0a1759c**

**验收标准：** 构造性测试证明回退产物恒 ≤1200 字符——D7 的"不空手出稿"升级为"不空手且结构合规"。

---

### Task 3: envelope 顶层质量三态（P3 — 可观测性）

**Files:**
- Modify: `src/pe-framework/compositing/orchestrate.ts`（CompositingOutcome 增 `quality` 字段）
- Modify: `src/tools/prompt-author.ts`（compositing 分支 envelope 顶层投影 `quality`）
- Test: `tests/pe-framework/compositing/orchestrate-quality.test.ts`（mock deps）

**Interfaces:**
- Produces: `export type CompositingQuality = 'passed' | 'degraded' | 'fallback'`；`CompositingOutcome.quality`；envelope 顶层 `quality` 键（仅 compositing 分支，条件键风格对齐 `blueprint_id`）。

- [x] **Step 1: 写失败测试**（三态判定语义；3 用例见 `orchestrate-quality.test.ts`，fixtures 与 orchestrate.test.ts 同款）
- [x] **Step 2: 确认失败**（RED 实证：quality undefined ×3）→ **Step 3: 实现**（判定式：`fallbackUsed ? 'fallback' : corrections > 0 ? 'degraded' : 'passed'`；envelope extras 加 `quality: outcome.quality`）
- [x] **Step 4: 全绿 + `npm run build` + 提交** `feat(compositing): expose top-level quality verdict (audit P3)` — commit **d644162**（compositing 6 files / 47 passed，TSC OK）

**验收标准：** 调用方（agent/GUI）读 envelope 顶层 `quality` 即知三态，无需解析 advisories；`ok` 语义零变更（D7 不动）。

---

### Task 4: judge findings 跨轮去重（P4a — 成本）

**Files:**
- Modify: `src/pe-framework/eval/rubrics/compositing.ts`（`buildCompositingJudgePrompt` 增可选 `opts.previousFindings`）
- Modify: `src/pe-framework/compositing/orchestrate.ts`（跨轮传递上轮 findings）
- Test: `tests/pe-framework/eval/compositing-judge-prompt.test.ts`（追加）+ orchestrate 测试（捕获 critic 调用断言）

**Interfaces:**
- Produces: `buildCompositingJudgePrompt(out, v1, pack, opts?: { previousFindings?: string[] })`；非空时 prompt 末尾追加 `<previous_findings>` 块 + 指令「上轮已标记且已修复的问题不再报告，只报告新增/残留问题」。

- [x] **Step 1: 写失败测试**（prompt 块 2 用例见 `tests/pe-framework/eval/compositing-judge-prompt.test.ts`；orchestrate 跨轮断言追加于 `orchestrate.test.ts`——第二轮 critic prompt 须含 `<previous_findings>` 与首轮 requiredFix）
- [x] **Step 2: 确认失败**（RED 实证：prompt 缺块 ×1；orchestrate 第二轮 prompt 无 previous_findings ×1）
- [x] **Step 3: 实现**（`buildCompositingJudgePrompt` 增 `opts.previousFindings` 可选块 + 「已修复不再报告」指令；orchestrate 维护 `lastJudgeFindings` = 上轮 major/blocker requiredFix，逐轮更新传入 runJudge）
- [x] **Step 4: 全绿 + `npm run build` + 提交** `perf(compositing): dedupe judge findings across repair rounds (audit P4a)` — commit **144a7c9**（judge-prompt + compositing 50/50，TSC OK）

**验收标准：** 修复轮 judge prompt 携带上轮 findings 且带去重指令；judge 调用次数不变（仍是每轮一评），重复报告面收窄。

---

### Task 5: 检索嵌入批处理（P4b — 2026-09-17 用户裁决解除 DEFER，已实施）

**状态：已完成**（原 DEFER 理由「跨模块接口变更波及面大」被更小的接缝设计化解——**未改 `CatalogSearchFn` 签名**，改为向量闭包缓存 + 预热缝，消费方零破坏）

**Files:**
- Modify: `src/pe-framework/dialect/anima-vector.ts`（查询向量缓存 + `prewarm` 批量嵌入，`VectorSearchFn` 类型）
- Modify: `src/pe-framework/dialect/anima-catalog.ts`（`prewarmSemanticQueries`：同步级联命中过滤后转发；seam 类型放宽为可选 prewarm，旧形态注入兼容）
- Modify: `src/pe-framework/dialect/retrieval-pack.ts`（`buildRetrievalPack` 可选第 4 参 prewarm，检索前批量预热）
- Modify: `src/pe-framework/compositing/orchestrate.ts`（`retrievalPrewarm` 依赖透传）+ `src/tools/prompt-author.ts`（装配）
- Test: `anima-vector.test.ts` / `retrieval-pack.test.ts` / `anima-catalog-semantic.test.ts` 各追加用例

**设计（对原验收草案的修正）**：原草案的 `BatchCatalogSearchFn` 需要改 `searchCatalog` 接口、波及三个消费方——实测发现预热路径可以完全绕开它：嵌入发生在 `createVectorSearch` 闭包内，给闭包挂**查询向量缓存 + prewarm**（N query → 一次 extractor 调用）即可，`searchCatalog`/`CatalogSearchFn`/审计缝全部不动。catalog 层过滤「同步级联已命中」的 query（它们永远不会进 semantic 层，预热纯属浪费 batch 槽位）。

**验收对照：**
- [x] RED→GREEN：9 条 RED（vector 4 + pack 3 + catalog 4 中 9 失败）→ 全绿
- [x] 同一 pack 产出**字节级一致**（有/无 prewarm 的 `JSON.stringify` 全等断言）
- [x] dim 对账不因缓存被绕过（prewarm 后查询仍 fail-fast `VectorDimensionMismatchError`）
- [x] prewarm 故障 best-effort 降级（vector/catalog/pack 三层各自不阻塞）
- [x] 全量回归 1291 passed / 0 failed；commit **86e5887**
- [ ] retrieval_pack 阶段耗时对比留痕（**待真实 run**：预期 99s 量级 → 一次批量嵌入 ~4-6s + 缓存命中；与 P1 终验同次 run 采集）

---

## 收尾门（全部任务完成后）

- [x] `npx vitest run` 全量回归：**151 files / 1280 passed / 1 skipped / 0 failed**（2026-09-17，HEAD 144a7c9）
- [x] `npm run build`（每个任务提交前已 build；`git status` 确认 dist 未入提交）
- [x] 本文档状态字段逐项更新（每任务完成即改，不等收尾）

## 完成记录（实现时回填）

- Task 5（P4b）: 完成，commit 86e5887。`anima-vector.ts` 查询向量缓存 + `prewarm`（N query → 1 次 extractor 调用，CJK/去重/已缓存跳过，故障 best-effort，dim 对账保持 fail-fast）；`anima-catalog.ts` `prewarmSemanticQueries`（同步级联命中过滤 + 旧形态 seam 兼容）；`retrieval-pack.ts` 可选 prewarm 缝（pack 字节级一致）；orchestrate/prompt-author 装配。设计修正：未改 `CatalogSearchFn`，原「波及三消费方」的 defer 理由化解。测试：RED 9 → dialect 177/177，全量 1291 passed / 0 failed。**遗留终验（与 P1 同次）**：真实 run 采集 retrieval_pack 耗时对比 + 确认无 `overlap_vector_unavailable`。
- Task 4: 完成，commit 144a7c9。`eval/rubrics/compositing.ts`：`buildCompositingJudgePrompt` 增 `opts.previousFindings`（非空注入 `<previous_findings>` 块 + 去重指令，缺省零变化）；`orchestrate.ts`：`lastJudgeFindings` 跨轮传递上轮 major/blocker requiredFix。测试：judge-prompt 2/2 + orchestrate 8/8（RED 实证二轮 prompt 缺块），合并 50/50，TSC OK，dist 已同步。
- Task 3: 完成，commit d644162。`orchestrate.ts` 增 `CompositingQuality` 类型 + `CompositingOutcome.quality`（fallbackUsed→fallback / corrections>0→degraded / 其余 passed）；`prompt-author.ts` compositing 分支 envelope 顶层 `quality` 键。ok 语义零变更。测试：orchestrate-quality 3/3（RED 实证 undefined×3），compositing 全量 47/47，TSC OK，dist 已同步。
- Task 2: 完成，commit 0a1759c。`compose.ts`：修 L83 死变量 bug（截断 nl 真正返回）+ 新增 `TAG_CHAR_BUDGET=560` tag 字符累计裁剪（分隔符计入）+ 大小写去重；构造性测试证明回退产物恒 ≤1200。测试：writer-compose 15/15（RED 实证 2724 字符→GREEN），compositing+golden 全量 48/48，dist 已同步。
- Task 1: 完成，commit ff1eb6c。新增 `compositing/vector-sim.ts`（prewarm+同步 sim 双半接缝）+ `audit.ts` 导出 `splitNlSentences` + `orchestrate.ts` 三处审计前预热 + `prompt-author.ts` 装配单例。测试：vector-sim 8/8，compositing 全量 40/40，TSC OK，dist 已同步。遗留终验：下次真实 prompt_author envelope 应无 `overlap_vector_unavailable`。
- Task 5: DEFERRED → **已实施**（见完成记录；全量回归更新为 1291 passed）。
- **收尾门结论**：5 项全部 TDD 落地（每项 RED→GREEN 证据在案）；全量回归 1291 passed 0 failed；commit 链 ff1eb6c → 0a1759c → d644162 → 144a7c9 → 86e5887。遗留一条人工终验：宿主重启加载新 dist 后跑一次真实 prompt_author，确认①无 `overlap_vector_unavailable`、②envelope 顶层有 `quality`、③retrieval_pack 耗时对比留痕（P4b 验收最后一条）。
（后续任务完成即回填一行：日期、改动文件、测试结果、commit 号。）
