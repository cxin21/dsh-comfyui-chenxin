# 二期实施计划：enrich 扩写 + 默认评审 + 一期遗留全量补齐

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox。
> 工作目录：plugins/prompt-master（main，用户已同意直接落 main）。

**Goal:** enrich 扩写层（七维度 brief + 语言归一化）+ judge 默认 fast + 一期审计 P0-P3 全量补齐（A1-A17）。

**Architecture:** enrich 在 intent 前产出七维度 brief（LLM/subagent，降级跳过）；critic schema 升级为维度加权评分 + 证据回查 + 独立复审契约；offline loop 驱动器 CLI 级。全程不碰确定性编译路径。

**Tech Stack:** 不变（TS/tsc/ESM、node:sqlite、vitest、DSH subagent-provider）。

**Spec:** `docs/2026-09-08-enrich-default-judge-design.md`（§1-§9 主体 + §10 增补 A1-A17）

## Global Constraints

- 改 src 后提交前 `npm run build`（dist 不进 git）；`npx vitest run` 基线 **711 passed / 0 failed** 只升不降；`npx tsc --noEmit` 干净
- golden 零破坏：enrich/critic 改动均不进确定性编译路径
- enrich/critic 任何故障 → 降级（enrich_skipped / judge_skipped）+ advisory，**绝不阻塞出稿**
- audit_only 跳过 enrich 与评审；用户显式指定（source='user'）为硬约束
- 评审默认值切换放最后一个任务（依赖前序稳定）
- 单一意图提交，message 带 spec 章节标注；禁止混入工作区脏文件（confirm.py / manifest.json / 5 个 2026-08-* 文档）
- sql.js 时代的教训：运行时加载 dist，所有 src 改动必须 build 后才对 DSH 生效

---

### Task 1: critic schema v2 — 维度加权评分 + finding id + evidenceOptional

**Files:** Modify `src/pe-framework/eval/critic.ts`、`src/pe-framework/eval/rubrics/contract.ts`、两个 rubric ts；Test `tests/pe-framework/eval/critic.test.ts`
**Interfaces（后续任务依赖）:**

- `CriticFinding` 增 `id: string`（首轮内 f1…fN 稳定编号；证据回查/复审/rebuttal 引用它）
- judgeReview 输出 schema：`dimensionScores: Record<dimId,0-100>` 必填；`score = round(Σ weight×dimScore)`（代码计算，LLM 不再产总分；返回含非法 dimId 或缺维 → 整体 skipped）
- `DialectRubricDimension` 增 `evidenceOptional?: boolean`；该维度 findings 无证据 → 放行并标 `evidenceAssumed: true`
  **Steps:** TDD——先写失败测试（加权计算、非法维度 skipped、evidenceOptional 放行、finding id 稳定性），再实现；rubric 两文件维度补 `evidenceOptional`（anima: aesthetics=true；h3: pacing=true, atmosphere-coupling=true）+ h3 shot-structure 指令补「cut 时间戳与镜头时长抽查（评委复核）」（A5/A6/A8/A2 前置）；全量回归 + build + `git commit -m "feat(eval): critic schema v2 维度加权评分 (spec §10.1-A2前置, §10.2-A5/A6/A8)"`

### Task 2: 证据回查复核（A1）

**Files:** Modify `src/pe-framework/eval/critic.ts`；Test 同文件用例追加
**Interfaces:** `judgeReview` 输入 `bridge` 变为可选（`bridge?: EvidenceBridge`，未传跳过回查=向后兼容）
**Steps:** TDD——findings parse 后逐条回查：`bridge.query(tool,query)` ok=false → 丢 finding；成功但 result 与 claimed result 实词交集为空 → 丢；bridge.query 抛错 → 全部保留 + 内部标志 `evidence_unverified`（runStage 转 advisory，透传给 Task 4 的 judge-stage 测试）；全部 blocker/major 被丢后按既有「无证据不打回」归一。单测覆盖：真命中保留/编造丢弃/bridge 抛错保留/未传 bridge 跳过。全量回归 + build + `git commit -m "feat(eval): 证据回查复核闭环 (spec §10.1-A1)"`

### Task 3: strict 复审独立契约（A2）

**Files:** Modify `src/pe-framework/eval/critic.ts`、`src/pe-framework/pipeline/runStage.ts`（debate round2 score 透传）；Test critic + judge-stage
**Interfaces:**

- revision 轮 provider 收到独立 schema：`{ verdict, closedFindingIds: string[], unresolved: string[], rebuttalVerdicts: [{finding_id, accepted, reason}] }`
- `CriticOutcome` 不变；revision 轮产出映射：score=首轮 score；findings=unresolved 映射回原 finding（保留原 id）；rebuttalVerdicts 进 runStage 组装 round2.reviser.rebuttals
  **Steps:** TDD——revision 轮 prompt 断言不含「重新评审」字样、含 closedFindingIds 任务；pass 条件=blocker/major 全关闭或反驳被接受；runStage debate round2.reviewer.score=首轮分。全量 + build + `git commit -m "feat(eval): strict 复审独立契约只验关闭与反驳 (spec §10.1-A2, §2.3)"`

### Task 4: revisionProvider v2 — praise 锚点 + 结构化 rebuttals + 稿内编辑 + judgeRepair 开关（A3/A4/A12/A13）

**Files:** Modify `src/tools/prompt-author.ts`、`src/pe-framework/pipeline/runStage.ts`（revisionNote→结构化直通，内嵌 JSON 解析留兜底）；Test author-judge.e2e + judge-stage
**Interfaces:**

- `makeRevisionProvider` v2 输入增 `praise: string[]`；输出 `{ compiled, changes, rebuttals, revisionNote }`（rebuttals 结构化直通 runStage）；稿内编辑：按 finding 定位 slot/shot 字段 patch，patch 失败回退整稿重拆（现行为）
- `judgeRepair?: boolean` 默认 true；false 时修正轮 runStage 不带 judgeOpts（省 critic 调用）
  **Steps:** TDD——praise 进修订 prompt；rebuttals 结构化产出进 debate round2（生产路径不再是恒空）；patch 成功不重拆/失败回退；judgeRepair=false 时修正轮 provider 零调用。全量 + build + `git commit -m "feat(tools,pipeline): revisionProvider v2 结构化反驳与稿内编辑 (spec §10.2-A3/A4, §10.4-A12/A13)"`

### Task 5: enrich 层 — brief schema + personas + engine（§2，A11 无需做）

**Files:** Create `src/pe-framework/enrich/{brief.ts,personas.ts,engine.ts}`；Test `tests/pe-framework/enrich/engine.test.ts`
**Interfaces:**

- `EnrichedBrief`（spec §2.2：outputLang + 七维度 `[{text, source}]` + nameAnchors）
- `runEnrich(input: { target; userInput; outputLang?; provider: CriticProvider }): Promise<{ brief: EnrichedBrief } | { skipped: true; reason: string }>`
- persona 按 target 区分（anima 富化画面词/h3 富化分镜不增镜头数）；anima outputLang 锁 'en'；h3 用 `detectLanguage`（dialect/h3.ts）+ 显式指定优先
  **Steps:** TDD——schema 校验（七维/枚举/锚点形状/**大小上限：每维度 ≤6 条、单条 ≤200 字符，超限整体 skipped 不截断**）；正常路径；三类故障 → skipped；Anima 锁 lang。全量 + build + `git commit -m "feat(enrich): 扩写引擎与 brief schema (spec §2, §4, §11.2)"`

### Task 6: author 接线 enrich + 语言归一化落 intent（§2.1/§4）

**Files:** Modify `src/tools/prompt-author.ts`；Test `tests/plugin/author-enrich.e2e.test.ts`（新）
**Interfaces:**

- 入参 `enrich?: boolean`（本任务先默认 false，Task 8 切 true）+ `outputLang?: 'en'|'zh'|'ja'`
- 成功路径：enrich brief → intent 的 user 输入替换为 brief 的结构化文本（intent persona 增加「brief 是权威输入，source='user' 字段不可改」指令）；nameAnchors 随 brief 进 intent 并透传到 h3 的 references/角色一致性上下文
- Envelope 顶层 `enrichment: { brief, skipped? }`；`enrich_skipped` advisory 降级路径
- 落库标记：`GenerationRow` 增 `enrich: 0|1` 列（store schema 加列，旧库 ALTER 兼容；T7 的 store 打包若已合入则此处补 ALTER 迁移），author 落库时写入——A3 语料区分有无扩写（spec §11.3）
  **Steps:** TDD——七规格：缺省 false 行为不变；enrich=true brief 进 intent（断言 intent prompt 含 brief 字段）；降级不阻塞；audit_only 跳过；outputLang 锁定；nameAnchors 透传（锚定经 brief→intent 固化进 compiled，critic 评 compiled 即见，无需单独传参——spec §11.4）；generations.enrich 落库断言。全量 + build + `git commit -m "feat(tools): author 接线 enrich 扩写层 (spec §2.1, §4, §11.3)"`

### Task 7: 一期卫生打包 — A7/A10/A14/A15/A16/A17

**Files:** Create `src/pe-framework/feedback/vocab.ts`；Modify `src/pe-framework/feedback/store.ts`、`src/tools/prompt-feedback.ts`、`src/pe-framework/optimize/harness.ts`；Test 对应三个测试文件
**Steps（一个提交打包，均为小项）:**

1. A7 `FEEDBACK_TAG_VOCAB` 两 target 词表；record 校验非词表 tag → 接受 + advisory `tag_not_in_vocab`
2. A10 `statsFeedback` 增 `alignment: {pairs, avgJudge, avgHuman, pearson|null（<5 为 null）}`；stats action 透出
3. A14 dbPath 默认迁 `data/runtime/feedback.sqlite`：解析函数首用时旧路径存在则 move；AGENTS.md 落点行同步（preset 层文档）
4. A15 `listFeedback/listGenerations` 增 `limit?` 参数；harness 调用传 5000
5. A16 store 导出 `rowToFeedback`，prompt-feedback 复用删重复映射
6. A17 internal_error 测试（坏 dbPath）+ 三个测试文件 mkdtempSync afterEach 清理
   每小项先红后绿；`git commit -m "feat(feedback): 词表/校准视图/迁移/卫生项打包 (spec §10.2-A7, §10.3-A10, §10.4-A14-A17)"`

### Task 8: optimize-loop 驱动器（A9）

**Files:** Create `scripts/optimize-loop.mjs`；Modify `package.json`（`"scripts": {"optimize:loop": "node scripts/optimize-loop.mjs"}`）
**Steps:**

1. CLI 参数：`--target anima|h3 --persona <file> [--limit N] [--mock]`；读 dist 模块（ESM import file URL，模式同 T11 验收脚本）
2. 串：loadEvalset → coldStartReady（未达标打印缺口并退出码 2，`--force` 覆盖）→ proposeMutation（provider 走 createSubagentCriticProvider 或 `--mock` 固定回复）→ evaluateCandidate（runWith 调 author 管线：`--mock` 用固定评分函数，真跑用 runStage）→ renderMarkdown 写 `temp/optimize/<target>-<ts>.md`
3. 冒烟测试 `tests/pe-framework/optimize/loop-smoke.test.ts`：--mock 模式 spawn 脚本断言报告文件产出（或抽 runLoop 函数直测——**优先抽 `src/pe-framework/optimize/loop.ts` 纯编排函数 + 薄 CLI 壳**，可测性优先）
   `git commit -m "feat(optimize): 迭代循环驱动器 CLI (spec §10.3-A9)"`（build 后）

### Task 9: 默认值切换 + 存量测试修正（§3，最后执行）

**Files:** Modify `src/tools/prompt-author.ts`（judge 默认 'fast'、enrich 默认 true）；修所有受影响测试
**Steps:**

1. grep 缺省路径断言（`judge===undefined` / provider 零调用 / 无 enrichment）→ 改为显式 `judge_mode:'off'` + `enrich:false`（语义保持）或改为新缺省语义（按测试意图选择，逐个判断并在报告列清单）
2. 新增断言：缺省=fast+enrich（provider 被调、enrichment 段存在）
3. AGENTS.md / troubleshooting 同步：默认双开、典型 3 次 LLM 调用、关闭方法
4. 全量 `npx vitest run` ≥711+新增；build；`git commit -m "feat(tools): judge 默认 fast + enrich 默认开 (spec §3, 设计 §3/§2.4)"`

### Task 10: 终审 + 登记

- 独立终审（跨任务一致性：finding id 贯穿 critic→runStage→revision；加权分与 rubric 权重一致；enrich 降级路径全核）
- `docs/plans/TASK_TRACKING.md` 登记二期；`git commit -m "docs: 二期 enrich+默认评审+遗留补齐登记"`

## Self-Review 记录

1. **Spec 覆盖**：§10 增补 A1(T2)/A2(T3)/A3+A4+A12+A13(T4)/A5+A6+A8(T1)/A7+A10+A14+A15+A16+A17(T7)/A9(T8)/A11(审计误报，evalset 目录已实测存在，划掉)；§1-§9 主体 T5/T6/T9。**二审补遗**（spec §11）：brief 大小上限(T5)、GenerationRow.enrich 列(T6)、否决=追溯+自然语言不做 API、nameAnchors 不单独传——均已入对应任务。无缺口。
2. **占位符**：无 TBD；「逐个判断」处为测试语义决策，属实施者职责并要求报告列清单。
3. **类型一致性**：CriticFinding.id（T1 定义，T2/T3/T4 消费）；dimensionScores（T1 产，T3 复审沿用首轮分）；rebuttals 结构化（T4 产，T3 契约消费）；GenerationRow.enrich（T6 写，T7 schema 归属注意任务顺序——若 T7 先合入则 T6 补 ALTER）；签名一致。
