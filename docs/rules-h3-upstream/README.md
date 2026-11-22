# H3 规则上游对齐机制（rules-h3-upstream）

本目录是 [issue #19](https://github.com/cxin21/dsh-comfyui-chenxin/issues/19)
裁决落地的**版本化规则包**载体：本仓 H3 审计规则
（`plugins/prompt-forge/src/pe-framework/audit/rules-h3.ts`）与官方
[MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3) 提供的
h3-prompt-writing skill 之间的对齐记录。

## 机制三要素（维护者裁决，2026-10-13，见票评论）

1. **对齐载体**：版本化规则包。官方每次发布 → 本目录出 `<版本>/DIFF.md`
   差异对照表（官方新条款 / 本仓现状 / 采纳裁决 三列）。**采纳的新规则一律以
   新文件进 rules-h3 并注册，现有文件零改动**——rules-h3/safety 是零接触红线区。
2. **触发节奏**：脚本驱动——`scripts/check_h3_upstream.py` 对官方 main 分支
   skill 子树做内容哈希对比，检测到漂移即触发一次对照；半年巡检兜底。
   （2026-11-22 首版基线修正：官方仓**无 release、无 tag**，版本锚 = main
   HEAD 的 skill 子树内容哈希，记录于对应 `DIFF.md` 的 §7。）
3. **冲突裁决**：prompt 形态规则**官方为准**（它是模型作者）；工程约束
   （budget 门、审计接线、envelope 形状）**本仓为准**。每条冲突在对照表里记
   裁决理由，不留口头决定。

## 目录结构

```
docs/rules-h3-upstream/
├── README.md                      ← 本文件：机制说明
├── _snapshot/<日期>-<名>/          ← 官方 skill 快照（verbatim 原文 + SOURCE.md 溯源）
└── <官方版本tag>/DIFF.md           ← 该版本的差异对照表（三列）
```

- `_snapshot/` 是 diff 基线：官方原文**一字不改**存档，`SOURCE.md` 记来源
  URL / commit / 抓取日期 / 每文件 sha256。
- `<版本>/DIFF.md` 是决策记录：每个差异条目必须有裁决列，关闭该版本对照时
  全部条目必须有裁决。

## 检测脚本

```bash
python scripts/check_h3_upstream.py
```

拉官方仓 skill 当前内容逐文件 sha256，与 `_snapshot/` 下最新基线对比：

- exit `0` — 无漂移；
- exit `1` — 检测到漂移（列出差异文件），需要开新版本对照表；
- exit `2` — 无法检测（网络/gh 不可用），**不谎报一致**。

## 落规路径（"新文件进 rules-h3 并注册"的实义）

audit 引擎的 gate 是值对象流：`AuditGate` 带 `source` 字段标注规则来源层。
采纳一条官方新规则时：

1. 在 `src/pe-framework/audit/` 下新增独立规则文件（如
   `rules-h3-upstream-v<tag>.ts`），导出返回 `AuditGate[]` 的函数，
   每条 gate 的 `source` 标注 `"audit/rules-h3-upstream/<tag>"`；
2. 在消费点（`src/tools/prompt-audit.ts` 的 gate 拼接处，以及编译链
   `src/tools/prompt-compile.ts` 如涉及）追加 `...<新函数>(...)` 一行完成注册；
3. `rules-h3.ts` / safety 文件**零改动**；
4. 对照表该条目标记「已落地：<新文件路径>」。

## 半年巡检兜底

日历巡检由维护人执行：跑一次检测脚本；若官方仓长期未发版导致脚本只能对比
同一 commit，脚本会如实报告"基线与当前一致"，此时人工确认官方 releases 页
无新条目即可（见 `_snapshot/` 最新 SOURCE.md 的抓取日期，超过 180 天即触发
一次人工巡检）。
