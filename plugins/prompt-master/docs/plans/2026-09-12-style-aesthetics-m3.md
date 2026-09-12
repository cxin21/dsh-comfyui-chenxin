# M3 实施计划：松散端收口 + 预设写面（style-aesthetics 后续）

**日期**：2026-09-12　**前置**：M2 已收官（M2-FINAL pass @ ac19baf，基线 1098 passed / 0 failed / 1 skipped）
**spec**：主 spec §13（YAGNI 五项复核）+ M2-FINAL 终审 M3 候选四项
**执行**：同一团队（impl-1 / impl-2 / reviewer），纪律与 M1/M2 相同（隔离验证配方、单意图提交、评审时机派发）。

## 范围裁定（captain 复核 spec §13 原文 L280-286）

| §13 条目 | M3 处置 |
|---|---|
| LLM 破限框架 | **永久不做**（D4 用户已否决，设计底线） |
| 输出侧 GPU 评分 | **永久不做**（D2 限 prompt 侧） |
| 预设管理写工具 | **M3 做**（M2 五批手工 authoring 证明写面价值；style_list 只读先行承诺兑现） |
| 风格预设 token 预算 gate | 不做（现有 budget 审计已覆盖，spec 自证） |
| expand/reverse 内置 profile rating 变体 | 不做（用户自定义 profile 范畴；内置变体会冻结 profile 演化） |

终审候选修正：终审所引「catalog 反馈环/h3 rating/多生成/SD 方言」非 §13 原文——h3 rating 是 MiniMax 政策硬约束（spec L185）永不做；catalog 缺失画师修复需 catalog 写路径（现有 catalog_relations 只做既有 tag 关系，缺画师无法提案）→ 列 M4 候选；多生成/SD 方言属方言 roadmap 另立里程碑。**M3 = T1 继续通道 + T2 style_save + T3 文档聚合**。

## Tasks

### T1 continue/mutate 通道 rating 输入源（机制，TDD）
- **Files**：`src/resolver/minimax/catalog.ts`（或 minimax-scenario 工具定义所在——以 grep 为准）、continue/mutate 调用链测试
- **内容**：minimax-scenario 工具 +`rating?: Rating`（safe 缺省）→ 透传 continueUntilComplete/mutate 的 declaredRating → 评级中立条款在 continue/mutate 流生效（T13 四接线点最后两处激活）。h3 硬约束照旧：target=h3 且 rating≠safe → argument error（spec L185 既有语义复用）。
- **verify**：定向 continue/mutate/tools 套件 + 全量（隔离配方）。Commit: `feat(resolver): rating input source for continue/mutate channel (spec §7 P4, M3)`

### T2 style_save 预设写工具（机制，TDD）
- **Files**：`src/tools/style-save.ts`（新建）、`src/plugin/index.ts`（注册，12→13 工具）、registry.test 计数断言、对应新测试
- **内容**：style_save 工具——输入 {preset: StylePresetV2 JSON}：①validateStylePreset fail-fast（复用，零新校验逻辑）②重复 id 检测（与现有库冲突即拒，advisory 提示 style_preset_id_conflict 语义）③原子写入 `assets/style-presets/<id>.json`（写前展示 diff 摘要；写入即仓库工作树内容，提交由用户 git 完成——工具不碰 git）④返回写入摘要 + stylePresetCount 新值。**不做**：删除/改写既有预设（id 冲突即拒——改走 git）、目录外写入。registry 热加载：模块缓存失效或提示重启（读 M1 t15 缓存语义定夺，测试钉死行为）。
- **verify**：定向 tools/registry 套件 + 全量（隔离配方）。Commit: `feat(tools): style_save preset authoring tool with fail-fast validation (spec §13, M3)`

### T3 artist provenance 聚合文档 + 词表维护注记（docs）
- **Files**：`plugins/prompt-master/docs/artist-provenance.md`（新建，聚合五批 VERIFIED_ARTISTS/rec 号/弃用记录）、`plugins/prompt-master/src/pe-framework/safety/boundaries.ts` 头注释 + `AGENTS.md`（插件）维护段
- **内容**：①provenance 文档：批次→采纳/弃用→catalog rec 号全量表（来源=各批测试注释与任务 output）+ 维护指引（新预设 artist_hints 必须过 catalog_search）②词表注记：MINOR/EXPLICIT/SENSITIVE 新增 ASCII 词必须跑 y-结尾扫描并同步 PLURAL_VARIANTS（M2-FINAL 候选④）③插件 AGENTS.md 记 style_save（T2 落地后同步）。
- **Commit**: `docs: artist provenance ledger + safety wordlist maintenance notes (M3)`

### T4 全量验证 + 收口（docs-only 小收口）
- **内容**：全量 vitest/tsc/build 隔离验证留痕；style_list/工具计数 13 处同步核对；AGENTS.md 工具清单终态核对。
- **Commit**: `docs: M3 closeout (mechanism + write surface)`

## 依赖图

```
T1(继续通道) ∥ T2(style_save) —— 无相互依赖
T3(docs) 依赖 T1+T2（文档引用终态）
T4(收口) 依赖 T3
每任务一 review（T1R/T2R/T3R/T4R）+ M3-FINAL
```

## 执行注记

- 9 任务（4 实现 + 4 评审 + 1 终审），体量约为 M2 一半。
- style_save 写入路径唯一涉企风险点：原子写（tmp+rename）与目录白名单硬校验必须有专测（防路径穿越）。
- M1/M2 教训全量继承：评审时机派发、计划缺陷按测试裁决、inScope 先想全（t60/t57 两课）。
