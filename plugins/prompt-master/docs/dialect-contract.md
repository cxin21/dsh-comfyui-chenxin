# 方言包规范与新模型接入清单（Dialect Contract）

> **定位**：Phase 3「方言包规范化 + 新模型验证」的成文规范（spec §17 L491-496）。
> 本文档是 **spec §9（DialectPackage 接口）、§8（方言投影器）、§8.3（投影一致性测试）** 的成文落地，
> 与 `src/pe-framework/dialect/*` 实际代码**逐一对应**；状态表中的数值全部**从代码实读**，不臆造。
> 新模型接入的**唯一交付标准**（spec §17 L495）：**写方言包 + 写投影器即可接入**，文档化接入清单见 §4。

---

## 1. 背景与目标

现有 `DialectContract`（`src/pe-framework/dialect/contract.ts`）已升级为**方言包声明**（spec §9）：

- 每个已注册方言（`h3` / `anima`）在契约之上挂载 `capabilities` / `constraints` / `aesthetics` 三字段
  （`license` 可选），构成完整「方言包」。
- `getDialectPackage(target)`（`src/pe-framework/dialect/package.ts`）读取注册表方言，
  三字段任一缺失（或 target 未注册）→ 返回 `undefined`。
- 方言包的价值：
  - **preflight（§9 L342 / §11 Level 1）**：`constraints.validate` 提供确定性闸门，agent 先验边界再投 LLM 成本；
  - **扩展引擎（§6）**：`capabilities` 告诉扩展器该方言的负向档位、media 目标、画幅、时长、token 上限；
  - **许可证治理**：`license` 记录资产再分发的许可约束（H3）或**无官方声明**的显式标注（Anima，见 §3.2）。

---

## 2. DialectPackage 接口（spec §9 L312-344）

与 `src/pe-framework/dialect/contract.ts` / `package.ts` 逐字段一致：

```ts
interface DialectCapabilities {
  native_negative: boolean       // 有无独立负向框
  supports_audio: boolean        // 音频/台词语法
  supports_dialogue: boolean
  camera_axes: number            // 运镜轴数
  media_targets: Array<'image' | 'video' | 'mixed'>
  aspect_ratios: string[]
  duration_range: [number, number]  // 秒
  max_shots_formula?: string     // 如 '1 + floor((duration - 1) / 3)'
  max_prompt_chars: number
  budget_quality_cap: number     // 每 stage token 上限
}

interface DialectConstraintInput {
  stage: string
  shots: { duration_seconds: number; shots: unknown[] }
  refs?: unknown[]
}

interface DialectConstraints {
  validate(input: DialectConstraintInput): AuditGate[]   // preflight 用确定性约束表
}

interface DialectAesthetics {
  forbidden_words: string[]      // 禁词（Flux 禁 tag、可灵忌 fast…）
  few_shot_examples: Array<{ input: string; output: string }>
  style_hints: string[]
}

interface DialectLicense {
  id: string
  url: string
  territory_restrictions?: string
}

interface DialectPackage extends DialectContract {
  capabilities: DialectCapabilities
  constraints: DialectConstraints
  aesthetics: DialectAesthetics
  license?: DialectLicense        // 可选；未声明 = 无官方资产声明（Anima）
}
```

要点：

- **包必需三字段**：`capabilities` / `constraints` / `aesthetics` 为 `DialectPackage` 必需；
  `license` 可选（`package.ts` 判定：三字段任一 `undefined` → `getDialectPackage` 返回 `undefined`）。
- **`constraints.validate` 语义**：输入 `{stage, shots, refs}` → 输出 `AuditGate[]`。H3 是
  `contractGatesH3` 的薄封装（`dialect/h3.ts`）；Anima 无契约闸门表 → 返回 `[]`
  （Anima 输入校验走 `validateAnimaSlots` 返回 **error 字符串**，属 normalize 层契约，非 AuditGate 表）。
- **`capabilities` 数值来源**：H3 全部提取自 `src/pe-framework/schema/h3-shots.ts` +
  `src/pe-framework/audit/budget.ts` 常量（spec §9 L343「不臆造」）；Anima 来自 Anima 编译器的实际能力。

---

## 3. 现有两方言包状态表（从代码实读）

> 数据源：`src/pe-framework/dialect/h3.ts`（`registerH3Dialect`）、`src/pe-framework/dialect/anima.ts`（`registerAnimaDialect`）、
> `src/pe-framework/schema/h3-shots.ts`、`src/pe-framework/audit/budget.ts`、`assets/knowledge/minimax-h3-prompt/manifest.json`、`assets/knowledge/anima-prompt-v1/manifest.json`。

### 3.1 MiniMax-H3（`target: 'h3'`）

| 维度 | 字段 | 值 | 代码来源 |
|---|---|---|---|
| capabilities | `native_negative` | `false`（无独立负向框 → 负向档 2 正向改写） | `h3.ts` |
| | `supports_audio` | `true`（`overall_soundscape` / `shot.ambient`） | `h3.ts` |
| | `supports_dialogue` | `true`（`<d>[语言] 文本</d>`） | `h3.ts` |
| | `camera_axes` | `3`（dolly/pan/tracking/orbit/crane/handheld 三维描述） | `h3.ts` |
| | `media_targets` | `['video']` | `h3.ts` |
| | `aspect_ratios` | `['16:9','9:16','1:1','4:3','3:4']` | `h3.ts`（与 blueprint `ASPECT_RATIOS` 一致） |
| | `duration_range` | `[4, 15]`（`MIN_DURATION_SECONDS`=4 / `MAX_DURATION_SECONDS`=15） | `schema/h3-shots.ts` |
| | `max_shots_formula` | `'1 + floor((duration - 1) / 3)'` | `schema/h3-shots.ts` `MAX_SHOT_FORMULA` |
| | `max_prompt_chars` | `7000` | `schema/h3-shots.ts` `MAX_PROMPT_CHARS` |
| | `budget_quality_cap` | `2400`（= `Math.max(...STAGE_QUALITY_CAPS)`，ref2va 上界） | `audit/budget.ts`（t2va 1200/i2va 1500/fl2va 1700/l2va 1700/ref2va 2400） |
| constraints | `validate` | `contractGatesH3` 薄封装（stage/shots/refs → `AuditGate[]`） | `h3.ts` → `audit/rules-h3.ts` |
| aesthetics | `forbidden_words` | `[]`（Phase 2 内容化治理） | `h3.ts` |
| | `few_shot_examples` | `[]` | `h3.ts` |
| | `style_hints` | `[]`（风格库 Phase 2） | `h3.ts` |
| license | 声明状态 | **已声明**（运行时读 manifest） | `assets/knowledge/minimax-h3-prompt/manifest.json` |
| | `id` | `MiniMax-H3-Community-License-2026-08-02` | manifest `license.id` |
| | `url` | `https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/939557dc319dd91227e30195a763f272ba7f8765/LICENSE` | manifest `license.url` |
| | `territory_restrictions` | `Redistribution and use are limited to the Applicable Territory defined by the license; LICENSE and NOTICE must accompany the files.` | manifest `license.conditions`（→ `territory_restrictions`） |

> H3 license 由 `h3License()`（`dialect/h3.ts`）在注册时读取 `manifest.json`；读取失败 → `undefined`（不阻断注册）。

### 3.2 Anima（`target: 'anima'`）

| 维度 | 字段 | 值 | 代码来源 |
|---|---|---|---|
| capabilities | `native_negative` | `true`（有独立 negative 通道 → 负向档 1） | `anima.ts` |
| | `supports_audio` | `false` | `anima.ts` |
| | `supports_dialogue` | `false` | `anima.ts` |
| | `camera_axes` | `0`（camera 为离散角度标签 `camera[]` 槽，非轴运镜） | `anima.ts` |
| | `media_targets` | `['image']` | `anima.ts` |
| | `aspect_ratios` | `['16:9','9:16','1:1','4:3','3:4']` | `anima.ts`（与 `ASPECT_COMMON` 一致） |
| | `duration_range` | `[0, 0]`（image 方言无时长约束，0 = 不适用） | `anima.ts` |
| | `max_shots_formula` | 未声明（可选字段；image 方言无分镜概念） | `anima.ts` |
| | `max_prompt_chars` | `0`（无官方字符上限，0 = 不适用） | `anima.ts` |
| | `budget_quality_cap` | `0`（无 budget 子系统，0 = 不适用） | `anima.ts` |
| constraints | `validate` | `() => []`（无契约闸门表；输入校验走 `validateAnimaSlots` → error 字符串，非 AuditGate[]） | `anima.ts` |
| aesthetics | `forbidden_words` | `[]`（Phase 2 内容化治理；现有 `LIGHTING_BAN` 为审计内部私有列表，不在此字段） | `anima.ts` |
| | `few_shot_examples` | `[]` | `anima.ts` |
| | `style_hints` | `[]`（风格库 Phase 2） | `anima.ts` |
| license | 声明状态 | **未声明（无官方资产声明）** | `anima.ts`（注释「license 无官方资产声明」） |
| | 原因 | `assets/knowledge/anima-prompt-v1/manifest.json` 仅含 `content_filters/output/source` 字段，**无 license 字段** → 无官方许可声明可提取 | `anima-prompt-v1/manifest.json` |

> **⚠️ Anima 许可证标注（团队目标 ③）**：Anima 知识资产（`assets/knowledge/anima-prompt-v1/`）
> **没有官方资产声明**，方言包 `license` 字段因此**保持未声明**（`undefined`）。任何分发 / 再使用该
> 知识资产的一方，需**自行确认**数据来源许可（manifest 未提供 license/redistribution 信息）；本插件不臆造许可。

---

## 4. 新模型接入清单（spec §17 L495「文档化的接入清单」）

> 接入一个第 3 模型（Phase 3 以 **Flux 图像**为验证目标，spec §17 L493）只需 **三步**：

| 步骤 | 做什么 | 落点文件 | 参考现有实现 |
|---|---|---|---|
| **① 写方言包** | `registerXxxDialect()`：声明 DialectContract（normalize/compile/audit/budget/targetSlotHint/intent）+ **四字段** `capabilities` / `constraints` / `aesthetics` / `license`（license 无官方声明可省略）；模块级副作用注册 `registerXxxDialect()` | `src/pe-framework/dialect/<model>.ts`（新建）；`src/pe-framework/dialect/registry.ts` 的 `registerDialect` 自动装配 | `dialect/h3.ts`（`registerH3Dialect`）、`dialect/anima.ts`（`registerAnimaDialect`） |
| **② 写投影器** | `projectToXxx(bp: BlueprintV1)`：蓝图 v1 → 该方言输入形状，确定性纯函数；含负向档位适配（见 §4.1）、角色卡 `<Subject N>` 锚点、duration 双字段语义 | `src/pe-framework/blueprint/project.ts`（追加导出） | `projectToH3`（§8.1 映射）、`projectToAnima`（§8.2 映射）、`preflightRepair`（§11 Level 1 确定性预修） |
| **③ 写测试** | 契约级测试：给定蓝图 fixture → 断言输出形状/关键字段/负向档位正确；**防漂移快照**：同蓝图 → 输出快照 diff | `tests/pe-framework/dialect/<model>-register.test.ts`（新建，能力断言）；`tests/pe-framework/blueprint/project.test.ts`（追加投影契约 + `toMatchSnapshot()`） | `tests/pe-framework/dialect/h3-register.test.ts`、`tests/pe-framework/dialect/package.test.ts`、`tests/pe-framework/blueprint/project.test.ts`（含 `__snapshots__/project.test.ts.snap`） |

### 4.1 负向档位适配（spec §5.2-3，投影器内做、不依赖 LLM）

| 档位 | 适用 | 做法 | 现有实现 |
|---|---|---|---|
| 档 1 有 native negative | SD/SDXL `negative_prompt`、可灵、MJ `--no` | 直接映射方言 negative 字段/参数 | Anima `projectToAnima` → `exclusions[]`（soft 类） |
| 档 2 无 native | **Flux**、H3、即梦 | **正向改写**（「无字幕」→「纯净画面无文字界面」）+ advisory 提示，不堆负向词 | H3 `projectToH3` → soft 改写进 `what` 末句 + `projectAdvisories`（`soft_negative_rewritten:...`） |
| 档 3 LLM-encoder | Z-Image/Anima/Krea2 | 语义正负短语，**只用符号不用权重**（NegPiP 实测） | — |
| 内容安全类 | `severity='hard'` | 直接过滤/拒绝 | `projectToH3` / `projectToAnima` → `BlueprintHardNegativeError`（hard 提前 throw） |

> 投影器输出形状必须与现有方言输入形状完全兼容（spec §8 L272「runStage 与方言编译零改动」），
> golden fidelity 测试逐字节把关（`tests/fidelity/*`）。

### 4.2 以 Flux 为例（Phase 3 目标第 3 模型，spec 依据）

- **capabilities 关键值（spec 依据，最终以实现方从 Flux 官方资料提取为准）**：
  - `native_negative: false`（Flux 无原生 negative，spec §5.2-3 L203 + 调研三 flux#188）→ 负向走**档 2 正向改写**；
  - `media_targets: ['image']`、`duration_range: [0, 0]`、无 `max_shots_formula`（图像方言，参照 Anima 模式）；
  - `aspect_ratios` 取模型支持比例（与现有 `ASPECT_RATIOS` 对齐）。
- **投影器**：`projectToFlux(bp)` 参照 `projectToAnima`（appearance/clothing/scene/detail_mood/camera 槽位映射）；
  负向 soft 类走档 2 正向改写进正向文本 + advisory（Flux 无 `exclusions` 通道）。
- **测试**：`tests/pe-framework/dialect/flux-register.test.ts`（能力断言）+ `tests/pe-framework/blueprint/project.test.ts` 追加快照。
- **license**：Flux 相关资产若有官方许可证，从对应 manifest 提取成文；无官方声明 → 标注「无官方资产声明」（同 §3.2 Anima 处理）。

> 具体 Flux 方言包 / 投影器 / 测试由 Phase 3 对应实现任务完成；本节仅提供**接入模板**与 spec 依据，不预置实现。

### 4.3 验收（spec §17 L495）

- `getDialectPackage('<model>')` 返回完整包（三字段齐备）；
- `projectToXxx` 契约测试 + 防漂移快照全绿；
- 全量 vitest 无新增失败；golden fidelity 零回归；
- LLM 预算 ≤3 次/任务不受影响（新方言走确定性路径，零新增 LLM 调用）。

---

## 5. 注册装配点

- `src/pe-framework/dialect/registry.ts`：`registerDialect(contract)`（重复 id → throw）、`getDialect(target)`、`isDialectReady(target)`、`__resetDialectsForTests()`。
- `src/pe-framework/dialect/package.ts`：`getDialectPackage(target)`（三字段判定）。
- **装配方式**：`plugin/index.ts` import 方言模块即完成副作用注册（`h3.ts` / `anima.ts` 文件尾 `registerXxxDialect()`）；新方言包同样在模块级副作用注册，无需改插件入口。
- **读取方**：`preflightRepair`（`blueprint/project.ts`）用 `getDialectPackage('h3')` 取 `duration_range` 做 Level 1 确定性预修——新方言接入后即可被同一机制消费。

---

## 6. 与代码的一致性校验（§8.3 防漂移配套）

- 方言包能力断言测试：`tests/pe-framework/dialect/package.test.ts`（h3 native_negative=false / duration [4,15] / max_prompt_chars 7000 / max_shots_formula / license id 含 `MiniMax-H3`；anima native_negative=true；未知方言 → undefined）。
- 投影快照：`tests/pe-framework/blueprint/__snapshots__/project.test.ts.snap`。
- 若本文档状态表与代码不一致，**以代码为准**并更新本文档（防漂移纪律）。
