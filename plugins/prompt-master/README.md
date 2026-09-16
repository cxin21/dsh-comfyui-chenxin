# prompt-master

DSH 原生插件：面向 Anima（静态图）与 MiniMax-H3（视频）方言的提示词工程引擎。把「LLM 懂画面、词表确定性化」解耦为五段管线——意图蓝图 → 美学扩写 → 成文 → 双轨审核（机器门 ∥ 审计 LLM）→ 修复——全程确定性审计谓词守门、内容分级安全预检、tag 目录（Danbooru 知识库 + 向量语义检索）接地、质量飞轮回流。

## 怎么装

前置依赖：Node ≥ 18、npm。本插件由 DSH host 以 `agent.cordis.yml` 挂载（`dist/src/plugin/index.js`），不独立运行。

```bash
npm install          # 安装依赖（peer deps 由 DSH host 提供）
npm run build        # tsc → dist（DSH 运行时加载 dist，不加载 src）
```

模型资产：tag 目录与向量库位于 preset 的 `assets/knowledge/anima-prompt-v1/`（由 `catalog_build` / `scripts/build_tag_vector.py` 重建，见 `docs/2026-09-01-anima-knowledge-spec.md`）。

## 怎么跑

开发验证（最小循环）：

```bash
npm test             # vitest 全量（154 files / 1320 tests 基线）
npm run lint         # eslint（0 error 门禁）
npm run format       # prettier 写入
```

在 DSH Agent 会话中的最小调用（注册 14 个工具，其中生成主入口）：

```
prompt_author { target: "anima", input: "雨夜街头，白发少女在霓虹灯下回眸", rating: "safe" }
```

返回 P1 JSON Envelope：`result.positive/negative` + `audit.gates` + `advisories` + 顶层 `quality`/`auditor`。视频方言用 `target: "h3"`（仅 safe 分级，`minimax_scenario` 可预览场景模板）。

## 怎么贡献 / 联系

- 开发约定与铁律（改 src 必 build、提交规范）见 `AGENTS.md`。
- 设计文档在 `docs/specs/`，实施计划在 `docs/plans/`；重大决策记录为 spec（回滚 = revert）。
- 全量测试与 lint 必须绿后才可提交：`npm test && npm run lint`。
