# T1 Brief: minimax assemble 保真移植（X1/X2/X3/X4/X5/X7/X8 — 审计高危项）

## 背景
resolver×3.1.0 parity 批次，最高优先任务。当前 `src/resolver/minimax/assemble.ts` 是自述"简化版"，与上游 `temp/pm-promptmaster-src/unpacked/electron/config/minimaxScenarios/assemble.js`（970 行）存在结构性差异（审计报告 X1-X8，见 `plugins/prompt-master/docs/2026-08-31-resolver-3.1.0-diff.md` §9）。本任务把 assemble.ts 的 prompt 组装保真移植到上游 3.1.0 语义。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 上游 ground truth（逐字移植源）
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\temp\pm-promptmaster-src\unpacked\electron\config\minimaxScenarios\assemble.js`（970 行，未混淆——直接 read）
+ `h3FullReferencePromptEngineering.js`（X7 独立入口）
+ `prompts/h3-full-reference-rewrite.zh.js` / `.en.js`（X8 官方模板细则）

## 修复清单（审计 §9 表格逐条）

### X5（最高危）：resolveMinimaxScenarioExpand
- a) maxTokens：`max(resolveExpandMaxTokens(expandLen…), 4096)`（mediaExpandMin 下限）——**当前 768 会直接截断 H3 输出**
- b) userExtraPrompt 追加块补回
- c) form 来源：接受 `params.minimaxForm` 直传（当前期望 `.form_fields` 嵌套）——**两种都兼容**
- d) scenario 解析补 `params.peId/ruleId` 兜底
- e) 返回值补 `minimaxScenarioId/mediaExpandLayout` 字段

### X1：buildUser 五块结构
【场景】【输出语言】【强制】→【表单参数】→【创作需求】→【参考素材+标签锚定】→【任务】——创作需求 shortText、表单参数行、参考素材列表与 `<Picture N>` 锚定块进 user 消息

### X2：buildMediaTagLock 文案补全
"禁止写成 Picture 1 / picture1 变体"句 + "保留分析/详细描述复用标签"句；mediaPaths 判定恢复扩展名分类（视频 `<Video N>`/音频 `<Audio N>`/图片 `<Picture N>`）

### X3：输出格式四分支
- timeline_template 分支补全（coop_game 等场景）
- plain 分支补"按 mediaPaths 有无追加 prose 锚定约束"
- full_reference 补"广告文案 4–12 字"与 `[reference generation] 保持英文` 行
- director_segments 补六段组规则（无硬切、"不要乱说话"、段末停帧等，assemble.js:295-337）

### X4：hardConstraints 渲染
zh 输出时 "In-frame copy: English" 条目改写为中文（assemble.js:403-415 逻辑移植）

### X7：h3FullReference 独立入口
`USER_PROMPT_TEMPLATE` + `resolveH3FullReferenceExpand` + `isH3FullReference*` 判定（h3FullReferencePromptEngineering.js:12-55, 81+）——"system=指南 md 全文 + user=固定 Rewrite 模板"双侧结构。**注意**：本插件的 minimax_scenario 走 resolveMinimaxScenarioExpand 场景路径；X7 独立入口作为 `isMinimaxScenarioProfile` 之外的第二判定（scenario peId=full_reference 时可用独立入口或保持场景路径——**执行者对照上游调用关系决定**：上游哪里调用 resolveH3FullReferenceExpand vs resolveMinimaxScenarioExpand，按同样关系移植）

### X8：h3-reference 模板细则补全
zh/en 模板从官方 prompts/h3-full-reference-rewrite.{zh,en}.js 移植完整规则细则（strict vs expand 判定、多图顺序映射、对白语言码等）；ja 版保留现状（port-only，无消费方）

## 关键约束
- **既有测试不破坏**：tests/plugin/minimax.test.ts 与 minimax-continue.test.ts 是结构性断言（prompt 是 string、llm 调用数）——修复后必须仍绿。llm 调用数若因 maxTokens/结构变化而变，逐个分析（不应变——调用数由 continue 引擎/场景决定，不由 user 块决定）
- **新增上游对照断言**：每个修复块加包含性测试（如 user 含"创作需求"、含 `<Picture 1>` 锚定、maxTokens ≥4096、timeline_template 分支输出含组规则）
- resolveExpandMaxTokens/applyExpandLength 等既有 expand-rules 导出可直接复用（read 后 import）
- 纯函数零日志

## Files
- Modify: `src/resolver/minimax/assemble.ts`（主战场）
- Modify: `src/resolver/minimax/templates/h3-reference.zh.ts`、`h3-reference.en.ts`（X8 细则）
- Modify: `src/resolver/minimax/catalog.ts`（如场景条目需带 outputContract/独立入口标记——按 X7 判定）
- Test: `tests/resolver/minimax-parity.test.ts`（新增——上游对照断言）

## 步骤
1. Read 上游 assemble.js 全文（970 行分段）+ h3FullReferencePromptEngineering.js + 两个 rewrite 模板 + 当前 assemble.ts + minimax.test.ts + minimax-continue.test.ts
2. 写失败测试（minimax-parity.test.ts——每个 X 项至少 1 个包含性断言）
3. 逐 X 项移植（X5→X1→X2→X3→X4→X7→X8，优先级序）
4. 新测试全绿 + 既有 minimax/minimax-continue 全绿 + 全量绿 + build 0
5. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/resolver plugins/prompt-master/tests/resolver
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "fix(prompt-master): minimax assemble parity with PM 3.1.0 (X1-X8)"
```

## 验收
- minimax-parity.test.ts 覆盖 X1-X8 每项
- 既有 minimax/minimax-continue 测试全绿
- 全量绿
- maxTokens ≥4096 下限生效（H3 长输出不再截断）
