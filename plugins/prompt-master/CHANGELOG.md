# Changelog

本文件记录 prompt-master 插件的用户可见变更（新增/修复/破坏性变更）。格式参照 Keep a Changelog。

## [0.3.0] — 2026-09-17

### Changed（破坏性）
- **anima 管线重构为 agentic 形态**（spec `docs/specs/2026-09-17-agentic-pipeline-redesign.md`）：
  检索层（S2.5 证据包）移除；成文/审计/修复改为三个独立 LLM 子代理（pm-writer / pm-auditor /
  pm-repairer），均可通过 `catalog_search` 工具查询 tag 字典；审计 LLM 每轮必跑（废除 critical
  跳审）。envelope 顶层新增 `quality`（passed/degraded/fallback）与 `auditor` 键；
  `observability.compositing` 形状变更（`unresolved_count` → `auditor`）。

### Fixed
- enrich patch 值类型守卫：LLM 把对象写入字符串字段（如 mood）导致管线硬崩（run1 崩溃根因）
- 确定性回退产物恒 ≤1200 字符；修复死变量 bug（NL 截断结果未真正返回）与 unresolved 碎片倾泻
- `config.yaml.example` 移除误入库的真实 API Key（**该 Key 应视为已泄露，请轮换**）

### Added
- nl_tag_overlap 向量层生产接线（bge-base-en-v1.5 余弦，`PM_VECTOR_OVERLAP=off` 可关）
- 检索包批量嵌入预热（retrieval_pack 阶段延迟收口）
- 代码规范工具链：prettier + eslint（flat config）+ `.gitattributes`（LF）

## [0.2.0] — 2026-09-16

- tag 向量语义检索层（bge-base-en-v1.5，ONNX 查询侧 + sqlite-vec 索引）；Q0-Q4 证据质量门
- compositing 五段管线（蓝图→扩写→检索→成文→审核/修复）取代 slots 直译
- 14 工具注册名单定型（registry.test.ts 权威）

## [0.1.0] — 2026-08-27

- 首个 DSH 原生插件形态：prompt_expand / prompt_reverse / minimax_scenario 等 PE 引擎 1:1 移植
