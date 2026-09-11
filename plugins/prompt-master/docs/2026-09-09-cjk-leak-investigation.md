# 中文泄漏三层排查结论（入库重述）

> 2026-09-09 · 对应 spec：`2026-09-09-field-fixes-design.md` F4 节；登记：`docs/plans/TASK_TRACKING.md` Round 6（T3）。
> 原排查报告随临时工作区清理未入库，本文按 Round 6 登记与 T3 探针结论重述。

## 背景

一期实战会话（session-398c261e，古风美女/anima）中文输入下，positive 直接保留「水袖」「手持团扇」「江南园林」等中文原文出稿。F4 排查按编译链三层归因：intent 翻译层、catalog 替换层、audit 守门层。

## 一期根因（session-398c261e）

当时运行的是**无 enrich 层的旧 build**，三层全部放行：

1. **intent 未翻译中文**——intent 拆结构按原文透传，无语言归一；
2. **catalog_miss 保留原文**——中文 tag 在 catalog 无命中，按现行为保留原文；
3. **无 CJK 守门**——audit 无 `cjk_in_positive` gate，带病出稿无拦截。

## 当前行为

- **主路径干净**：enrich 开启（默认）时，中文输入先扩写为英文 brief，下游（intent→compile→audit→render）全部英文，无 CJK 泄漏。
- **遗留缺口**：enrich persona 对 `source=user` 条目「原样保留」，与 anima 恒锁 en 冲突——中文 user 条目可穿透 enrich 直达下游（探针 C 实证）。
- **守门兜底（本期已落地）**：anima audit 新增 `cjk_in_positive` gate，实现为 **critical**（见 F4 实现勘误），纳入修正闭环——静默出稿通道已封死，最坏多一轮修正。

## 四期方向

enrich persona 由「source=user 原样保留」改为「**语义保留、语言按 outputLang 产出**」，在源头消除穿透路径。

## 证据说明

- 探针脚本未入库（临时工作区已清理），本文为**结论性重述**，依据：TASK_TRACKING.md Round 6 登记行 + 三期 T3 探针结论（中文 user 条目穿透 enrich、critical 守门兜底）。
- 复现方法：中文 user 条目 + anima mock 走 `runEnrich`，观察产出 brief 的语言。
