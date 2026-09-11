# 三期实战修复设计：会话 398c261e 暴露的编译与 catalog 问题

> 2026-09-09 · 输入：真实会话导出（古风美女/anima base 实战，两次 prompt_author 调用）的 4 个质量问题。
> 决策（用户）：全部修复。

## F1（P0）narrative 兜底段与槽位段重复去重

现象：positive = 槽位短语串 + 末尾 narrative 兜底段（priority 2000、slot=null、origin=narrative），内容完全重复，审计打十几个 `duplicate_segment` important 但不触发修正（important ≠ critical），带病出稿。

修复（编译层，确定性）：`compileAnima` 装配 positive 时，若 narrative 段的实词集合被已有槽位段集合覆盖（实词词元语义取自 T1 critic/prompt-author 的 `tokensOf`，三期已抽公共 util `src/pe-framework/tokens.ts`，另含 `tokensCoveredBy` 包含判定），则**不追加**该 narrative 段；部分覆盖时按句切分、只追加未被覆盖的句子。零 LLM。

## F2（P0）catalog_miss 的 canonical 候选自动采纳

现象：审计给出正确候选（`moon gate`、`holding fan`、`soft lighting`、`dusk`、`covered bridge` 均为 canonical 命中）但正文保留原文（「保留原文未替换」minor），全靠人抄。

修复（编译后确定性后处理）：audit 产出 catalog_miss gates 后，新增确定性后处理 `applyCanonicalSubstitutions`——对每条 miss 段，从候选列表中逐个用 `searchCatalog` 验证，取第一个 `match_type='canonical'`（或 `alias`）者替换正文对应片段，替换后重跑 audit；全程无 LLM、审计内部可观测（`corrections` 计数 + advisory 列出替换对）。语义级多词短语若无 canonical 命中才保留原文（现行为）。

实现契约（实施回写）：①候选还须是 miss 片段的**词级子集**（候选词元 ⊆ 原片段归一化词元）——字符重合率挡不住同前缀 artist 噪声（如 `rim light→rimuriel`），词级子集才保证替换语义不漂移；②替换范围限定 slot 原文 tag——slots 在场时只采纳槽位原文片段，narrative 散文句（含句号等句末标点）不参与标签替换，无 slots 直调时同样按句末标点跳过句型片段。

## F3（P1）fuzzy 候选过滤收紧

现象：fuzzy 候选混入 `@willowsoft`、`@classicalbluess`、`skinny`、`the thing` 等噪声。

修复：`anima-catalog.ts` fuzzy 候选输出前过滤——剔除 `@` 开头的用户名型 tag、与原查询的字符重合率低于阈值（如 <0.4）的候选；每条 miss 最多保留 3 个候选。

## F4（P1）中文泄漏排查与守门

现象：第一次（中文输入）positive 含 `水袖`/`手持团扇`/`江南园林` 等中文原文直接保留。

排查+修复：①先复现（当前 dist、中文输入、enrich 默认开）确认 enrich 归一化是否覆盖此路径；②确定性守门兜底：anima audit 新增 `cjk_in_positive` gate（important，detail 列出 CJK 片段），并纳入修正闭环 feedback（要求换 catalog canonical 英文）——即使上游漏翻，出稿前必被拦。

实现勘误：cjk_in_positive 实现为 **critical**（闭环触发条件只认 critical，important 无法兑现『纳入修正闭环』；中文 token 对 anima 是无效输出），经审查确认成立（见 TASK_TRACKING Round 6）。

## F5（P2）dialect 阶段耗时可观测

traceStages 的 dialect 10.5s 无法细分。enrich/intent/候选检索各计耗时并入 `traceStages`（`enrich`、`intent`、`catalog` 子条目），零行为变更。

## 顺序与验收

F3→F2（同文件依赖：候选过滤先收，替换才可靠）→ F1 → F4 → F5。验收：现有基线只升不降；新增测试覆盖每项；用会话同款输入（中文+英文各一次）实测 positive 无重复段、无 CJK、canonical 候选已自动替换。

## 自审

- F1/F2 均为确定性纯函数，无 LLM，不触 golden 编译语义变化？——**会变**：F1/F2 改变 compile 输出内容，受影响 golden fixtures 需按新行为更新（属行为修复，报告列清单）。
- F4 的 CJK gate 只对 anima positive（negative 模板恒英文，不必查）。
- 全部确定性，无新 LLM 调用、无新依赖。
