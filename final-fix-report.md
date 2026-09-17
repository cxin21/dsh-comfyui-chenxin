# Final Fix 报告（终审 I-1 + I-2）

日期：2026-07-08 · 基线：8c24806（796 passed）· 提交：**4504445**

## I-2 enrich_lang_forced 覆盖 ja（代码 + 测试，TDD）

- 现状：`src/tools/prompt-author.ts:654` advisory 仅 `anima && outputLang==='zh'` 时 push；但 `engine.ts:60` 对 anima 无条件强制回 `'en'`，anima + 显式 `'ja'` 被纠正却无提示。
- 修复（红→绿）：
  - 先补 e2e（`tests/plugin/author-enrich.e2e.test.ts` 规格5 新增用例）：anima + `outputLang:'ja'` → `brief.outputLang==='en'` 且 `advisories` 含 `enrich_lang_forced`。红：1 failed。
  - 条件改为 `target==='anima' && a.outputLang !== undefined && a.outputLang !== 'en'`（zh/ja 都 push）。绿：该文件 10/10。
  - 同步两处注释/schema description（zh → zh/ja），不改行为。

## I-1 方言级放宽勘误（spec 备忘）

- `docs/2026-09-08-enrich-default-judge-design.md` §10.5 末尾按 final-fix.md 原文逐字追加勘误条目（A5 方言级实现裁定 + A4 parseRebuttals 兜底移除的 ledger 裁定）。

## 完成标准验证

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/plugin/author-enrich.e2e.test.ts` | 10 passed（含新 ja 断言） |
| `npx vitest run` | **797 passed / 1 skipped / 0 failed**（93 文件，≥796 基线 +1） |
| `npx tsc --noEmit` | 通过（无输出） |
| `npm run build` | 通过（本机 dist 已同步；dist 不入 git） |
| `git commit` | 4504445（3 files：src + tests + docs） |

## 范围控制

改动严格限于两个文件的行为/断言 + spec 勘误追加，未触碰 engine.ts（其 `resolveOutputLang` 行为正确，无需改动）、未派生 subagent。

## Concerns

1. 提交显示 docs 设计文档为首次纳入 git 跟踪（create mode），说明基线 8c24806 前它一直是未跟踪文件——属预期外但无害；insertion 数（182）大部分来自该文档本身。
2. git 报 LF→CRLF warning（既有 autocrlf 配置行为，非本次引入）。
