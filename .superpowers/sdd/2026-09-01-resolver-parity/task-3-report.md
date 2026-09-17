# Task 3 Report: 中危 parity 项合并（M1/M2 + A1 + V1 + D1）

- 状态：✅ 完成
- Commit：`9c6c951`（`fix(prompt-master): medium parity items (expandMirror CaptionPE, anima3 custom band, resolveReverse length block, word-count wording)`）
- 测试：59 files / 508 tests 全绿；`tsc` build exit 0
- 新增测试：`plugins/prompt-master/tests/resolver/parity-medium.test.ts`（10 条，每项 ≥2 条 parity 断言）

## 逐项修复

### V1 — resolveReverse 自定义分支长度块（最高优先，先做）
- `src/resolver/index.ts`：自定义反推分支原来 `system += '\n\n' + routerBuildSystemPrompt(cap, mt)`（workflow 块顶替长度块，不在既定裁剪方针）。改为 `system += buildCaptionLengthBlock(cap)`，与上游 `promptEngineeringResolver.js:227` 一致（`buildCaptionLengthBlock` 自带 `\n\n` 前导，与上游逐字等价）。
- JoyExtra enforcement 块（上游 :228）按既定裁剪方针保持不移植，注释已声明。
- 测试：自定义 profile 反推 system 含 `【篇幅】` + `300～500`（long 档），且不再含 ComfyUI `还原检查表·有则必写`。

### M1 — expandMirror 非结构化分支 CaptionPE 全家桶
- `src/resolver/profiles/expand-mirror.ts`：非结构化镜像的 system 由 `ComfyuiPE.buildExpertSystemPrefix + buildFaithfulReproductionBlock` 硬编码，改为 `routerBuildSystemPrompt(cap, 'image') + routerBuildSystemAddons(cap, 'image')`（即 port 版 CaptionPE：按 type 路由 Descriptive/Danbooru/Anima3，addons 叠加 workflow/长度块），对齐上游 `expandReverseMirror.js:125-126`。
- 测试：Descriptive 镜像 system 含 `视觉取证式`、`【五点结构框架·极致还原】`、`【极致还原总则】`（旧硬编码路径无这些块），且叠加 `【篇幅】` addon。

### M2 — tokenLimits 透传
- 同文件：非结构化分支 `resolveExpandMaxTokens(expandLen, expandLenChars)` → 追加第三参 `tokenLimits`（上游 :143）。
- 测试：`tokenLimits.expandMax: 256` 时 maxTokens ≤ 256（此前回落 8192 默认）。

### A1 — anima3 custom 字数档
- `src/resolver/profiles/reverse/anima3.ts`：删除内联 preset 映射（丢失 custom 分支），`resolveTagCountBand` 改为委托 `length.ts` 的 1:1 移植 `resolveAnima3TagCountBand`（与上游 `anima3PromptEngineering.js:15` 相同的委托结构）。
- 测试：custom 400 字 → `约 40 个`（round(chars/10)）；clamp 到 16/80 两端；不再出现 medium 22-38。

### D1 — descriptive/prose 字数表述
- `src/resolver/profiles/reverse/descriptive.ts`：`resolveWordCountHint` 由 `Math.round(maxTokens×0.75)` 裸数字改为委托 `length.ts` 的 `resolveCaptionWordCountHint`（返回档位文案，与上游 `descriptivePromptEngineering.js:25` 一致）。prose.ts 经既有 import 自动修复。
- 移除 descriptive.ts 不再使用的 `resolveExpandMaxTokens` import。
- 测试：medium → `150～300`；custom 200 → `200`；五点框架正文引用 `80～150`（short 档）。

## 备注 / concerns
1. 测试组织：按 brief 选项新建 `tests/resolver/parity-medium.test.ts`（vitest，与 `tests/resolver/` 惯例一致）。
2. 首次全量 vitest 出现 14 个文件超时失败（并行负载下 LLM-ish golden 测试超时）；独立干净复跑 59/59 文件、508/508 测试全绿，与本任务改动无关。
3. V1 范围外的两个既定偏差维持原样（按任务指示）：user 模板 `length_block` 仍置空、JoyExtra user enforcement tail 仍裁剪——如需进一步对齐上游 ：239-244 可另开任务。
4. 上游 `resolveReversePrompts` 自定义分支的 userTpl 兜底为 `DEFAULT_REVERSE_USER_TEMPLATE`，port 保留内联默认模板（审计已记录为可接受项，未动）。
