# H3 提示词生成导演深度升级 — 实施方案

日期：2026-09-12
状态：**已实施（2026-09-12）**——Phase 1-7 + 8a 全部落地（提交序列 88c7f77 起）；Phase 8b 多段工程出独立设计稿 `2026-09-12-h3-multisegment-design.md`，未实现。
实施与方案的偏差：① depth 分档管线（原 Phase 7）提前为 Phase 3 的主开关先行落地（7a）；② constraints 块按 hybrid-example 实证投影为**整段提示词最后一个字段**（原方案写 detailed_description 尾部，与示例不符，已修正）；③ Phase 8a cut 白名单按设计落地（hard/match/smash/jump cut、cut to、whip pan、dissolve to、wipe to）。
来源：对比分析 `ailaimi/minimax-h3-director-suite`（WenWu 导演引擎 + hybrid 模式）、`MasterLeos/leos-six-department-directing-team-skill-v1`（六部门导演组）后形成。
结论一句话：我们的工程底座（官方合同审计 / 预算投影 / judge 修正闭环）强于这两个仓库，缺的是把「先导演、后提示词」的方法论装进 schema、编译投影与评审标准。

## 0. 设计原则

1. **官方六段式外壳不动**：`MAX_PROMPT_CHARS=7000`、`max_shots=1+floor((d-1)/3)`、字段顺序、ref 标签合同全部保持；所有改动发生在输入 schema、投影逻辑与评审层。
2. **向后兼容**：所有新字段可选；不传时行为与现状逐字节一致（golden 不变）。
3. **确定性优先**：能用编译投影解决的不进 LLM prompt；能用 gate 判的不进 judge。
4. **每个 Phase 一个提交**（prompt-master AGENTS.md 提交规范，标注 spec 章节），改 src 必跑 `npm run build`。

## 1. 阶段总览与依赖

| Phase | 内容 | 优先级 | 依赖 | 主要文件 |
|---|---|---|---|---|
| 1 | H3 persona / schema 导演化 | P0 | 无 | `intent/subagent-provider.ts` |
| 2 | per-shot duration（反均匀切分） | P0 | 无 | `schema/h3-shots.ts`、`dialect/h3.ts`、`audit/rules-h3.ts` |
| 3 | retention_analysis / subject_definitions 实化 | P0 | 无 | `schema/h3-shots.ts`、`dialect/h3.ts` |
| 4 | `constraints:` 风格/负向约束块 | P0 | 无 | 同上 + `audit/rules-h3.ts` |
| 5 | 导演级 shot 字段 + MultishotPlan 接活 | P1 | Phase 2 | `schema/h3-shots.ts`、`dialect/h3.ts`、`audit/rules-h3.ts`、`tools/prompt-compile.ts` |
| 6 | H3_RUBRIC 扩维 + judge 逐镜覆盖 | P1 | 无 | `eval/rubrics/h3.ts` |
| 7 | 预算分档（quick / director） | P1 | 无 | `audit/budget.ts`、`pipeline/runStage.ts` |
| 8 | 多段工程 / cut 表述放宽 | P2 | 独立设计 | blueprint 层（另行设计） |

---

## Phase 1 — persona / schema 导演化（纯 prompt 工程）

**目标**：intent LLM 产出的 `[Shot N]` 内容达到 WenWu 镜头脉冲密度，不再出现均匀切分、情绪形容词堆叠、无动机运镜。

**改动**（`intent/subagent-provider.ts`，只改 `H3_PERSONA` 与 `H3_SCHEMA` 文本）：

1. 保留现有 4 条兼容规则（refs 标签稳定 / 尊重用户原意 / 最小化补全）。
2. 新增导演规则块：
   - **语言**：`what` 正文用英文书写；中文画面文字与原生对白原样保留（对白进 `dialogue`，画面文字写 "the on-screen text ..."）。当前 persona 未规定语言，存在中英混排正文的隐患。
   - **节奏**：每镜时长由内容决定（Phase 2 提供 `duration` 字段后），禁止默认均匀切分；建立空间的镜给足信息时间，插入证据的镜短促，末镜必须呈现结果落点。
   - **镜头脉冲**：每镜 `what` 按五要素写——画面入口 → 本镜唯一新信息 → 主体可见变化 → 摄影机回应（运镜必须有观看理由）→ 交给下一镜的锚点。
   - **动作因果**：动作写 准备→接触→受力→结果；上一动作的余力可以是下一动作的起因。
   - **表演肌理**：刺激抵达→本能反应被压住→身体泄露→选择→余波；先身体变化，后情绪结论；禁止 "sadly/angrily" 类情绪副词堆叠。
   - **台词**（有 `dialogue` 时）：开口前的身体准备、说话中的重音/停顿、说完后的余波写进 `what`；`dialogue` 只放说出口的原文。
   - **镜头数**：按 `max_shots = 1 + floor((duration-1)/3)` 自查上限，不顶格填满。
3. few-shot：`hybrid-example.md` 的 `[Shot 2]` 片段压缩为 3–4 行嵌入 persona（Anima persona 已有同款「密度基准」做法，参照其格式）。
4. `H3_SCHEMA` 的 shots 示例同步体现 what 密度。

**成本**：persona +600~900 token，零新增 LLM 调用。

**测试**：persona 纯文本变更；若有断言 persona 内容的快照测试则更新。

---

## Phase 2 — per-shot duration（反均匀切分）

**目标**：废除 `shotCutTimes()` 的机械等分（`duration × (i+1) / shotCount`），支持真实节奏。

**改动**：

1. `schema/h3-shots.ts`：
   - `H3Shot` 加可选 `duration?: number`；
   - `coerceShot` 白名单加 `'duration'`，数值校验（>0 的有限数，boolean 拒绝）。
2. `dialect/h3.ts`：
   - 新增 `shotCutTimesFromShots(request)`：所有 shot 显式 `duration` 时按累计求和取切点；否则回退现 `shotCutTimes()` 等分。`buildShotLines` 换用新函数。
3. `audit/rules-h3.ts`（`contractGatesH3` 或新增函数）：
   - **混合模式 gate**（critical，rule=`shot_duration_mixed`）：全部显式或全部缺省，不允许部分显式；
   - **总和 gate**（critical，rule=`shot_duration_sum`）：显式时 `Σ ≡ duration_seconds`（±1e-6）；
   - 单镜下限 advisory（<0.4s 时提示 H3 单镜过短风险）。
4. 现有文本审计零改动（strictly increasing / within duration / 首镜无时间戳已覆盖投影结果）。

**兼容**：不传 `duration` → 等分，golden 不变。

**测试**：等分回退 golden；显式 duration 投影 golden；混合 / 总和不符 gate。

---

## Phase 3 — retention_analysis / subject_definitions 实化

**目标**：替换 `buildRef2vaText` 里的两处模板复述。

**改动**（`schema/h3-shots.ts` + `dialect/h3.ts`）：

1. `Reference` 加可选 `description?: string`（`coerceReference` 白名单同步）。
2. `subject_definitions` 投影：`<Subject N> is ${who} from <Picture N>${description ? ' — ' + description : '.'}`
   - 注意保持 `<Subject N> is` 开头，`auditReferenceLabels` 的定义行正则（`^\s*<(Subject|...)> is\b`）不破坏。
3. `retention_analysis` 投影：按 `shot.who === ref.who` 计算出现镜号，输出
   `<Subject N> (appears in [Shot 2], [Shot 3]) remains fully_preserved: identity, face, outfit, and styling unchanged across all shots.`
   - 出现镜号按 `applySubjectLabels` 同源逻辑（当前只替换每镜第一次 who 命中，镜号判定与之一致）；
   - 某 ref 未出现在任何镜 → advisory `ref_unused_in_shots`（保持非阻塞；`auditReferenceLabels` 的 Picture 硬闸不变）。
4. `partially_preserved` 级别留待 Phase 5（需要计划层的角色状态信息，此处不引入新字段）。

**测试**：golden 更新（ref2va 输出文本变化属预期破坏，更新 golden 并在提交信息注明）；`ref_unused` advisory。

---

## Phase 4 — `constraints:` 风格/负向约束块

**目标**：给 WenWu/hybrid 实践验证过的「风格禁令块」一个正向容器（与 `native_negative=false` 不冲突——这是正文内的风格段）。

**改动**：

1. `schema/h3-shots.ts`：`H3ShotsInput` 顶层加可选 `constraints?: string`；`normalizeH3Input` 接受 formFields.constraints 合并（沿用 F1 的合并模式）。
2. `dialect/h3.ts` 编译投影：
   - `ref2va`：追加到 `detailed_description` 末尾 `\nconstraints: ${text}`；
   - `t2va` / keyframe：追加到 `integrated_multimodal_description` 末尾；
   - 单行化（内部换行折为 `; `），上限 600 字符（超出 advisory `constraints_too_long`）。
3. `audit/rules-h3.ts`：正文出现 `constraints:` 时校验（critical，rule=`constraints_block`）——恰好出现一次、位于对应字段末尾、其后无 `[Shot N]` 标记；未使用 constraints 时不检查（可选特性，缺省输出不变）。
4. persona / H3_SCHEMA：constraints 写作规则（只写本项目确认的风格禁令；负向清单正向化——"no 3D" 允许，禁止堆万能咒语）。
   - 安全性：`auditTimeline` 的 `SHOT_MARKER` 扫描不受影响（constraints 禁含 `[Shot N]` 字样，gate 覆盖）。

**测试**：带 / 不带 constraints golden；重复块、位置错误 gate。

---

## Phase 5 — 导演级 shot 字段 + MultishotPlan 接活（P1 核心）

**目标**：把 `rules-h3.ts` 里零调用的 `MultishotPlan`/`compilePlanToShots`（已含 camera / entryState / exitState / continuityLedger / validateTiming）变成真实路径，实现「先导演、后提示词」。

**改动**：

1. **意图路径（prompt_author）— shot 字段扩展**：
   - `H3Shot` 加可选 `camera?: string`、`action?: string`、`micro?: string`（微表演）、`carry?: string`（出口状态/交镜锚点）；`coerceShot` 白名单同步，全部可选。
   - `buildShotLines` 确定性投影模板（字段存在才投影，句子化不 JSON 化）：
     ```text
     [Shot N] At MM:SS.mmm, the camera cuts to {what}. {camera}. {action}. {micro}. {carry}.
     ```
     投影语句用固定引导词（`The camera responds by ...` / `The action plays out as ...` / `Micro-performance: ...` / `Carrying into the next shot: ...`），由 persona 规定各字段语义。
   - persona 增加字段写作规则（与 Phase 1 的表演肌理/运镜动机规则对应）。
2. **计划路径（prompt_compile）— plan 输入**：
   - `prompt_compile` 检测 plan 形状（含 `shot_count` / `continuity_ledger`）→ `auditMultishotPlan` 校验 → **扩展** `compilePlanToShots`：现仅投影 `content + soundFocus`，改为 camera/action/entryState/exitState 参与投影（模板同上），`start/end` 映射为 Phase 2 的显式切点；`continuityLedger.identity / wardrobe_and_props` 非空校验沿用 `compilePlan`。
3. 投影后 `what` 可能增长 → 与 Phase 7 的 director 档预算配套。

**测试**：plan→shots 投影 golden；`auditMultishotPlan` gates；端到端 `prompt_compile(plan)` → audit pass；旧扁平输入逐字节兼容。

---

## Phase 6 — H3_RUBRIC 扩维 + judge 逐镜覆盖

**目标**：评审标准覆盖导演质量，不只结构与一致性（对应 Leos「六角色 × 每镜全覆盖审稿」）。

**改动**（`eval/rubrics/h3.ts`，纯配置）：9 维重配权重（和=1）：

| 维度 | 权重 | 要点 |
|---|---|---|
| shot-structure | 0.15 | （现有）句序/字段完整 |
| shot-increment | 0.10 | （现有）相邻镜语义增量 |
| cross-shot-consistency | 0.20 | （现有，保留最高权重）身份/ref 引用一致 |
| duration-fit | 0.05 | （现有）内容量与时长匹配 |
| pacing | 0.10 | （现有）节奏曲线 |
| atmosphere-coupling | 0.10 | （现有）氛围锚点 |
| **performance-causality** | 0.15 | 新：动作因果链完整；表演是刺激→压住→泄露→选择→余波，而非情绪形容词 |
| **continuity-exit-entry** | 0.10 | 新：相邻镜出口/入口状态可核对，锚点交接 |
| **camera-motivation** | 0.05 | 新：运镜有观看动机与可见结果，非术语展示 |

每个维度 instruction 末尾追加逐镜覆盖要求：**逐镜检查；无问题的镜头也要显式标注通过**，禁止只挑问题镜、禁止整段概评替代逐镜检查。`passThreshold: 75` 保持。

**测试**：judge 合同测试若断言维度数/权重和则更新。

---

## Phase 7 — 预算分档（quick / director）

**目标**：导演级内容有写作空间；quality cap 是 advisory 投影，分档零阻塞风险。

**改动**：

1. `audit/budget.ts`：加 `STAGE_QUALITY_CAPS_DIRECTOR = { t2va: 2800, i2va: 3200, fl2va: 3600, l2va: 3600, ref2va: 4800 }`；`buildH3Budget` options 加 `depth?: 'quick' | 'director'`（缺省 quick = 现状）。
2. `pipeline/runStage.ts`：budget 调用 ctx（第 63 行）透传 `formFields`；dialect budget 回调读 `ctx.formFields?.depth`。
3. `tools/prompt-compile.ts` / `prompt-audit.ts` / prompt-author：暴露 `depth` 透传。
4. `charLimit 7000` 硬闸不变；`budget.over` 仍仅投影。

**测试**：depth=director 的 qualityCap；缺省 quick 兼容。

---

## Phase 8 — P2 roadmap（独立设计，不在本方案展开）

1. **多段工程**：>15s 输入拆段 + 文字锚点交接（禁引用上段尾帧）+ meta（world_anchors / audiovisual_signature / sound_events / 镜头卡），依托 blueprint 层；先出独立设计稿。
2. **cut 表述放宽**：`auditShotExecution` 现只认 `^(the camera|the shot|camera|shot)\s+(cuts|transitions|changes|switches)\s+to\b`；hybrid 实例的 `hard cut. …` 会被拒。拟放宽为 `^hard cut\b` / `^match cut\b` / `^smash cut\b` / `^whip pan\b` / `^cut to\b` 等。**前置条件**：与官方文档复核这些表述均为 model-native 转场后再动，属启发式变更（该 gate 本身已是 important 非 critical）。

## 2. 验收与流程

- 每 Phase：`npx vitest run`（基线 831 passed 不回归 + 新增用例）→ `npx tsc --noEmit` → `npm run build`（dist 同步铁律）→ 单一意图提交。
- 端到端人工验收：同一创作意图分别用旧/新链路出稿，对比 `[Shot N]` 文本密度、切点分布、retention 是否携带镜号信息。
- 破坏性变更登记：Phase 3 的 ref2va golden 文本变化、Phase 5 的 shots schema 白名单扩大，在提交信息与 CHANGELOG 注明。

## 3. 风险与缓解

| 风险 | 缓解 |
|---|---|
| persona 变长推高 intent 成本 | few-shot 压缩至 3–4 行；规则块用短句；总增幅控制在 ~900 token |
| shot 白名单扩大后 LLM 填充噪声字段 | 字段全部可选；投影模板克制（存在才投影）；persona 明确「宁缺勿滥」 |
| constraints 块与官方未来版本冲突 | 可选特性，缺省不输出；gate 仅在显式使用时生效 |
| 非均匀切分被误用（总和不符） | 编译前 critical gate 硬校验 + 混合模式拒绝 |
| 正则放宽偏离官方合同（Phase 8） | 放 P2，要求文档证据后再执行 |
