# prompt-master 插件对 anima-prompt-v1 技能的吸收完整性审计（差距报告）

> 日期：2026-09-01
> 基准（ground truth）：`skills/anima-prompt-v1/`（cli.py 492 行 / catalog/* / SKILL.md）
> 被审对象：`plugins/prompt-master/`（dialect/anima.ts、dialect/anima-catalog.ts、resources/manifest.ts、tools/catalog-search.ts、tools/prompt-author.ts）
> 方法：逐文件对读 + 既有调研（`temp/research/anima-prompt-v1.md`）交叉验证。仅审计，未改任何代码。

---

## 一、逐项裁定表

| #   | 能力                                | 裁定                                  | 关键证据（技能 → 插件）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | catalog.search 模糊算法对等         | **PARTIAL（核心对等，表层字段缺失）** | 见下详述                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | catalog.browse / catalog.stats      | **MISSING**                           | search.py:147-163（browse 扫表 / stats 计数）→ 插件仅有 `catalogMeta()`（anima-catalog.ts:152-166，返回 file/sizeBytes/tables/fts，**无 records/names 计数**，也未暴露为 tool）；`catalog_search` 工具（catalog-search.ts）无 browse/stats 模式                                                                                                                                                                                                                                                                                                |
| 3   | catalog.build                       | **MISSING**                           | builder.py:56-222（tags.sqlite→catalog 原子重建 + manifest 写出）→ 插件零实现；插件以只读方式依赖 preset knowledge 文件（resolve.ts:23-26），重建完全依赖技能 CLI 侧                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | catalog.verify                      | **PARTIAL**                           | verification.py:13-49（schema 列序 / integrity_check / 4 表存在 / FTS 行数==names / foreign_key_check / manifest checksum + content_filters）→ 插件 `assertAnimaCatalog()`（manifest.ts:13-23）**只比对 output.checksum**，且失败仅 `console.warn` 不硬崩（anima-catalog.ts:39-44）；schema/FTS 漂移/FK/content_filters 全部未校验                                                                                                                                                                                                             |
| 5   | relation.submit/list/accept/reject  | **PARTIAL（仅存在性探测）**           | relation_overlay.py:35-138（完整可写生命周期：UPSERT/accept/reject/list，accepted 不降级）→ 插件仅 `overlayStatus()`（anima-catalog.ts:146-148，`existsSync` 探测）+ `overlayView()` 空壳（142-144，恒返回 `{tags:{}}`）+ `applyRelationOverlay` 只发 `overlay_unavailable` advisory（anima.ts:346-350）。**不读 overlay 内容、不能提交/裁决**                                                                                                                                                                                                 |
| 6   | author phase_status                 | **MISSING**                           | cli.py:266-271（policy/grounding/composition/inspection 四阶段 PASS/ADVISORY）→ `compileAnima` 返回 `{positive,negative,notes,assumptions}`（anima.ts:36-41, 203-208）；grep 全插件 `phase_status` 零命中，envelope（render/envelope.ts）以 AuditGate 代替，无四阶段状态投影                                                                                                                                                                                                                                                                   |
| 7   | citations + segments 输出           | **PARTIAL**                           | cli.py:338-369（segments 含 segment_id/channel/origin/priority/slot/citation；citations 按 record_id 去重，含 source 溯源）→ 插件内部有 `AnimaCitation` Map（anima.ts:106-131）且 notes 产 `citation:{record_id}:...`（197-201），但 **source 恒 null**（anima.ts:125，技能侧 _hydrate 附 source_name/version/checksum，search.py:131-137）；**segments 载荷（origin/priority/slot）未导出**——position 即权重的显式 priority 数字（200+50i+j）在 TS 里 `void base` 丢弃（anima.ts:185-186）                                                    |
| 8   | knowledge 资产同源 + 重建对账       | **PARTIAL**                           | 同一文件：search.py:31 默认 `knowledge/tag-catalog.sqlite`；插件 resolve.ts:23-26 → `<preset>/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite`，同源 ✓。技能重建后 manifest output.checksum 变化 → 插件 `assertAnimaCatalog` **能检出** mismatch，但：① 仅 warn 不阻断（anima-catalog.ts:43）；② `verifyManifestOnce` once-flag（34-44）**每进程只查一次**——进程存活期间技能重建，`_db` 仍握着旧文件句柄且永不复查                                                                                                                         |
| 9   | fuzzy 阈值 / usage_count ≥1000 语义 | **PARTIAL**                           | SKILL.md:48（step 3 agent 契约：fuzzy 需 `usage_count>=1000` 才可接受改写）→ 插件 `catalog_search` 返回每 hit 的 `usage_count`（anima-catalog.ts:84-90），数据可用；但**无 `candidate` 标记**（cli.py:468 `candidate = match_type=="fuzzy"`）、无阈值 advisory、无 grounding 时的阈值提示。`auditAnima` 的 `catalog_miss` gate 只带 fuzzy 候选词面（anima.ts:316-321），不带 usage 提示                                                                                                                                                        |
| 10  | SKILL.md 其余契约项                 | **PARTIAL**                           | ① `subject` 必填路由标签（cli.py:279、SKILL.md schema）→ 插件 `validateAnimaSlots`（anima.ts:364-375）无 subject 概念（AnimaSlots 有可选 subject 字段但从不校验/输出 metadata）；② 7 步 authoring workflow / 「先 search 后落 brief」的强制序 → 插件 prompt_author intent 直出 slots 再 compile，**未强制 step 2**，仅靠事后 audit 兜底（与 SKILL.md:40 「跳过 step 2 = unsafe commit」契约不符的弱化版）；③ envelope 逐字透传 advisories 契约 → gate 机制等效覆盖 ✓；④ variant 显式报错（未知 variant 拒绝）→ prompt-author.ts:221-223 已补 ✓ |

### #1 详述：catalog.search 模糊算法对等

**已对等（算法核心）：**

- normalize：anima-catalog.ts:65-67 ≡ facets.normalize（小写/下划线→空格/折叠空白）✓
- FTS 构造：`ftsQuery`（anima-catalog.ts:70-76）逐字对应 `_fts_query`（search.py:19-24，OR + `"part"*` 前缀 token）✓
- 级联：`searchCatalog` auto = canonical→alias→fuzzy，首个出结果者胜（anima-catalog.ts:111-122 ≡ search.py:73-81）；`exact` = 无 fuzzy 的 canoncain→alias ✓
- 排序：exact `ORDER BY usage_count DESC, record_id`（:81）、fuzzy `ORDER BY bm25(catalog_fts), r.usage_count DESC`（:98）逐字一致 ✓
- **12 条 golden 双跑测试锁定**（tests/fidelity/anima-catalog-golden.test.ts：silvery_hair canonical / silver_hair fuzzy / miss 用例等），已确立验收基线 ✓

**缺口（表层/参数面）：**

- 无 `score`（技能 canonical=1000.0 / alias=850.0 / fuzzy=500−bm25，search.py:87,101）；无 `candidate` 布尔（cli.py:468）
- 无 mode 单选 `canonical` / `alias` / `fuzzy`（插件只有 auto|exact，CatalogQueryOptions anima-catalog.ts:20-23）
- 无 `--category` / `--source` / `include_deprecated` 过滤（search.py:108-121 `_scope`）
- 无 `_hydrate` 富化：aliases 列表、source_name/snapshot_version/checksum 溯源（search.py:123-145）
- `CatalogHit.raw` 只有 matched_name，无 aliases/provenance

---

## 二、差距清单（按严重度排序）

### G1【高】relation overlay 全生命周期缺失（裁定 #5）

插件只做 `existsSync` 探测，`overlayView()` 是恒空壳——技能的 relation.submit/list/accept/reject（cli.py:200-225, 424-463 + relation_overlay.py + relation_submission.py 203 行校验链：端点存在性、cooccurrence 拒收、signature 归一化去重、proposal_id sha256、accepted 不降级 UPSERT）**完全未吸收**。SKILL.md:239-265 明确这是 author 后的知识沉淀工作流。
**吸收建议**：新增 `catalog_relations` 工具（actions: list/submit/accept/reject），node:sqlite 以**可写**连接打开 `temp/anima-prompt-v1/relation-overlay.sqlite`（独立可写库，不碰只读 catalog——与技能红线一致）；校验链纯函数可直接按 research §7 表格移植（signature 归一化 + sha256 proposal_id 为 S 级纯函数）。**工作量：M**

### G2【高】phase_status + segments/citations 完整载荷缺失（裁定 #6/#7）

技能 author envelope 的 `phase_status`（四阶段 PASS/ADVISORY，cli.py:266-271）与 `segments`（origin/priority/slot/citation 烙印，cli.py:338-354）是 agent 契约的审计面（SKILL.md:343-356「Report which of the 4 stages were PASS/ADVISORY」）。插件 envelope 只有 AuditGate 扁平列表，citations 只活在 notes 字符串里，`source` 溯源恒 null，priority 显式权重被 `void base` 丢弃。
**吸收建议**：在 `compileAnima` 返回值追加 `segments`（由已有 citations Map + SLOT_ORDER 索引即可投影 origin/priority/slot，纯组装 S 级）与 `phase_status`（policy 恒 PASS；grounding=有 record_id 的 citation 存在；inspection=gates 无 important+；均可在 runStage 末端一行推导）。citations 补 source：需 `sources` 表查询（新查询函数 S 级）。**工作量：M**

### G3【中】catalog.browse / catalog.stats / verify 深检未暴露（裁定 #2/#4）

发现面（browse 无 query 扫表）与体量面（stats 计数）对「tag 字典覆盖到哪」这类问题是直接证据源；verify 的 schema/FTS 漂移/FK 校验比插件的单 checksum 强一个量级。
**吸收建议**：① `catalog_search` 工具加 `action: search|browse|stats` 分支（browse/stats 各 ~15 行 SQL，S 级）；② `assertAnimaCatalog` 扩展为三项：checksum + `catalog_fts COUNT == names COUNT` + 4 表存在（各一条 SQL，S 级）；schema 全列序对齐可后置。**工作量：S**

### G4【中】重建后的陈旧句柄与一次性对账（裁定 #8 后半）

技能重建 catalog（新 checksum）后：已存活进程 `_db` 指向旧 inode、`_manifestChecked=true` 永不复查——插件会**静默继续用旧字典**且只有启动时一条 warn。
**吸收建议**：`db()` 打开时比对 `statSync(path).mtimeMs` 与缓存值，变化则 close+重开+重跑 `assertAnimaCatalog`（S 级）；对账失败时在 `catalog_search` 返回 JSON 里带 `manifest_mismatch` advisory（而非仅 console.warn），让 agent 契约层可见。**工作量：S**

### G5【低】fuzzy `candidate` 标记与 usage≥1000 契约编码（裁定 #9）

数据已在 hits 里（usage_count），但 `candidate` 布尔与阈值 advisory 缺位——agent 每次要自己想起 SKILL.md step 3。
**吸收建议**：`catalog_search` 输出 hit 加 `candidate: match_type==='fuzzy'`；命中 fuzzy 且 usage<1000 时在返回 JSON 顶层追加 advisory 一条（`fuzzy_below_threshold`）。纯输出投影，S 级。**工作量：S**

### G6【低】subject 必填校验 + metadata 缺失（裁定 #10①）

技能 `_coerce_brief` 要求非空 `subject` 并回显 metadata{variant,subject}；插件 `validateAnimaSlots` 不认识 subject，`compileAnima` 也不产 metadata。
**吸收建议**：validateAnimaSlots 对 `subject` 加「可选但必须为 string」；envelope metadata 投影一行。S 级。**工作量：S**

### G7【低】search 单模式（canonical/alias/fuzzy）与 category/source 过滤（裁定 #1 缺口）

golden 已锁 auto 级联正确性，单模式与过滤器是调试/发现场景的便利面，优先级最低。
**吸收建议**：CatalogQueryOptions 扩 mode 三单值 + categories 数组（SQL 拼 `r.category IN (...)`，复用 exactQuery 模板）。M 级（filters 波及 fuzzy/exact 两条 SQL）。

---

## 三、总体结论

插件对 anima-prompt-v1 的吸收呈「**算法内核保真、知识资产管理面缺位**」格局：搜索级联、FTS 词根发现、grounding 红线（fuzzy/miss 永不落词）、variant 策略表、inspection 规则与 12 条 golden 双跑基线均已高质量对等移植（裁定 #1/#9 数据面可视为达标）；**tag 字典作为「活资产」的管理闭环——build（G1 无）、verify 深检（G3 部分）、browse/stats 发现面（G3）、relation 知识沉淀（G1，最大的洞）、重建后的对账与句柄刷新（G4）——基本未吸收**，插件目前是知识的「只读消费者」，而技能是「资产的维护者」；author 审计面（phase_status/segments/citations 溯源，G2）是其次是契约级缺口，影响 agent 按 SKILL.md 要求向用户逐字报告审计状态的能力。

量化：**裁定 10 项 = ABSORBED 0 / PARTIAL 6 / MISSING 3（另 #1 计 PARTIAL 含高对等内核）**；差距 7 条 = 高 2（G1/G2）、中 2（G3/G4）、低 3（G5/G6/G7）。建议吸收顺序：G4 → G3 → G5（三条约一天内可完成的 S 级组合，先堵正确性风险）→ G2 → G1（两次独立 M 级改造）。
