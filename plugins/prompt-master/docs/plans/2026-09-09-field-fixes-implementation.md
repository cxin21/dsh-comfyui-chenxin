# 三期实战修复实施计划

> **For agentic workers:** superpowers:subagent-driven-development。工作目录 plugins/prompt-master（main）。
> Spec：`docs/2026-09-09-field-fixes-design.md`。基线：797 passed（HEAD 4504445）。

**Global Constraints**：改 src 后 build（dist 不进 git）；vitest ≥797 只升不降（F1/F2 行为变化允许 golden/fixture 按新行为更新，报告列清单）；确定性修复零 LLM；提交圈定文件；message 带 spec F 编号。

### Task 1: F3 fuzzy 候选过滤 + F2 canonical 候选自动采纳

**Files:** `src/pe-framework/dialect/anima-catalog.ts`（候选过滤：剔 `@` 前缀、字符重合率 <0.4、每 miss ≤3 候选）、`src/pe-framework/dialect/anima.ts`（audit 后确定性后处理 `applyCanonicalSubstitutions`：miss 段候选逐个 searchCatalog 验证，取 canonical/alias 命中替换正文，重跑 audit，corrections+advisory 记录）；测试 `tests/pe-framework/dialect/`（过滤单测：`@`/低重合剔除；采纳单测：miss+canonical 候选→替换且 gate 消失、无 canonical→保留原文）
**Steps:** 读 anima-catalog.ts 的 fuzzy 候选产出与 anima.ts audit 的 candidates 来源 → TDD 实现 → 全量回归 + build + 提交 `fix(dialect): fuzzy 候选过滤 + canonical 候选自动采纳 (F3/F2)`

### Task 2: F1 narrative 兜底段去重

**Files:** `src/pe-framework/dialect/anima.ts`（compile 装配：narrative 段实词集合被槽位段覆盖→不追加；部分覆盖按句切分只追加未覆盖句；抽实词交集 util 与 critic 共享或独立 util）；受影响 golden/fixture 更新（报告列清单）；测试（全重复→不追加；部分重复→只加新句；无重复→原样）
**Steps:** TDD → 全量回归（golden 更新列清单）+ build + 提交 `fix(dialect): narrative 兜底段与槽位段去重 (F1)`

### Task 3: F4 CJK 泄漏排查 + cjk_in_positive 守门

**Files:** `src/pe-framework/dialect/anima.ts`（audit 增 `cjk_in_positive` important gate，detail 列 CJK 片段；纳入修正闭环 feedback）；测试（中文 positive → gate 触发）；**排查报告**：用当前 dist 复现一期会话同款中文输入（node 脚本走 runStage 或经 mock intent），确认 enrich 路径是否产出中文 tag，结论写入报告（若是 enrich 缺口→只记录不修，守门兜底已拦）
**Steps:** 复现排查 → TDD 加 gate → 全量 + build + 提交 `fix(dialect): cjk_in_positive 守门 + 中文泄漏排查 (F4)`

### Task 4: F5 trace 耗时细分

**Files:** `src/tools/prompt-author.ts`（traceStages 增 enrich/intent/catalog 子条目耗时）；测试断言子条目存在
**Steps:** TDD → 全量 + build + 提交 `feat(tools): trace 耗时细分 enrich/intent/catalog (F5)`

### Task 5: 实战复测 + 终审 + 登记

- 用会话同款输入（中文/英文各一次，mock provider）实测：positive 无重复段、无 CJK、canonical 已替换
- 独立终审（跨任务一致 + golden 更新合理性）
- TASK_TRACKING Round 6 登记 + 提交

## Self-Review

1. 覆盖：F1(T2)/F2+F3(T1)/F4(T3)/F5(T4)/验收(T5)，无缺口
2. 无占位符
3. 类型一致：applyCanonicalSubstitutions 签名 T1 内自洽；实词交集 util 与 critic 的 tokensOf 语义一致（抽公共或复制均需报告说明）
