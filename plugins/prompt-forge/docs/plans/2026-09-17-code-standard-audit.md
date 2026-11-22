# 代码规范符合性审计与修复计划（对照 D:\Projects\temp\代码项目规范.md）

- 日期：2026-09-17
- 范围：plugins/prompt-master 全量（121 src 文件 + 157 测试文件 + 10 配置/脚本）
- 覆盖方式：机械规则 100% 全量扫描（密钥/console/TODO/FIXME/debugger/eval/any/空 catch/换行/BOM/尾随空格/行数/env 同步/git 追踪）+ 管线 15 文件人工精读 + resolver 抽样人工

## 发现 → 修复映射

| #   | 级别 | 发现                                                                                                                  | 证据                                   | 修复任务                                                                                            |
| --- | ---- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| F1  | P0   | 真实 API Key 入库                                                                                                     | config.yaml.example:29，commit ee78de5 | Task 1（占位符替换；**密钥轮换由用户执行**）                                                        |
| F2  | P0   | .gitignore 未覆盖 config.yaml                                                                                         | git check-ignore 无命中                | Task 1                                                                                              |
| F3  | P0   | formatter/linter 缺失（无工具强制）                                                                                   | 无 eslint/prettier 配置                | Task 2                                                                                              |
| F4  | P0   | 46 文件缺末尾换行 + 1 处尾随空格 + 缺 .gitattributes                                                                  | 全量扫描                               | Task 2（随 formatter 一并修复）                                                                     |
| F5  | P1   | .env.example 模板失同步：4 死变量（DB_PATH/LOG_LEVEL/DEFAULT_PROVIDER/DEFAULT_MODEL 代码零读取）、缺 15 活跃变量      | 全量 env 扫描                          | Task 3                                                                                              |
| F6  | P1   | 散落产物未忽略：preset-report.json（vitest-stage2.log 已忽略）                                                        | git check-ignore                       | Task 1                                                                                              |
| F7  | P1   | applySemanticPatch quirk：无 `set` 键 patch 把 additions 误计 enrich_path_violation:1                                 | enrich-type-guard 测试实证             | Task 4（TDD）                                                                                       |
| F8  | P1   | 插件门面缺失：无 README/CHANGELOG/LICENSE                                                                             | 文件枚举                               | Task 5（LICENSE 协议选择需用户裁决，暂缓）                                                          |
| F9  | P2   | `any` 130 处（resolver 移植层 ~120 + host 接缝 3）                                                                    | 全量扫描                               | Task 6（resolver 类型化改造——大工程，本轮仅收口 host 接缝 + 文档标注，resolver 全面类型化另立计划） |
| F10 | P2   | pe-framework/index.ts `export *` 桶导出                                                                               | 读文件                                 | 不修（有意便利层，消费者依赖面广；标注为已接受偏差）                                                |
| F11 | P1   | 大文件待拆分：prompt-author 1360 / anima 938 / rules-h3 650 / catalog 558 / anima-catalog 519 / subagent-provider 504 | 行数扫描                               | 不在本轮（结构性拆分另立计划，回归风险大）                                                          |

## 合规确认（无需修复）

- 密钥扫描（除 F1）零命中；.env 从未入库；.pyc 未入库
- console.log 调试残留零；9 处 console.warn/error 均带前缀 + 注释说明
- TODO/FIXME/debugger/eval/字面空 catch 零
- BOM 零；plugin/index.ts 导出面最小 + ctx.effect 资源释放
- 提交纪律（单意图 + Conventional Commits）；测试 157 文件 describe 命名即场景

## 任务清单

- [x] Task 1（P0 安全）：F1 占位符 + F2/F6 .gitignore 补 config.yaml、*.report.json — commit fcfa7bc
- [x] Task 2（P0 格式）：prettier 3 + eslint 9（flat config）+ .gitattributes + 全仓格式化 — commit ee34e1b + 格式化收尾批；eslint error 63→0（死 import/var 清除、未用参数 `_` 前缀、prefer-const）
- [x] Task 3（P1 配置）：.env.example 重写 — commit d262faa（删 4 死变量、补 18 活跃变量带注释；含 PM_E5_MODEL/PM_VECTOR_MIN_SCORE/MIN_USAGE 间接读取项）
- [x] Task 4（P1 TDD）：F7 enrich quirk 修复 — commit 4868ca3（additions-only patch 不再误计 path violation；RED→GREEN）
- [x] Task 5（P1 门面）：README 四段 + CHANGELOG — commit 58e8da4（LICENSE 待用户定协议）
- [x] Task 6（P2 部分）：`llm/host-ctx.ts` SubagentHostCtx 最小接口，4 处 ownerCtx any 收口（method 双变签名 + 闭包窄化捕获）— commit 5102129
- [x] 文档同步（规范六 P0）：AGENTS.md 管线描述更新为 agentic 形态 — commit 60953cd

## 收尾验证（2026-09-17，全部任务后）

- `npx tsc --noEmit`：0 errors
- `npx eslint src tests`：0 errors（510 warnings = deferred 的 resolver any，F9 全面类型化另立计划）
- `npx vitest run`：154 files / 1321 passed / 1 skipped / 0 failed
- `npm run build`：dist 已同步

## 用户待办

1. **轮换泄露的 DeepSeek Key**（config.yaml.example 曾载 sk-1a05…，commit ee78de5 起在库；历史不改写，轮换才是有效处置）
2. LICENSE 协议选择（MIT/Apache-2.0/专有——确定后补 LICENSE 文件）

## 显式不修（已标注）

- F9 resolver 全面类型化（~120 处 any）：大工程，另立计划
- F11 大文件拆分（prompt-author 1360 等 6 个）：结构性重构，另立计划
- F10 pe-framework/index.ts 桶导出：有意便利层，接受偏差

## 完成记录

- 全部任务完成于 2026-09-17；提交链 f712bd9 → fcfa7bc → ee34e1b → d262faa → 4868ca3 → 58e8da4 → 5102129 → 60953cd → 格式化收尾批。
