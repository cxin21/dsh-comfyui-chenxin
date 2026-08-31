# 「完整提示词工程」统一框架 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 PM PE 引擎、Anima catalog/质量策略、MiniMax H3 官方 dialect/tokenizer 三套资产融合进一个五层 TS 框架插件（`prompt_author` 主入口 + 底层工具），每层归化过双跑保真闸门。

**Architecture:** `src/pe-framework/` 五层（intent/schema/dialect/audit/render）+ `prompt_author`/`prompt_compile`/`prompt_audit` 工具；知识资产按保真风险从低到高归化（H3 dialect 规则 → Anima catalog/策略 → H3 tokenizer）；统一审计报告为收敛闭环。

**Tech Stack:** TypeScript (NodeNext ESM)、@deepseek-ai/cordis 4.0.1 + dsh-tools/dsh-llm/dsh-settings、vitest；fixture 双跑可能临时引用 preset Python CLI（仅存 golden 快照，运行不依赖）。

**Spec:** `docs/2026-08-27-prompt-engineering-framework-design.md`（权威，本计划论证自此）——执行者须同时读 spec 与本计划。

## Global Constraints

- **非 git 仓库**：任务闸门 = 测试通过 + 状态记录（沿用 pm-sdd 团队约定）。
- **兼容铁律**：既有 4 工具语义与 53 测试**必须保持绿**（回归闸门每任务必跑 `tests/plugin/` 全量 + `tests/resolver/` 全量）。
- **输出契约**：所有工具返回 string / JSON 字符串（spec §6.2 Envelope）；`usage` 不进返回文本（审计 budget 除外）。
- **保真单一事实源**：归化模块以 **Python 源码**（comfyui-chenxin preset 的 `skills/anima-prompt-v1/anima_prompt_v1/`、`skills/minimax-h3-prompt/h3_prompt/`）为唯一代码来源，计划不臆造实现——步骤给出源文件、方法、闸门。
- **Golden 策略（对抗点 #1 处置）**：双跑保真 = 归化时跑一次旧 Python 输出 → 存 `tests/fidelity/golden/` 快照文件 → 之后 TS 只对比 golden（不依赖运行时 Python）。
- **命名**：新工具名 `prompt_author` / `prompt_compile` / `prompt_audit`；枚举 `Target = 'anima' | 'h3' | 'sd' | 'generic'`。

## File Structure

```
src/pe-framework/
  index.ts            # 框架导出（供工具层 import）
  types.ts            # Target / SlotsSchema / ShotsSchema / AuditReport / StageIO 类型
  intent/             # 内容层：resolver 薄包装（expand/reverse 组装契约）
  schema/             # 结构层：anima-slots.ts / h3-shots.ts / scenes.ts（PM 10 场景→shots）/ templates.ts
  dialect/            # 方言层：anima.ts / h3.ts / sd.ts / variants.ts（mj/danbooru/训练）
  audit/              # 审计层：report.ts（统一报告）/ rules.ts（闸门表）/ budget.ts / tokenizer-h3.ts（P3）
  render/             # 渲染层：envelope.ts（P1 Envelope + target_slot_hint）
src/tools/
  prompt-author.ts    # 主入口编排器
  prompt-compile.ts   # 结构内容 + target → 方言编译 + 审计
  prompt-audit.ts     # 提示词 + target → 审计报告（独立闸门）
  prompt-expand.ts / prompt-reverse.ts / profile-list.ts   # 保留，接框架（行为不变）
tests/fidelity/       # 双跑保真（golden 对比）
tests/plugin/         # 扩展：author/compile/audit 端到端（stub LLM）
tests/audit-loop/     # 修正闭环收敛测试
```

---

### Task 1: 框架类型与骨架

**Files:** Create `src/pe-framework/types.ts`、`src/pe-framework/index.ts`；Create `tests/plugin/framework-types.test.ts`

**Interfaces:**
- Produces: `Target`、`SlotsSchema`、`ShotsSchema`、`AuditGate{rule,target,severity,detail}`、`AuditReport{passed,gates,budget,assumptions,advisories}`、`Budget{counter:'official-tokenizer'|'estimate',tokens,max,over}`、`StageIO`（各层统一输入输出形状 `{target, intent?, slots?, shots?, content?, dialect?:..., audit, render?}`）。

- [ ] **Step 1: 写类型测试**（编译期断言 + 运行时形状断言：`buildAuditReport` 占位由 T2 提供——本任务仅类型与常量：`TARGETS`、`SLOT_ORDER`（Anima，前端权重）、默认 severity 枚举）。
- [ ] **Step 2: 跑测试确认失败**（模块不存在）
- [ ] **Step 3: 实现 types.ts + index.ts**（类型按 spec §7 报告结构与 §3 落位；`SLOT_ORDER` 从 anima-prompt-v1 源码 `composition.py`/SKILL.md 的固定槽序抄录——该顺序影响前端 token 权重，不得改）
- [ ] **Step 4: 测试通过 + 既有 53 回归绿**
- [ ] **Step 5: 闸门记录**（tsc 零错误含新文件投影）

### Task 2: 统一审计报告组件

**Files:** Create `src/pe-framework/audit/report.ts`；Create `tests/plugin/audit-report.test.ts`

**Interfaces:**
- Consumes: T1 的 `AuditReport` 类型
- Produces: `buildAuditReport({gates, budget?, assumptions, advisories}) → AuditReport`（`passed = 无 severety critical 的 gates`）；`isFatal(gate)`；`serializeReport(report) → string`（JSON 字符串，供工具返回）

- [ ] **Step 1: 测试**（passed 判定 / critical 阻断 / budget 缺省 / 序列化稳定）
- [ ] **Step 2: 失败确认 3. 实现 4. 通过 + 回归**

### Task 3: prompt_author 路由壳 + 注册

**Files:** Create `src/tools/prompt-author.ts`；Modify `src/plugin/index.ts`

**Interfaces:**
- Consumes: T1 类型、T2 report
- Produces: `registerAuthorTool(ctx, config)`：参数 `target`(枚举)、`input`(string, 创作意图)、`profile?`、`audit_only?`；P0 版本：`h3/sd/generic` 归化未完成时报错 `DIALECT_NOT_AVAILABLE: <target> 方言未归化`；`anima` 同。编排占位按 StageIO 打桩（后续任务填层）。注册进 plugin（registry 断言工具数 4→5）

- [ ] **Step 1-4: TDD 循环**（目标：未归化 target 的清晰报错；`audit_only` 语义预留给 T14）
- [ ] **Step 5: 回归 53 绿 + registry 断言 5 工具**

### Task 4: 既有 4 工具接入框架 + reverse 介质感知（行为不变）

**Files:** Modify `src/tools/prompt-expand.ts` / `prompt-reverse.ts` / `minimax-scenario.ts` / `profile-list.ts`（仅补框架类型标注与 intent 层薄包装引用，不改既有行为）；Modify `src/pe-framework/intent/index.ts`

**Interfaces:**
- Produces: `intent/index.ts` 导出 `assembleExpandIntent(profile, params)` / `assembleReverseIntent(profile, params)`（薄包装 resolver 组装，返回 `{system, user, maxTokens}`）——供 prompt_author 编排复用（T13）。
- spec §6.1 落地：`prompt_reverse` 的 `media_target` 扩展接受 `anima|h3`（默认 image 行为不变；anima 语义 = 产出"可槽位化的丰富描述"，h3 语义 = 产出"分镜素材"——仅 metadata 标注，编译仍在 dialect 层）——向后兼容（缺省 image 时行为与现在逐字节一致）。

- [ ] **Step 1-4: TDD**（intent 薄包装等价测试：输出 === 原 resolveExpand 输出；工具行为零变化；media_target 扩展缺省兼容断言）
- [ ] **Step 5: 53 + 新测试全绿**

### Task 5: 保真测试基建 + H3 fixture 采集（golden 固化 + 保真粒度契约）

**Files:** Create `tests/fidelity/harness.ts`、`tests/fidelity/golden/`、`tests/fidelity/contracts.md`、`scripts/capture-golden.ts`（可选）

**Interfaces:**
- Produces: `captureGolden(spec)`——一次性用 preset Python CLI 产出 golden 快照（JSON 文件）；`assertGolden(actual, name)` 测试断言。fixture 集：从 `C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\` 及其 `skills/`、`temp/` 里采集 5+ 个真实 H3 story 样本（camera-video 历史 req 是现成来源），固化为 `tests/fidelity/fixtures/h3/*.json`。
- **保真粒度契约（对抗审查 B5 处置，写进 contracts.md）**：① 提示词文本：逐字节一致；② budget 投影：TS 只复刻 Python budget 输出的**官方上下文帧驱动子集**（指导出预算的确定性字段：token 数/上限/over 判定——以官方响应字段为准，20+ 原始字段不全部搬运，投影映射表写入 contracts.md）；③ tokenizer：计数单元=官方上下文帧（含 vision pads），采样逐 token 断言；④ catalog：记录集相等（record_id/prompt_form/usage_count 全字段比较）——**细粒度收窄到"保真承诺"列表，其余为投影而非保真**。

- [ ] **Step 1: 写 harness 与断言测试骨架**
- [ ] **Step 2: 采集 fixtures（真实样本≥5）并运行一次 Python 生成 golden**（venv 路径从插件 Config `presetRoot` 推断，缺失时 goldles 标注 `SKIPPED` 并在报告中说明——不阻塞，golden 已固化）
- [ ] **Step 3-4: harness 通过（对比 golden 文件存在）**
- [ ] **Step 5: 闸门记录**（golden 清单 + 每个样本输入 + contracts.md 定稿）

### Task 6: H3 dialect/预算/闸门 TS 归化（P1）

**Files:** Create `src/pe-framework/dialect/h3.ts`、`src/pe-framework/schema/h3-shots.ts`、`src/pe-framework/audit/rules-h3.ts`；Create `tests/fidelity/h3-golden.test.ts`

**Interfaces:**
- 归化来源（唯一事实源，**逐文件覆盖清单**）：`skills/minimax-h3-prompt/h3_prompt/dialect.py`（官方渲染）、`contracts.py`（shots 契约：时长 4-15、镜头数上限表）、**`audit.py`（377 行——spec §7 示例闸门 cut_timestamps/soundscape_dialogue 的官方文本级审计本体；必须逐条移植为 rules-h3.ts，缺失则 prompt_audit 无法复现官方审计）**、`budget.py`（预算表 1200/1500/1700/1700/2400 + 计数单元）、`multishot.py`（**官方多镜头 plan 校验——纳入本任务作为闸门来源之一**；若与 PM 场景流程冲突，按其语义实现并记录裁决）、`references/budget-policy.json`、`references/*-rules.md`（keyframe/ref2va/t2va 规则）
- Produces: `compileH3(shots, opts) → { text, text_zh }`、`auditH3(text, meta) → gates[]`（闸门规则以 audit.py 为准，contracts.py 为结构契约；不含 tokenizer——T11/12）

- [ ] **Step 1: 移植 dialect 渲染**（从 dialect.py 逐函数对照；输出**逐字符一致**）
- [ ] **Step 2: 移植闸门规则**（audit.py 每条规则 + contracts.py + multishot.py 校验各一条 TS 测试）
- [ ] **Step 3: golden 双跑断言**（Task 5 golden × 新 TS 输出，逐字节）
- [ ] **Step 4: 全量回归**（53 保持绿）
- [ ] **Step 5: 闸门：h3 golden 全过**

### Task 7: PM 场景模板并入 H3 schema + prompt_compile(h3)

**Files:** Create `src/pe-framework/schema/scenes.ts`；Create `src/tools/prompt-compile.ts`（target=h3 分支）；Create `tests/plugin/compile-h3.test.ts`

**Interfaces:**
- Consumes: T6 的 `compileH3`/`auditH3`
- Produces: `sceneToShots(scenarioId, formFields) → ShotsSchema`（PM `resolver/minimax/catalog.ts` 10 场景 + `assemble.ts` 的组装逻辑映射到 shots 结构——映射规则表）；`prompt_compile` 参数 `{target:'h3', shots?, scenario_id?, form_fields?, output_lang?}` → Envelope

- [ ] **Step 1: 场景→shots 映射测试**（full_reference 六段 ↔ official dialect 对齐；其余场景逐 id）
- [ ] **Step 2: prompt_compile 工具（h3 分支）TDD**（无 LLM——确定性编译；audit_only 报审计）
- [ ] **Step 3-4: 通过 + 回归**
- [ ] **Step 5: 闸门**（compile(h3) 端到端产物含 `text`/`text_zh`/`audit.budget.counter='estimate'`——**T12 前一律 'estimate'，禁止提前标注 official-tokenizer（对抗审查 B4 假精确处置）；T12 切换后断言刷新为 'official-tokenizer'**）

### Task 8: Anima catalog 数据接入（P2 定案）

**Files:** Create `src/pe-framework/dialect/anima-catalog.ts`；Create `tests/fidelity/anima-catalog.test.ts`

**Interfaces:**
- **决策点已定案（对抗审查 B3：tag-catalog.sqlite 实测 820MB，非预估 30MB）**：用 node 内置 `node:sqlite`（Node≥22.5，本机 v24 可用）**直读只读** `skills/anima-prompt-v1/knowledge/tag-catalog.sqlite`，查询走 **FTS5/bm25** 或等价索引（catalog/search.py 的匹配语义：canonical/alias/fuzzy/miss 判定与 usage_count 字段）。**开工前先验：该 sqlite 是否带 FTS 虚拟表与索引（pr 查询计划）——若只读无索引则联表/预载方案列入本任务步骤。** `tags.sqlite` 与 `tag-catalog.sqlite` 的区别按源码 inventory 逐表确认（语义归位）。
- **relation-overlay 数据源（对抗审查 B3）：`relation-overlay.sqlite` 默认路径当前不存在**——T9 的 overlay 能力按「缺失降级」实现：查询层检测文件缺失 → 返回空 overlay 视图并在 audit.advisories 标注 `overlay_unavailable`；若 T8 校验发现实际路径/文件名不同，按实测修正路径（不臆造）。
- Produces: `searchCatalog(tag, {mode}) → {match_type, prompt_form?, record_id?, usage_count?}[]`（对齐 `catalog/search.py` 语义）；`overlayView()`（可空）

- [ ] **Step 1: fixture（真实 tag 样本：canonical/alias/fuzzy/miss 各 3+）**
- [ ] **Step 2: 数据源校验（表结构/索引/文件清单实测记录）+ 查询层实现 + golden 双跑**
- [ ] **Step 3-5: 闸门**（记录实测 catalog/tags/relation 文件形态与决策；查询结果集一致）

### Task 9: Anima 策略/互斥/检查 TS 归化 + 证据编译（P2）

**Files:** Create `src/pe-framework/dialect/anima.ts`、`src/pe-framework/audit/rules-anima.ts`；Create `tests/fidelity/anima-golden.test.ts`、`tests/plugin/audit-anima.test.ts`

**Interfaces:**
- 归化来源：`skills/anima-prompt-v1/anima_prompt_v1/{composition.py,grounding.py,inspection.py,output.py,catalog/facets.py,relation_overlay.py}` + `references/{quality-policy,pipeline,inspection-rules,relations}.md`
- Produces: `compileAnima(slots, opts) → {positive, negative}`（SLOT_ORDER 前端权重、质量策略按 variant 注入、互斥对、catalog 证据落词——canonical/alias 直用、fuzzy 高频才用、miss 打标）；`auditAnima(...) → gates[]`（catalog_miss 等）；`applyRelationOverlay`（关系覆盖可查）

- [ ] **Step 1: 质量策略/互斥/检查规则移植 + 单测**（policy per variant：base/aesthetic/turbo）
- [ ] **Step 2: 证据编译管线（searchCatalog→落词→审计标注）**。**fuzzy 语义（对抗审查 B2：与源码一致，修正 spec）**：compile 层对 `fuzzy`/`miss` **一律保留原文**（composition/grounding 行为）；`catalog_miss`/`fuzzy` 写入 `assumptions`/`advisory`（severity 由审计层定），**usage_count≥1000 只是 SKILL.md 给 LLM 的裁决参考阈值，不是编译层自动替换条件**（模型读 advisory 自行决定是否改写）；回归样例：silver hair → 保留原文 + advisory「silvery hair (record 1092824) 可考虑」
- [ ] **Step 3: golden 双跑**（anima 真实 brief 样本≥5）
- [ ] **Step 4: 回归**
- [ ] **Step 5: 闸门**

### Task 10: prompt_compile(anima) + catalog_search 工具

**Files:** Modify `src/tools/prompt-compile.ts`（anima 分支）；Create `src/tools/catalog-search.ts`；Create `tests/plugin/compile-anima.test.ts`、`tests/plugin/catalog-search.test.ts`；Modify `src/plugin/index.ts`

**Interfaces:**
- Produces: `compileAnima` 接入 `prompt_compile`；`catalog_search`（`tag`, `mode`, `limit` → JSON 字符串）；注册（registry 6→7 工具）

- [ ] **Step 1-4: TDD**（compile(anima) 端到端：slots→positive/negative+audit；catalog_search 返回证据）
- [ ] **Step 5: 闸门**（回归 + registry 7）

### Task 11: H3 官方 tokenizer BPE TS 移植（P3）

**Files:** Create `src/pe-framework/audit/tokenizer-h3.ts`；Create `tests/plugin/tokenizer.test.ts`

**Interfaces:**
- 归化来源（唯一事实源）：`skills/minimax-h3-prompt/h3_prompt/token_counting.py` + `knowledge/tokenizer.json`（官方词表）+ `tokenizer_config.json`；`budget.py` 的 budget 计算逻辑
- Produces: `countTokensH3(text) → {tokens: number, ids?: number[]}`（与 Python 逐 token 一致）

- [ ] **Step 1: tokenizer.json 加载器 + BPE 编码测试**（从 token_counting.py 逻辑移植；样例 token 序列断言）
- [ ] **Step 2-4: 实现 TDD + 大样本对比（golden 5+ 文本，含 dialogue 多语用例）**
- [ ] **Step 5: 闸门**

### Task 12: tokenizer 逐 token 双跑保真（最严）

**Files:** Create `tests/fidelity/h3-tokenizer-golden.test.ts`；Modify `src/pe-framework/audit/budget.ts`

**Interfaces:**
- Produces: `budget.ts` 用精确 tokenizer 出具 `Budget{counter:'official-tokenizer'}`；审计层切换：H3 一律精确计数

- [ ] **Step 1: 双跑断言**（同文本 Python token_counting 输出 vs TS——**token 数相等 + 关键 boundary 案例**（多语/emoji/连续空格））
- [ ] **Step 2: budget.ts 切换 + 全部 h3 相关测试刷新断言为精确值**
- [ ] **Step 3-5: 闸门**（精确计数全绿；回归）

### Task 13: prompt_author 全链路 + prompt_audit + 修正闭环（P4）

**Files:** Modify `src/tools/prompt-author.ts`；Create `src/tools/prompt-audit.ts`、`tests/audit-loop/author-loop.test.ts`、`tests/plugin/author-e2e.test.ts`；Modify `src/plugin/index.ts`

**Interfaces:**
- Consumes: intent（T4）+ schema（T1/7）+ dialect（T6/9/10）+ audit（T2/6/9/12）+ render（T14 前 envelope 内联）
- Produces: `prompt_author` 完整编排（intent LLM 组装 → schema → compile → audit → Envelope + `target_slot_hint`）；`prompt_audit`（纯审计闸门）；修正闭环：报告 Critical → 建议 → 模型重跑（**max 2 次修正迭代**，仍不 passed 则交付报告并在 advisories 标注 `loop_exhausted`——对抗点 #6 处置）；registry 7→9

- [ ] **Step 1: author 编排 TDD**（stub LLM：anima 与 h3 两条路径全阶段断言）
- [ ] **Step 2: prompt_audit 工具**（吃文本 + target → audit-only）
- [ ] **Step 3: 修正闭环收敛测试**（坏 prompt → critical → 修正 → passed；不收敛 → loop_exhausted 语义）
- [ ] **Step 4: 回归（53 + 新全绿）**
- [ ] **Step 5: 闸门**

### Task 14: 文档分工 + profile_list target 过滤 + 全量收尾

**Files:** Modify `src/tools/profile-list.ts`（`target` 过滤参数）；Modify `src/tools/minimax-scenario.ts`（描述标注「正式产出走 prompt_author/compile」）；Modify `docs/2026-08-27-prompt-engineering-framework-design.md`（实现后修订）；Create `docs/usage-prompt-engineering.md`（分工手册）

**Interfaces:**
- 对抗点 #8 处置：minimax_scenario 保留但描述与 author/compile 明确分工；pe_* 解耦迁移规则文档化（对抗点 #7）
- **对抗审查 B6（spec §5 漂移）**：`PEProfile` 无 `target` 字段——`profile_list` 的 `target` 过滤按**推导映射**实现（写入手册）：`outputFormat='minimax' → target h3`；`tags 含 'Anima'/'anima3' → target anima`；`outputFormat∈{sd_tags,danbooru_tags} → target sd|danbooru`；`kind='train' → target variants`；其余 → generic。推导表在手册中明示（不确定处给 `target: undefined` 由模型回退）

- [ ] **Step 1: profile_list target 过滤（推导映射）TDD**
- [ ] **Step 2: 工具描述与使用手册（分工矩阵：什么时候用 author/compile/audit/expand/reverse/scenario）**
- [ ] **Step 3-5: 闸门**（53 + 全新增全绿；文档落盘）

---

## 内置对抗性审查（计划自检，写入即处置）

| # | 对抗点（隐藏问题） | 处置（已并入上文任务） |
|---|---|---|
| A1 | 双跑保真依赖运行时 Python（venv 缺失/漂移 → 测试不可跑） | **Golden 快照策略**：归化时固化旧输出，之后只对 golden（T5） |
| A2 | tokenizer 为 H3 专属，SD/Anima 用估算——审计 counter 区分，防误读 | T2 类型 `Budget.counter` 双值；T12 切精确 |
| A3 | catalog sqlite 30MB+ 的 TS 化选型 | T8 决策点（node:sqlite 优先，golden 回退） |
| A4 | 「复用 resolver 组装」可能变成第二套拼凑 | T4 显式 `intent/index.ts` 薄包装 + 等价测试 |
| A5 | prompt_author 编排复杂 → 层逻辑混入编排器 | T3 壳 + 各层纯函数单测；编排只调度（spec 风险 3） |
| A6 | 修正闭环可能永不收敛 | T13 max 2 次 + `loop_exhausted` advisory 语义 |
| A7 | pe_* 解耦后旧 profile 语义迁移 | T14 迁移规则文档化（id 保留为「配方+默认方言」复合） |
| A8 | minimax_scenario 与 author 双实现歧义（模型选错） | T14 描述分工矩阵 |
| A9 | Anima variant（base/aesthetic/turbo）质量策略遗漏 | T9 per-variant 单测 |
| A10 | SLOT_ORDER 前端权重顺序被误改 | T1 从源码抄录 + 测试固化 |
| A11 | Envelope/工具返回不一致（author 返回什么形态） | Global Constraints：全 string/JSON 字符串 |
| A12 | golden 样本脱离真实（人造样例失真） | T5 用 preset 真实调用历史做 fixture |

## 独立对抗审查并入（t25，reviewer 独立核验 2026-08-27）

| # | 对抗发现（源文件实测） | 处置（已并入任务） |
|---|---|---|
| A13 | h3 `audit.py`(377 行)/`multishot.py` 未被任务引用——spec §7 示例闸门出自 audit.py | T6 来源清单扩为全文件覆盖（audit/contracts/multishot/预算/references） |
| A14 | 「fuzzy 高频才用」与源码相反（fuzzy 一律保留原文，usage_count 是 LLM 裁决参考） | T9 语义修正 + spec §6.2 同步修订（本计划附则） |
| A15 | tag-catalog.sqlite 实测 820MB（估错 25 倍）；relation-overlay.sqlite 不存在 | T8 定案 node:sqlite+FTS5、启动校验、overlay 缺失降级 |
| A16 | T7 用估算兑现 official-tokenizer=假精确 | T7 至 T12 前一律 'estimate'；T12 切换并刷新断言 |
| A17 | Python budget 20+ 字段 vs spec 4 字段——保真粒度未定义 | T5 保真粒度契约（文本逐字节 / budget 投影子集 / 计数单元=官方上下文帧） |
| A18 | spec §6.1 reverse 扩能与 §5 target 过滤无落地 | T4 加 media_target 扩展；T14 加 target 推导映射表 |
| M1 | tokenizer 许可是 MiniMax-H3-Community-License（再分发限制） | **记录为已承认债务**：本地自用插件不发布，豁免；若未来发布需法务评估（T11 前再确认一次） |
| M2 | agents/openai.yaml 未处置 | 范围外：OpenAI 兼容 agent 配置，非我们形态（spec §1.2 补充记录） |
| M3 | StageIO flat bag 缺分层类型 | Minor：T1 类型设计按层细分（intent/schema/dialect/audit/render 各自 StageIO 变体） |
| M4 | severity 跨层映射（compile→audit 层级语义） | T2 report 的 severity 枚举含来源层标注 |
| M5 | golden 完整性（sha256 固化，防样本被改） | T5 harness 对 golden 文件做 sha256 清单校验 |