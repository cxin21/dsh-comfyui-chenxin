# 代码规范符合性审计与修复计划（对照 D:\Projects\temp\代码项目规范.md）

- 日期：2026-09-17
- 范围：plugins/prompt-master 全量（121 src 文件 + 157 测试文件 + 10 配置/脚本）
- 覆盖方式：机械规则 100% 全量扫描（密钥/console/TODO/FIXME/debugger/eval/any/空 catch/换行/BOM/尾随空格/行数/env 同步/git 追踪）+ 管线 15 文件人工精读 + resolver 抽样人工

## 发现 → 修复映射

| # | 级别 | 发现 | 证据 | 修复任务 |
|---|---|---|---|---|
| F1 | P0 | 真实 API Key 入库 | config.yaml.example:29，commit ee78de5 | Task 1（占位符替换；**密钥轮换由用户执行**） |
| F2 | P0 | .gitignore 未覆盖 config.yaml | git check-ignore 无命中 | Task 1 |
| F3 | P0 | formatter/linter 缺失（无工具强制） | 无 eslint/prettier 配置 | Task 2 |
| F4 | P0 | 46 文件缺末尾换行 + 1 处尾随空格 + 缺 .gitattributes | 全量扫描 | Task 2（随 formatter 一并修复） |
| F5 | P1 | .env.example 模板失同步：4 死变量（DB_PATH/LOG_LEVEL/DEFAULT_PROVIDER/DEFAULT_MODEL 代码零读取）、缺 15 活跃变量 | 全量 env 扫描 | Task 3 |
| F6 | P1 | 散落产物未忽略：preset-report.json（vitest-stage2.log 已忽略） | git check-ignore | Task 1 |
| F7 | P1 | applySemanticPatch quirk：无 `set` 键 patch 把 additions 误计 enrich_path_violation:1 | enrich-type-guard 测试实证 | Task 4（TDD） |
| F8 | P1 | 插件门面缺失：无 README/CHANGELOG/LICENSE | 文件枚举 | Task 5（LICENSE 协议选择需用户裁决，暂缓） |
| F9 | P2 | `any` 130 处（resolver 移植层 ~120 + host 接缝 3） | 全量扫描 | Task 6（resolver 类型化改造——大工程，本轮仅收口 host 接缝 + 文档标注，resolver 全面类型化另立计划） |
| F10 | P2 | pe-framework/index.ts `export *` 桶导出 | 读文件 | 不修（有意便利层，消费者依赖面广；标注为已接受偏差） |
| F11 | P1 | 大文件待拆分：prompt-author 1360 / anima 938 / rules-h3 650 / catalog 558 / anima-catalog 519 / subagent-provider 504 | 行数扫描 | 不在本轮（结构性拆分另立计划，回归风险大） |

## 合规确认（无需修复）

- 密钥扫描（除 F1）零命中；.env 从未入库；.pyc 未入库
- console.log 调试残留零；9 处 console.warn/error 均带前缀 + 注释说明
- TODO/FIXME/debugger/eval/字面空 catch 零
- BOM 零；plugin/index.ts 导出面最小 + ctx.effect 资源释放
- 提交纪律（单意图 + Conventional Commits）；测试 157 文件 describe 命名即场景

## 任务清单

- [ ] Task 1（P0 安全）：F1 占位符 + F2/F6 .gitignore 补 config.yaml、preset-report.json
- [ ] Task 2（P0 格式）：prettier + eslint 配置落地 + .gitattributes + 全仓格式化（独立 commit，不混逻辑）+ tsc/回归验证
- [ ] Task 3（P1 配置）：.env.example 重写（删死变量、补 15 活跃变量带注释）
- [ ] Task 4（P1 TDD）：F7 enrich quirk 修复 + 回归测试
- [ ] Task 5（P1 门面）：CHANGELOG.md + README.md（LICENSE 待用户定协议）
- [ ] Task 6（P2 部分）：host 接缝 ownerCtx 最小接口类型（SubagentHostCtx），resolver 全面类型化标注 deferred

## 完成记录

（每任务完成即回填：改动、验证、commit 号）
