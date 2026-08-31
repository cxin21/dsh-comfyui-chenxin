# 「完整提示词工程」统一框架 · 设计文档（正式 Spec）

> 版本：v1.0 · 日期：2026-08-27 · 状态：**已定稿（经 brainstorming 三节确认）**
> 路径：Architectural（brainstorming → spec → writing-plans）
> 演进自：`docs/2026-08-27-native-plugin-design.md`（第一版原生插件，已实施；本 spec 在其基础上融合三套资产）
> 依据：`docs/2026-08-27-native-plugin-implementation.md`（P0-P3 已交付：4 工具 / 53 测试绿）、comfyui-chenxin preset 的 anima-prompt-v1 与 minimax-h3-prompt 技能（源码已核验：纯确定性本地计算）

## 1. 概述

### 1.1 目标

把「提示词大师」PE 引擎、Anima 标签证据库/质量策略、MiniMax H3 官方方言/tokenizer 三套资产，融合为**一个完整的提示词工程**（统一 TS 插件 + 五层管线）：

| 原则 | 含义 |
|---|---|
| 方法论优先 | 领域抽象为一条普适管线，三套执行体是它的三个实例；代码只是落地 |
| 生成优秀提示词 | 词汇可查证 + 官方合规可核算 + 生成可审计可迭代 + 内容可跨目标复用 |
| 融合不封装 | 知识资产归位到对应层级（方言层/审计层/结构层），而非三套并列 |
| 质量可证明 | 每个从 Python 归化到 TS 的模块过「双跑保真闸门」（新旧输出逐字节/逐 token 一致） |
| 保留兼容 | 既有 `pe_*` profile、4 工具语义、53 测试保持可用/绿 |

### 1.2 非目标 / 范围外（本期）

- camera-image / camera-video 执行端不动（仅做输出对齐）
- JoyCaption 额外选项（no-glasses 等）是否复活——独立决策，不进本期
- 专属「训练打标工具」不进本期（打标能力作为方言变体归位）
- 不做多用户/云同步/插件市场

### 1.3 已定决策（D1-D5）

| # | 决策 | 定案 |
|---|---|---|
| D1 | 产品形态 | 流水线主入口 `prompt_author` + 底层工具可独立调用/被编排 |
| D2 | 融合深度 | 管线层融合 + 分层归化：架构一次到位，知识按保真风险从低到高逐模块 TS 化 |
| D3 | 方法论 | 五层框架（Intent→Schema→Dialect→Audit→Render）+ 配方×方言正交解耦 + 统一审计报告 |
| D4 | 保真策略 | 双跑对比闸门（旧 Python CLI 输出 vs 新 TS 输出逐字节一致）为归化唯一通行证 |
| D5 | 范围 | 执行端不动；训练打标专属工具与 JoyCaption 后议 |

## 2. 领域抽象：普适管线（方法论核心）

三个实例（Anima / MiniMax H3 / PM 通用）本质是**同一条管线五阶段**：

```
创作意图 Intent ─→ 内容创作 Content（LLM：扩写/反推/分镜素材）
                        ↓
               结构 Schema（目标媒介规范：Anima slots / H3 shots / 通用模板）
                        ↓
               方言编译 Dialect（目标模型词汇语言：Anima→catalog 证据；H3→官方 dialect；SD→tag 规范）
                        ↓
               审计 Audit（模型硬规则 + 预算：catalog_miss / 时间戳闸门 / 精确 token / 互斥对）
                        ↓
               渲染输出 Render（可执行提示词 + 审计报告 → camera-image / camera-video / 复制）
```

**归位结论**：PM 引擎强项在「内容创作 + 通用结构 + 输出格式」；Anima skill 强项在「方言编译（catalog 证据）+ 审计规则」；H3 skill 强项在「方言编译（官方 dialect）+ 硬闸门 + 官方 tokenizer」——三者是管线的互补切片。

**重构要解决的三个架构问题**：
1. profile 把「配方」与「方言」耦合 → 解耦为正交两维（§5）
2. 三套审计各自为政 → 统一审计报告结构（§7）
3. token 计数不统一（PM 估算 vs H3 官方） → 精确计数归位为方言层知识（§3）

## 3. 目标架构与知识资产落位

```
prompt_author（主入口：target = anima | h3 | sd | generic）
   │                                  ▲ 审计修正闭环（报告回读 → 重编译/重创作）
   ▼
src/pe-framework/
  ├─ intent/    内容层：resolver 复用（expand/reverse 组装纯函数，1:1 保留）
  ├─ schema/    结构层：Anima slots 定义 + H3 shots 契约 + 通用模板 + PM 10 场景→shots + 三语模板
  ├─ dialect/   方言层：anima(→catalog 编译) | h3(→official dialect 渲染) | sd(→tag 规范) | variants(mj/danbooru/训练)
  ├─ audit/     审计层：统一审计器（词汇 miss / 硬闸门 / 预算 / 互斥对 / 质量策略）+ 官方 tokenizer（P3 归化）
  └─ render/    渲染层：P1 Envelope 组装 + target_slot_hint（对接 camera-*）
```

| 知识资产 | 来源 | 归位层 | 新形态 |
|---|---|---|---|
| Profile 配方（style/length/lang/outputFormat） | PM 44 个 | 意图+结构层 | **配方×方言解耦**（§5） |
| taxonomy / QTAG | PM | 结构层 | TS 保留 |
| Anima tag-catalog（sqlite 大库） | anima skill | 方言层 | 数据资源（sqlite 只读或 TS 数据，P2 归化时定） |
| Anima 质量策略/互斥对/检查规则 | anima skill | 审计层 | TS 规则 |
| H3 官方 dialect 模板/预算表/硬闸门 | h3 skill | 方言+审计层 | TS（P1 归化，双跑保真） |
| H3 官方 tokenizer | h3 skill | 审计层（精确计数） | TS 移植（P3 归化，双跑最严） |
| H3 中文骨架/多语输出 | h3 skill | 渲染层 | TS |
| PM 10 场景模板 + h3-reference 三语 | PM | 结构层 | TS（并入 H3 结构） |
| 12 训练打标（SD/MJ/Danbooru/e621…） | PM | 方言层（输出变体） | 配方/方言切换输出 |

## 4. 模块职责（做什么 / 怎么用 / 依赖什么）

| 单元 | 做什么 | 依赖 |
|---|---|---|
| `src/pe-framework/intent/*` | 内容创作纯函数（复用 resolver 的 resolveExpand/resolveReverse 组装） | resolver（不改） |
| `src/pe-framework/schema/*` | 目标媒介结构规范与校验（slots/shots/模板） | TS 数据 + 校验纯函数 |
| `src/pe-framework/dialect/*` | 按 target 编译词汇/官方语言；catalog 证据落词 / H3 官方渲染 / tag 规范 | 知识数据（catalog、dialect 模板） |
| `src/pe-framework/audit/*` | 统一审计器：规则表 + tokenizer 精确计数 → 审计报告 | dialect（规则来源）、tokenizer |
| `src/pe-framework/render/*` | P1 Envelope 组装 + target_slot_hint | — |
| `src/tools/prompt-author.ts` | 主入口编排：intent→schema→dialect→audit→render + 修正闭环 | 五层 + ctx.llm（内容层） |
| `src/tools/prompt-compile.ts` | 结构内容 + target → 方言编译 + 审计（author 内部同函数，独立可调） | dialect + audit |
| `src/tools/prompt-audit.ts` | 给定提示词 + target → 审计报告（修正闭环闸门） | audit |
| `src/tools/{prompt-expand,prompt-reverse,profile-list}.ts` | 意图层/配方层工具（保留语义，接入框架） | resolver、settings |
| `src/llm/complete.ts`、`src/llm/route.ts` | 保留（第一版产物，不动） | — |

## 5. 配方 × 方言 正交解耦

- **配方维度**（"怎么说"）：风格（自然/SD 标签/MJ 关键词/散文）、语言 zh/en、篇幅 short/medium/long、附加要求
- **方言维度**（"给谁看"）：`target ∈ {anima, h3, sd, danbooru, mj, generic}`——决定词汇编译与审计规则
- 同一配方可编译到多个目标（一次创作、多目标输出）
- 兼容：`pe_*` id 保留可查；`profile_list` 支持按 target 过滤

## 6. 工具面与 `prompt_author` 编排

### 6.1 工具面

| 工具 | 角色 |
|---|---|
| `prompt_author` | 主入口：target + 创作输入 → 全管线产出（可执行提示词 + 审计报告） |
| `prompt_expand` / `prompt_reverse` | 意图层（保留；reverse 的 media_target 扩为 anima/h3 感知） |
| `prompt_compile` | 方言+审计层（author 内部即调，独立可用） |
| `prompt_audit` | 审计层（独立闸门） |
| `profile_list` | 配方层（保留五动作 + 按 target 过滤） |
| `catalog_search` | （Anima 方言证据）可选独立暴露 |

### 6.2 编排数据流

```
输入：target + 创作意图（一句话/图/描述）+ 可选配方
 1. 意图补齐（LLM）：intent → 结构化素材（Anima slots 草稿 / H3 shots 草稿 / 描述块）——复用 resolver 组装
 2. 结构规范：素材 → 目标 schema（槽位补全校验；H3 时长/镜头数/声景字段）
 3. 方言编译（确定性）：anima：每槽 catalog.search 证据落词（**canonical/alias 直用；fuzzy/miss 保留原文并写入 assumptions/advisory——usage_count≥1000 仅作模型裁决参考，编译层不自动替换**，已按 anima-prompt-v1 源码 composition/grounding 行为核验）+ 质量策略/互斥；h3：shots → 官方 dialect + 中文骨架 + 预算；sd：tag 规范/长度/清洗
 4. 审计（确定性）：统一审计器 → 报告
 5. 输出 P1 Envelope：{ ok, result, variants?, audit, advisories, target_slot_hint }
 6. 修正闭环：Critical 违规 → 报告带修正建议 → 模型重编译/重创作 → 收敛
```

## 7. 统一审计报告结构

```jsonc
{
  "passed": false,
  "gates": [
    { "rule": "catalog_miss", "target": "anima", "severity": "critical", "detail": "silver hair → 应改 silvery hair" },
    { "rule": "cut_timestamps", "target": "h3", "severity": "critical", "detail": "Shot 2 时间戳早于 Shot 1 结束" },
    { "rule": "soundscape_dialogue", "target": "h3", "severity": "important", "detail": "…" }
  ],
  "budget": { "tokens": 2148, "max": 2400, "over": false, "counter": "official-tokenizer" },
  "assumptions": ["catalog_miss:silver hair"],
  "advisories": ["LoRA 拥有光照，勿写 lighting term"]
}
```

## 8. 归化顺序与双跑保真闸门

| 序 | 归化模块 | 来源 | 保真风险 |
|---|---|---|---|
| P1 | H3 官方 dialect 模板 / 预算表 / 闸门 + PM 场景/三语模板合并 | h3 skill + PM | 低（纯文本/数值表） |
| P2 | Anima catalog 数据层 + 质量策略/互斥对/检查规则 | anima skill | 中（数据+规则枚举） |
| P3 | H3 官方 tokenizer（BPE） | h3 skill | 高（逐 token 精确） |

**双跑闸门**：同一批 fixture → 旧 Python CLI 输出 vs 新 TS 输出 → 逐字节/逐 token/记录集一致断言；**fixture 用真实调用历史**（`~/.dsh/.agent-presets/comfyui-chenxin/` 的 brief.json / story 样本 / camera-video 历史）；不过闸门不并入主线。

## 9. 测试策略

1. `tests/fidelity/`：每归化模块的双跑保真对比
2. `tests/plugin/` 扩展：`prompt_author` 端到端（stub LLM + 确定性层）断言完整 Envelope；既有 53 测试保持绿
3. `tests/audit-loop/`：坏输入 → Critical 报告 → 修正 → passed 收敛断言

## 10. 实施批次（P0→P4）

| 期 | 内容 | 验收 |
|---|---|---|
| P0 框架 | 五层目录 + `prompt_author` 路由壳 + 统一审计结构 + 现有 4 工具接入框架（行为不变） | 53 测试绿 + 新结构 tsc 干净 |
| P1 H3 归化① | dialect/预算/闸门 + 场景模板合并 → TS 双跑 | h3 fixture 保真全过 |
| P2 Anima 归化 | catalog 数据层 + 质量策略/互斥/检查 → TS 双跑 | anima fixture 保真全过；`prompt_compile(target=anima)` 可用 |
| P3 tokenizer | 官方 tokenizer → TS（双跑最严） | token 序列逐 token 一致 |
| P4 闭环 | `prompt_author` 全链路 + `prompt_audit` + 文档分工标注 | 端到端产出 + 收敛测试 |

## 11. 风险与缓解

1. **移植保真偏差**（tokenizer/catalog/dialect）：双跑闸门 + 真实历史 fixture；不过闸门不入主线
2. **内容层质量不可保真**（LLM 部分）：沿用既有 resolver 组装 + 审计闭环兜底（内容差异被审计暴露）
3. **`prompt_author` 编排复杂度**：编排只调度，逻辑全在五层纯函数（可单测）
4. **兼容回归**：既有 4 工具语义与 53 测试保持绿（P0 即接框架，行为不变）
5. **双实现歧义**（minimax_scenario / anima3 反推）：文档标注「正式产出走 author/compile」，工具描述写明分工

## 12. 决策记录（追溯）

- D1-D5 见 §1.3；brainstorming 三节确认记录于对话
- 取代语义：本 spec 演进自第一版原生插件 spec（已实施部分保留：llm/complete、route、settings、注入源、4 工具基线），新增融合框架与三套资产归化

## 13. 后续候选（不进本期，记录备选）

- JoyCaption 额外选项复活（需从原 PM 源码取回实现文本）
- 专属训练打标工具
- camera-* 自动渲染闭环（生成→审计→直接送渲染）
- Anima 与 H3 跨域创作（图反推 → 描述 → 分镜 → H3）

---

# 实现后修订（任务完成落点标记；2026-08-27）

> 全计划 Task 1-14 已 closed。以下按 spec 章节标记实现状态与最终落点。

## A. 已实现标记

- **五层框架**（§1/§4/§6）：`src/pe-framework/` 五层（intent/schema/dialect/audit/render）+ StageIO 分层类型（§7 M3）——已实施，Spec 合规评审 13/13 通过。
- **9 个工具面**：实际注册 **8 个工具**（§6.1 的「9」含 T14 前计数误差，见 C）：`prompt_author`（主入口，P4 全链路+修正闭环）/ `prompt_compile`（h3+anima 确定性编译+审计）/ `prompt_audit`（纯审计闸门）/ `prompt_expand` / `prompt_reverse`（意图层）/ `minimax_scenario`（场景预览，分工标注）/ `profile_list`（五动作+target 过滤 A18）/ `catalog_search`（Anima 证据）。
- **保真资产**（§8/§9）：H3 golden 7（fixtures 8）+ anima catalog golden 12 + anima brief golden 6 + tokenizer golden 13，全部 sha256 清单校验（M5）；H3 文本/anima positive-negative/tokenizer id 序列均与官方 Python 双跑逐值一致。
- **修正闭环**（§7 对抗点 #6）：audit critical → 模型修正重跑 **max 2 次** → 仍失败 `loop_exhausted:true`。
- **budget**（§8）：h3 精确官方 tokenizer（`official-tokenizer`，T11/T12 双跑保真）；tokenizer 源不可载显式回退 `estimate`；anima 无 budget。
- **DIALECT_READY**：anima/h3 ready；sd/generic 保持 DIALECT_NOT_AVAILABLE（T13 状态机）。

## B. 关键 Ruling 落点

- Ruling #2：settings 显式适配器（无 as unknown as）✓；Ruling #7：reverse 外部修订基线 ✓；Ruling #8：harness 投影 ✓；Ruling #10：T7 F1/F2 前置契约闸门 + references 映射 ✓；A14：fuzzy/miss 保留原文 + advisory ✓；A18：target 推导映射（查询层）✓。

## C. registry 计数修正说明

- spec §6.1 原「9 工具」→ **实际注册 8 工具**：计划 Task 13 未新增第二个工具（prompt_audit 之外无新增），7+1=8；已按实测落 registry 断言并在 Task 13/14 报告记录。