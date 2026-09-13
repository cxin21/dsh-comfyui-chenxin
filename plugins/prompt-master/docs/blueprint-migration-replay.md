# 蓝图形态迁移重放记录（M5 T4）

**日期**：2026-09-13　**执行者**：impl-2（T4）
**对照基线**：T3 `0d8c295`（engine.ts 全量）＋ T3b `5c91341`（applyAdditions 修复）＋ T2 `e5a958a`/`bb91ff1`/`b4207b4`（路由/编排/钉桩），T2R verdict=pass
**本文职责**：设计稿 §2.7 重放清单 1–7 执行留痕 + 回滚判据五项指标采集 + R1 token 画像实测；清单 4（真实会话重放）按任务契约由 captain 配合执行，本文交付重放清单与断言面。

---

## 1. 清单① 全量测试（不与重 CPU 并行，串行执行）

`npx vitest run`（插件目录）→ **135 files / 1212 passed / 1 skipped / 0 failed**，exit 0，串行耗时 ~45s。
对 T2R 基线（134/1172/1/0）漂移 = T4 新增 golden 套件 40 用例（12×L1 + L2 + 12×L3 + F2 + 12×L4 + 清单5 + 清单6），零既有用例回退。

## 2. 清单② tsc + build + dist 冒烟

- `npx tsc --noEmit` → 0 错（exit 0）。
- `npm run build` → exit 0；dist 本机同步（dist 不入 git，preset .gitignore）。
- dist 冒烟：
  - `import('dist/src/plugin/index.js')` 成功（exports: Config/apply/inject/name）。
  - 内容级抽查 6 模块全 OK：`tools/prompt-author.js`（PM_AUTHOR_INTENT_FORM / blueprint_repair_retry / blueprint_save_failed / blueprint_enrich）、`pe-framework/intent/subagent-provider.js`（blueprintMode / anchorBlueprint / INCREMENTAL_ANCHOR）、`pe-framework/blueprint/analyzer.js`（ANIMA_BLUEPRINT_PERSONA / expectedMedia）、`pe-framework/enrichment/art-direction-apply.js`（CAMERA_ANGLE_SAFE_TERMS / art_direction_applied）、`pe-framework/render/envelope.d.ts`（blueprint?.anchor_rounds 类型面——运行时值由 prompt-author.js 产出）、`pe-framework/dialect/anima.js`（blueprintPersona）。

## 3. 清单③ 既有载体回归（全量内）

全量绿覆盖：`author-blueprint.e2e`（h3 蓝图管线/blueprint_id 增量/Level 3）、`author-rating-intent`（blueprint_id 档位链）、`prompt-author-orchestration`（28：P0/④⑤/audit-fix/D8 钉桩）、`anima-compile`（15：P2 核心/变体种子/F1 tag_count）、`registry`（工具名单硬边界）、audit/compile-audit 各套件、`migration-golden`（40，本任务新增）。既有断言零改动通过——迁移未触碰任何既有行为面。

## 4. 清单④ 真实会话 12 案例重放采集（captain 配合项）

### 4.1 探测结论（本会话，23:38）

本会话挂载的 prompt_master 插件 = **迁移前 dist**（会话启动早于 T2 build 22:46）。证据（probe envelope 摘录，input=「黄昏天台上看日落的少女，长发，微笑」）：

- `observability.blueprint` 不存在；`enrichment:{skipped:true,reason:'brief_too_large'}` + advisory `enrich_skipped` 存在；
- `traceStages` 含 `enrich`(44.7s)/`intent`(51.0s) 条目、无 `blueprint_enrich`；
- `aesthetics.recommendedCards` 经旧 runEnrich 通道产出。

→ **真实会话重放需在新 DSH 会话执行**（dist 已同步，重启加载即得蓝图形态）。

**真实基线锚（迁移前实录，供重放对照）**：`generation_id=gen_1789313381093_k4t473vn`；产物槽位 1girl/long hair/standing/profile/smile/closed mouth/full body/from side/rooftop/sunset/cityscape/wind/orange sky + narrative（构图/曝光/色彩三职责）；advisories：`catalog_recall_injected:1`；gates minor：`catalog_miss:looking away`、`aesthetic_lighting_missing`、`aesthetic_palette_missing`；corrections=0。

### 4.2 重放清单（12 案例 sheet；payload 参数 = `tests/fixtures/blueprint-migration/cases.json` 各案例 `args` 字段）

| 案例 | args 增量（均 `target:'anima'`） | 断言面（真实 envelope） |
|---|---|---|
| c01 | judge_mode:'off' | ok；`observability.blueprint.form==='blueprint'` 且 `media==='image'`；`enrichment` 字段不存在；traceStages 含 `blueprint_enrich` 无 `enrich` |
| c02 | 同 c01 | 同 c01 + 2girls 两角色分离语义 |
| c03 | 同 c01 | 同 c01（无人物场景） |
| c04 | 同 c01 | 同 c01 + artist 槽（@形 grounding） |
| c05 | + style_id:'figure_model', conformity:0 | c01 断言 + advisory 含 `art_direction_ignored_*` 缺席；detail_mood 含预设片段 |
| c06 | 同 c05 conformity:1 | c05 断言（fragments 不注入，theme 仍并入） |
| c07 | + rating:'explicit' | c01 断言 + positive 含 `rating_explicit` 不含 `rating_sensitive`；negative 六词逐字；`rating.resolved==='explicit'` 且 `source==='input'`；assumptions 含 `rating_active:explicit` |
| c08 | judge_mode:'off'（无 rating 声明） | c01 断言 + `rating.resolved==='sensitive'`（bikini 升档） |
| c09 | 同 c01 | c01 断言 + character 槽 `Subject 1 from <Picture 1>` 语义 |
| c10 | 同 c01 | c01 断言（CJK 长叙事） |
| c11 | + art_direction:{lighting:'golden_hour',motion:'flowing_hair'} | c01 断言 + advisories 含 `art_direction_applied:lighting:golden_hour` 与 `art_direction_applied:motion:flowing_hair`（R4） |
| c12 | 同 c01 | c01 断言 + soft 负向 → exclusions 通道 |

统一回滚指标采集：每案例记录 `rating.resolved`（与声明/关键词预期一致性）、失败与否、LLM 耗时（traceStages intent/blueprint_enrich ms）、catalog_miss gate 数、`corrections`/`loop_exhausted`。

**执行方式**：新 DSH 会话（挂载已同步 dist）→ 按 sheet 逐案例调用 → 记录实测到本节 → 与 §8 五项指标合并出回滚判据结论。

## 5. 清单⑤ blueprint_id 链路（mock 层，migration-golden.test.ts「replay item 5」）

已验证：默认路径落库（settings→`blueprint_id`，键=generation_id，Q2）→ `blueprint_id` 增量入口（增量分析走 stream/analyzeBlueprintIncremental，provider seam 未消费——与既有 e2e 断言一致）→ judge fast NEEDS → **修复轮 provider 收 `blueprintMode:true` + `anchorBlueprint`（与落库蓝图同源：media/concept/rating/rooftop 逐项相等）** → 闭环 PASS 推进 → 二次落库新 `blueprint_id`。V5/V6 修复轮复活在增量入口同样成立。

## 6. 清单⑥ h3 零变化（mock 层，「replay item 6」）

h3 legacy（shots 直译）路径：intent persona === H3_PERSONA 原样、无 `blueprintMode`/`blueprintExpectedMedia`、envelope 无 `observability.blueprint`/`blueprint_id`、audit 正常装配。既有 h3 blueprint 分支 e2e（author-blueprint.e2e）全绿未动。
**既有形状披露（非迁移引入）**：legacy 分支自始不装配 `next_action`（blueprint 分支自始装配，含空 repair_hints）——见 §10。

## 7. 清单⑦ compile-audit 工具面（slots 直译入口）

`prompt_compile`（anima slots 通道）与 `prompt_audit` 的引擎面由 `anima-compile`（15 用例）与 audit 系列套件在全量内回归绿；`registry.test` 工具名单（含两工具注册形状）零改动通过。工具面无迁移越界。

## 8. 回滚判据五项指标（mock 层实测；真实采集随 §4 补录）

| # | 指标 | 实测 | 结论 |
|---|---|---|---|
| ① | explicit 档产物种子 vs `rating.resolved` 一致率 | c07 双路径一致 1/1（种子 rating_explicit ↔ resolved explicit；mock L2 断言） | 无不一致样本 |
| ② | golden 失败 | **0/12**（L1 全绿；L2/L3/L4/清单5/清单6 全绿） | 通过 |
| ③ | 超时率 | mock 层 0（无子代理/无真实 LLM）；真实参考：迁移前 probe intent 51.0s + enrich 44.7s（enrich 因 brief_too_large skipped） | 待清单④补录迁移后耗时 |
| ④ | catalog_miss 均值 | 12 基线 compile **0.0 miss/run**（fixtures 全部 catalog-real tag）；真实 probe 1 minor（`catalog_miss:looking away`） | 低 |
| ⑤ | loop_exhausted 率 | golden 全程 **0**（judge off 主线；清单⑤ fast 闭环 1 轮收敛） | 低 |

## 9. R1 token 画像（实测，bytes= UTF-8）

| 面 | 旧（slots 直译） | 新（蓝图形态） | Δ |
|---|---|---|---|
| intent 输入面（persona+schema） | 7054 B（ANIMA_PERSONA 6,210 + ANIMA_SCHEMA 844） | 3936 B（ANIMA_BLUEPRINT_PERSONA 2,436 + ANIMA_BLUEPRINT_SCHEMA 1,500） | **−44.2%** |
| intent 输出面（12 案例 provider 产物） | 3134 B（均值 261 B） | 5468 B（均值 456 B） | **+74.5%** |

判定：方向与设计稿 R1 预测一致（输入净减、输出净增——蓝图 schema 结构开销换 schema 外置 persona 瘦身）。输入减幅 >30% → **立案留痕**：减幅主要来自 ANIMA_BLUEPRINT_PERSONA 逐字复用 BLUEPRINT_SUBAGENT_SYSTEM 基座（schema 不再内嵌 persona），属预期收益面、非异常偏差；净增输出为结构性 JSON 开销（schema_version/media_layer 包装），T4R 可评估是否需要在 persona 层加「最小 JSON 纪律」约束（现有裸 JSON 规则已覆盖大半）。

## 10. envelope 差异清单（交 T4R / M5 台账）

1. `next_action`/`repair_hints` 装配不对称：blueprint 分支（含 h3）自始装配 nextAction（含空 repair_hints 数组），legacy slots/shots 分支自始不装配——**迁移前既存**、迁移零贡献；L3 白名单已显式扩为 `{enrichment, next_action, repair_hints}` 并双向断言（新路径必有、旧路径必无）。若需拉平属 src 行为变更，建议 M5 台账单列任务定夺（影响 legacy 回滚面的 envelope 消费方）。
2. L1 实现扩展（从严披露）：内容槽 Jaccard 集在设计稿六槽外并入 `camera`/`exclusions`；rating「逐字节」操作化为 `rating.resolved` 相等（种子 token 一致由 L2/L4 字节面承载）；narrative 在设计稿「存在性一致+非空」上加逐字节相等（fixtures 可满足）。
3. T2R-1 strict 修订路径档位回落证据：12 案例均 `judge_mode:'off'`（§2.6 args 要点），无 strict 模式样本 → 档位回落证据采集不适用（captain 裁定：T2R-1 入台账与缺口#1 合并扩面双载体，不随 T4 闭合）。若台账后续需要 mock 采集，可经 V5/R6 与清单⑤的 fast 闭环载体改 strict 双档复用同一 mock 面获取。T4 附录（T2R nit）已补：golden L3 每案例显式断言 `generations.enrich` 两态对照（新路径=0 / 旧路径=1）。

## 11. 本任务交付物

- `tests/fixtures/blueprint-migration/cases.json`（12 案例定版：args/slotsBaseline/blueprint/白名单/expectedCompile；$meta 记录制来源与四层判据操作化）
- `tests/pe-framework/blueprint/migration-golden.test.ts`（40 用例，断言面全部落此文件）
- `docs/blueprint-migration-replay.md`（本文）
