# 提示词工程工具体系 · 分工手册（usage）

> PE-Framework 全链路（P0-P4 完成）：统一五层（intent/schema/dialect/audit/render）+「prompt_author 主入口 + 底层工具」。
> 本手册消除双实现歧义（A8）：同一创作目标该走哪个工具一目了然。

## 工具矩阵

| 工具 | 定位 | 有无 LLM | 典型入参 | 产出 |
|---|---|---|---|---|
| `prompt_author` | **主入口**：全链路编排（意图→结构→编译→审计→渲染），含修正闭环 | 有（intent 拆结构；可注入） | `target=anima/h3` + `input`（+variant/stage/scenario_id/form_fields/audit_only） | Envelope `{ok, result, audit, advisories, target_slot_hint}` |
| `prompt_compile` | 确定性编译+审计（不拆意图） | 无 | `target=h3/anima` + `shots/slots`（或 scenario_id+form_fields） | Envelope（h3 含精确 token budget；anima 无 budget） |
| `prompt_audit` | 独立审计闸门 | 无 | `target` + 已有内容（h3: text+meta；anima: positive/negative(可附 slots)） | 审计报告 Envelope |
| `prompt_expand` | 意图层（扩写完整提示词） | 有 | `text` + `profile`（默认 `pe_expand_natural`）/ `dry_run` | 扩写正文 / dry_run JSON |
| `prompt_reverse` | 意图层（图→提示词反推，文本/图片路径） | 有 | `image_description`/图片 + `media_target`（anima/h3） | 反推正文 |
| `minimax_scenario` | 场景结构预览/探索（A8 分工标注） | 无 | `scenario_id` + `form_fields` / `dry_run` | 场景/组装/budget 预览 |
| `profile_list` | 配方管理（内置+自定义） | 无 | `action=list/search/get/save/delete` + `kind/query/target` | 配方 JSON |
| `catalog_search` | Anima 证据查询 | 无 | `tag` + `mode/limit` | `{hits, overlay}` |

## 场景表（创作目标 → 推荐路径）

| 创作目标 | 推荐路径 |
|---|---|
| 一句话想法 → Anima 图片提示词（正/负 + 审计 + 自动修正） | `prompt_author target=anima` |
| 一句话想法 → MiniMax-H3 视频提示词（六段式 + 精确预算 + 修正闭环） | `prompt_author target=h3` |
| 已有结构化 slots/shots，只要确定性编译+审计 | `prompt_compile` |
| 已有成品提示词，只要独立闸门复核 | `prompt_audit` |
| 只看 Anima catalog 里某 tag 的 canonical/alias/fuzzy/miss 证据 | `catalog_search` |
| 查找/保存自定义配方 | `profile_list` |
| 挑选或预览 H3 场景模板结构 | `minimax_scenario`（正式出文走 author/compile） |
| 已有扩写/反推旧式意图需求 | `prompt_expand` / `prompt_reverse` |

## target 推导映射表（A18：PEProfile 无 target 字段 → 查询层推导）

| 配方特征 | 推导 target（profileTargets） |
|---|---|
| `outputFormat='minimax'` | `h3` |
| `tags` 含 `Anima`/`anima3`（不区分大小写） | `anima` |
| `outputFormat∈{sd_tags, danbooru_tags}` | `sd` + `danbooru` |
| `kind='train'` 的训练配方 | 按 outputFormat 归入对应变体（minimax→h3；sd/danbooru 标签→sd/danbooru） |
| 其余 | `generic` |

- `profile_list` 的 `target` 参数按此表过滤；**不传 target = 不过滤（返回全部，兼容既有行为）**
- 单个配方可同时匹配多个 target（如 sd_tags → sd|danbooru）；过滤时命中任一即保留
- 模型不确定时回退 `target: undefined`（看全部，自己挑）

## 配方 × 方言语义（spec §5 解耦）

- 配方（profile）描述**如何组装意图 prompt**（system/user 模板与参数）；方言（anima/h3/sd…）描述**最终 prompt 的语法面**。
- `prompt_author` 内部已把配方（expand/reverse 意图封装）→ 结构（slots/shots）→ 方言（compileAnima/compileH3）贯通；底层工具允许按层单独调用。

## 其他

- budget：h3 走官方 tokenizer 精确计数（`counter='official-tokenizer'`；tokenizer 源不可载时显式回退 `estimate`）；anima 无 token 预算概念（Envelope 无 budget）。
- 修正闭环：`prompt_author` 在 audit 含 critical 时自动重跑修正，**max 2 次**；仍失败在 advisories 标注 `loop_exhausted:true`。
- 保真资产：golden 双跑（H3 文本逐字节 / anima positive/negative 逐字节 / tokenizer 逐 token）与 sha256 清单在 `tests/fidelity/`。