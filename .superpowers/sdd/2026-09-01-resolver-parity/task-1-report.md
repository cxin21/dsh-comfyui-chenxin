# Task 1 Report — minimax assemble 保真移植（X1-X8）

**Commit:** `5f83b80` `fix(prompt-master): minimax assemble parity with PM 3.1.0 (X1-X8)`（7 files, +1206/−244）
**测试：** 全量 57 files / 483 tests 全绿；`tests/resolver/minimax-parity.test.ts` 27 tests 全绿（X1-X8 每项 ≥1 断言）；既有 `minimax.test.ts`（4）/`minimax-continue.test.ts`（3）全绿，llm 调用数不变；`pnpm build`（tsc）0 错误。

## 逐 X 移植说明

### X5（最高危）resolveMinimaxScenarioExpand — assemble.ts
- a) maxTokens：`Math.max(resolveExpandMaxTokens(...), mediaMin)`，`mediaMin = tokenLimits.mediaExpandMin ?? 4096`（`DEFAULT_MEDIA_EXPAND_MIN`，与 PM `DEFAULT_LOCAL_TOKEN_LIMITS.mediaExpandMin` 对齐）。768→≥4096。
- b) userExtraPrompt：恢复 `\n\n【User additional requirements】${extra}` 追加到 system。
- c) form 兼容：`params.minimaxForm?.form_fields ?? params.minimaxForm` —— upstream 直传与插件工具面 `{ form_fields, output_lang }` 嵌套两种均接受；`outputLang` 取 `params.outputLang || params.minimaxForm.output_lang`。
- d) scenario 解析：`getScenarioByPeId(profile.id) || getScenarioById(profile.minimaxScenarioId) || getScenarioByPeId(params.peId || params.ruleId)`（upstream 顺序）。
- e) 返回值补 `minimaxScenarioId: scenario.id`、`mediaExpandLayout: true`，`ruleId` 改为 upstream 的 `scenario.peId`（原为 profile.id）。

### X1 buildUser 五块结构 — assemble.ts
完整 upstream 移植：【场景】→【输出语言】（含"强制要求"句）→【强制】（按 outputMode 三分支：full_reference / director_segments（含公共设定+N组提示词组、智能分段说明）→【表单参数】（formToLines）→【创作需求 / User request】（shortText，空则 `(empty)`）→【参考素材】列表 + `<Picture N> …` 逐条锚定块 →【任务】尾行。原 332 行版的"请按以上系统提示…"占位 user 全部替换。

### X2 buildMediaTagLock 文案 + 分类 — assemble.ts
- 新增 `enumerateTaggedMedia`/`classifyMediaPath`（移植 `utils/expandMedia.js`，扩展名集合 IMAGE/VIDEO/AUDIO 一致；纯字符串 ext 解析，不依赖 node path）→ 视频 `<Video N>`/音频 `<Audio N>`/图片 `<Picture N>`/其它 `<File N>`。
- 恢复"禁止写成 Picture 1 / picture1 / 图1 等变体"句与"在「保留分析」「详细描述」中引用同一套 <Picture N>/<Subject N>"句；en 侧 `never write Picture 1 / picture1 without brackets` + reuse 句。无素材/导演台分支逐字对齐。

### X3 输出格式四分支 — assemble.ts buildSystem
- `timeline_template`（coop_game）：补全"时间轴/事件框架视频提示词…CONTINUE 等固定英文 UI 词可保留"整分支（原版缺失）。
- `plain`（默认分支）：补 mediaPaths 有/无两条 prose 锚定约束（"自然语言段落…禁止 XML/空壳结构"）。
- `full_reference`：补"画面广告文案：约 4–12 字、单行、Apple 风"与"任务前缀 [reference generation] 保持英文"。
- `director_segments`：补六段组规则全套（AI 分段拆段说明、公共设定/提示词组分隔行、第 2 组起"无硬切。紧接上一段。"、"段末停在…"、"详细描述最后一行：不要乱说话"、配乐跨组连续不淡出、指南引用）。

### X4 hardConstraints zh 改写 — assemble.ts
`## Scenario hard constraints` 标题改 upstream 英文标题，循环内 `lang==='zh' && /In-frame copy:\s*English/i.test(c)` → 替换为 "In-frame copy: concise Simplified Chinese (约 4–12 字)…"（assemble.js:403-415 逐字）。

### X7 h3FullReference 独立入口 — 新文件 `h3-full-reference.ts`
移植 `PROFILE_ID`/`BUILTIN_KEY`/`USER_PROMPT_TEMPLATE`/`isH3FullReferenceProfile`/`isH3FullReferencePeId`/`resolveH3FullReferenceExpand`。system = 指南全文（复用 H3_REFERENCE_ZH/EN 模板）+ upstream 三段语言/契约/素材附加块；user = 固定 Rewrite 模板 + 参考素材列表；maxTokens 同样有 4096 下限。
**映射决策：** upstream electron `resolveExpandPrompts`（promptEngineeringResolver.js:106-114）中 `isMinimaxScenarioProfile` 分支在最前，而 `pe_expand_h3_full_reference` 同时在 minimax catalog 中 —— 所以 upstream 运行时场景路径优先；`resolveH3FullReferenceExpand` 是同 peId 的独立第二判定（renderer 路径）。按此关系移植：`resolver/index.ts` 中场景分支保持第一优先，新增 1b 分支 `isH3FullReferenceProfile → resolveH3FullReferenceExpand` 作场景解析未命中时的兜底，与 upstream 调用关系一致（场景路径在前、独立入口可达）。

### X8 官方模板细则 — `templates/h3-reference.zh.ts` / `.en.ts`
用一次性 Node 脚本把 upstream `prompts/h3-full-reference-rewrite.{zh,en}.js` 的 module.exports（zh 4391 chars / en 25292 chars）转义后**逐字**写入 TS 模板（含 strict vs expand 判定、多图顺序一致、`<d>[Chinese]` 对白语言码、关系标记清单等）。ja 模板按 brief 保留现状。

## Files changed
- `src/resolver/minimax/assemble.ts`（主战场，X1-X5）
- `src/resolver/minimax/h3-full-reference.ts`（新，X7）
- `src/resolver/minimax/index.ts`（导出 X7 + enumerateTaggedMedia/classifyMediaPath）
- `src/resolver/index.ts`（X7 兜底分支）
- `src/resolver/minimax/templates/h3-reference.zh.ts` / `.en.ts`（X8 逐字模板）
- `tests/resolver/minimax-parity.test.ts`（新，27 断言）

## 偏差 / 备注
1. `enumerateTaggedMedia` 用正则取扩展名而非 `path.extname`（保持 resolver 纯函数、无 node 依赖）；对带查询串/无扩展名路径与 upstream 行为一致（→file）。
2. X4 测试用合成 scenario（export `buildSystem` 以便断言）：upstream 自身 catalog 的 In-frame copy 行（"follow Output language lock — English 3–5 words"）不匹配 `/In-frame copy:\s*English/i`，改写机制只在硬约束写死 "In-frame copy: English" 时触发 —— upstream 行为即如此，catalog 未改。
3. 既有测试中断言 `resolveExpandMaxTokens('long')` 相关行为无变化（expand-rules 未动）；llm 调用数不变（由 continue 引擎决定）。
4. 首次全量跑出现 14 个失败，为并发资源抖动（同批含我的并行命令）；隔离复跑全量 57/57 全绿，两次 minimax 相关测试均绿。

## Self-review
- 上游 assemble.js（585 行实际全文）逐段对照移植，非语义改写。
- 纯函数、零日志；无新依赖。
- `minimax_scenario` 工具面不变（nested form_fields/output_lang 兼容层保证）。
