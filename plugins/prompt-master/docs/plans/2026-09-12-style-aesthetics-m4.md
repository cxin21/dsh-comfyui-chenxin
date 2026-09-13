# M4 实施计划：catalog 写路径 + 写面硬化 + SD 方言设计（style-aesthetics 后续 II）

> **范围修订（2026-09-12 用户裁定）**：T3（SD 方言设计稿）暂缓出本里程碑——M4 = T1 + T2 + T4 + 各自评审 + FINAL（7 任务）。SD 方言设计稿留待后续里程碑按需启动。

**日期**：2026-09-12　**前置**：M3 已收官（M3-FINAL pass @ c4cee71，基线 1112 passed / 0 failed / 1 skipped，13 工具）
**spec**：M3-FINAL 终审 M4 候选五项处置 + 新增 SD 方言设计稿任务
**执行**：同一团队，纪律全量继承（隔离配方、单意图提交、评审时机派发、inScope 先想全）。

## 范围裁定（captain 对终审五候选逐项处置）

| 候选 | 处置 |
|---|---|
| catalog 写路径（缺失画师修复） | **M4 做**（T1，overlay 路线） |
| style_save existsSync 预检硬化 | **M4 做**（T2，并入写面硬化） |
| h3 gate 双面错误串共享常量 | **M4 做**（T2，tiny refactor 顺路） |
| SD 方言 | **M4 只做设计稿**（T3；实现体量=独立里程碑，列为 M5） |
| 多生成 | **剔除**——全仓无出处（仅 M2-FINAL 记忆版转述），无 spec 锚定不可规划；若用户有实义需先补需求 |

## Tasks

### T1 catalog 写路径：overlay 画师存在性登记（机制，TDD）
- **Files**：新增 catalog 工具或扩展 `catalog_relations` 同族（实现成员 grep 现有 catalog_* 工具面与 overlay sqlite 机制后定夺，计划不预设文件名）、catalog_search 消费侧、对应测试
- **内容**：①新工具面 `catalog_artist_add`（name、evidence[]、confidence?）：向 overlay 层登记画师存在性（**永不修改源 tags.sqlite**——overlay 路线与 relation-overlay 同构）②catalog_search 消费 overlay 命中：overlay 登记的画师在 search 中以明确 source 标记返回（canonical-or-alias 语义定夺写进测试）③evidence 必填（LLM 提案必须有真实证据链，防灌水）④幂等：重复登记同 name 幂等处理（更新 evidence 或 no-op，二选一钉死）。
- **背景**：M2 五批 authoring 中 miss/fuzzy 画师（xu beihong、good smile company 等）无法走 catalog_relations（只做既有 tag 关系）——本任务补齐「验证失败→登记→复验」闭环，后续 authoring 不再有死路。
- **verify**：定向 catalog 套件 + 全量（隔离配方）。Commit: `feat(catalog): overlay-based artist existence registry (M4)`

### T2 写面硬化 + 错误串常量（机制，TDD）
- **Files**：`src/tools/style-save.ts`、h3 gate 两处错误构造（minimax-scenario.ts + prompt-author.ts——以 grep 实际为准）、对应测试
- **内容**：①style_save 写前 existsSync 预检：同 id 未提交文件已存在时显式报错（消 TR2/T3 记录的缓存镜像盲区——静默覆盖变显式冲突），错误信息指路 git diff 自查②h3 gate 双面（minimax_scenario + prompt_author）错误串抽共享常量（`H3_RATING_UNSUPPORTED`，单一来源，两处消费）③专测更新（覆盖路径现在报错而非覆盖）。
- **verify**：定向 tools 套件 + 全量（隔离配方）。Commit: `feat(tools): style_save exists-check hardening + shared h3 gate error constant (M4)`

### T3 SD 方言设计稿（docs，零实现）
- **Files**：`plugins/prompt-master/docs/specs/2026-09-12-sd-dialect-design.md`（新建）
- **内容**：SD 方言规格草案——①输入面：AnimaSlots→SD 提示词的槽位映射契约（qualityPrefix/artist/subject/style/negative 结构，对齐 prompt_expand 既有 sd profile 语料）②审计面：SD 侧确定性审计规则草案（复用 anima 审计框架的哪些 gate、新增哪些 SD 特有 gate）③预算面：token 预算策略④桥接面：与 dialect registry 的接线点（DIALECT_NOT_AVAILABLE→ready 的迁移清单）⑤与 generic 方言的边界⑥M5 实现里程碑的任务分解建议。**明确不做**：任何 src 实现。
- **Commit**: `docs(spec): sd dialect design draft (M4, implementation = M5)`

### T4 M4 收口（docs-only）
- **内容**：全量隔离验证留痕 + tsc/build + dist 冒烟（82 + 13/14 工具视 T1 是否新注册工具）+ AGENTS.md/cookbook 终态核对（T1 新工具的文档同步）。
- **Commit**: `docs: M4 closeout (catalog overlay + write-surface hardening)`

## 依赖图

```
T1(catalog overlay) ∥ T2(写面硬化) —— 无相互依赖
T3(SD 设计稿) 独立可并行（零代码依赖）
T4(收口) 依赖 T1+T2+T3 全过审
每任务一 review（T1R/T2R/T3R/T4R）+ M4-FINAL
```

## 执行注记

- 9 任务（4 实现/文档 + 4 评审 + 1 终审），体量与 M3 相当。
- T1 是本里程碑唯一新工具面任务——工具计数涟漪（13→14）与 AGENTS.md/cookbook 同步由 T1 自带、T4 复核。
- T3 设计稿的验收标准 = 足以支撑 M5 实现计划的粒度（slot 映射表/审计规则清单/接线点三要素齐），由评审判断「能否据此写 M5 计划」。
- 教训继承：inScope 先想全（t60/t57）、计划缺陷按测试裁决、repo 根 npx tsc 不可信（必须插件目录跑）。
