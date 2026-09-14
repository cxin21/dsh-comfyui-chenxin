# Tag 向量语义检索设计（tag-vector semantic search）

> 日期：2026-09-15
> 状态：已与用户分段评审通过（方案 A + 全量重写授权），待 spec 终审
> 关联：`docs/specs/` 现有 spec 惯例；对标 [DanbooruSearchOnline](https://github.com/SuzumiyaAkizuki/DanbooruSearchOnline)（下称 DSO）的语义检索能力

## 1. 背景与问题

当前 Anima tag 查询（`src/pe-framework/dialect/anima-catalog.ts`）是纯字符串匹配：
canonical → alias → artistRegistry 填隙 → fuzzy（FTS5 词根前缀 + F3 Jaccard 噪声过滤）。
三类场景明显吃亏（对标 DSO 已确认）：

1. **中文跨语言**：catalog 无中文别名，中文查询只能靠 `ZH_CONCEPT_BRIDGE` 硬编码桥接表（~40 词条）+ enrich 英文化兜底；`水手服` → `serafuku` 这类映射大面积 miss。
2. **拼写容错**：FTS prefix + Jaccard 过滤无法处理 `selafuku`（错拼）、`twintail`（单复数以外词形变体）等输入。
3. **模糊发散**：无语义相近标签的召回能力。

## 2. 决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 语义能力来源 | **本地向量索引**（否决外挂 DSO 服务 / 分阶段混合） | 守住查询期"零 LLM、零网络、零外部进程"的确定性底线 |
| 建库期 LLM 翻译/扩写 | **v1 不做** | 成本与周期不可控；多语言嵌入模型直接编码 wiki 释义已可覆盖中文跨语言 |
| wiki 释义覆盖 | **全量**：有 wiki 页的拉释义（`text_source=wiki`），无页用 tag+alias+category 兜底（`fallback`） | 无 tag 被漏掉，仅描述丰富度不同 |
| 运行时形态 | **Node 内嵌量化模型 + sqlite-vec**（方案 A；否决 Python sidecar / 仅 recall 层向量） | 亚秒级、无部署面；质量不足时只换模型文件，架构不动 |
| 兼容性 | **完全重写，不向后兼容**（用户授权） | `searchCatalog` 返回形状、`classifyTag`、G7 单级直查等历史包袱一并重构 |

## 3. 架构

### 3.1 数据资产

新增 `knowledge/anima-prompt-v1/tag-vector.sqlite`，与 `tag-catalog.sqlite` **并列独立**：

- vec0 虚拟表（sqlite-vec）：int8 量化，384 维（multilingual-e5-small），~1.39M 行约 0.5GB。
- payload 表：`record_id`（JOIN 回 tag-catalog.sqlite 取 prompt_form / usage_count / category）、`text_source`（`wiki` | `fallback`）。
- 独立成库原因：`anima-catalog-golden.test.ts` 的记录集相等保真与 `tag-catalog.sqlite` 的 manifest sha256 对账完全不受影响。
- 对账机制：mtime 变化 → 关闭陈旧句柄重开（复用 G4 模式）；**不做 sha256 manifest**——向量库是可重建的派生产物，不是保真基线。

### 3.2 查询期级联（重写后）

> 重写指**代码结构与接口形状**（合并查询模块、重构返回形状、清理 G7 等历史包袱）；前四级的**匹配语义不变**（对齐官方 search.py），`anima-catalog-golden.test.ts` 等既有保真测试应原样通过。

```
canonical → alias → artistRegistry填隙 → fuzzy(FTS5) → semantic(向量, 新增)
```

- semantic 层只在 `mode='auto'` 且前级全空时触发；`mode='exact'` 保持纯精确级联。
- 新 `match_type: 'semantic'`，命中携带 `score`（cosine 相似度）与 `text_source`。
- **过滤规则与 F3 不同**：Jaccard 字符重合对"中文查询→英文 tag"天然为 0，不适用。semantic 层用 **cosine 阈值（缺省 0.55，可配）+ 保留 `@` 画师剔除**；不足阈值就少给，不凑数。
- **防幻觉边界不变**：`catalog-recall`（B7 召回层）继续只吃 canonical/alias exact 命中，semantic 命中**不注入**生成 persona——语义近似存在被误纳风险，置信度不足以喂给生成回路。v1 semantic 只服务 miss 回填与 `catalog_search` 交互查询。
- **审计语义**：semantic 命中且返回规范 `prompt_form` → 不触发 `catalog_miss`（核心收益：LLM 写了中文变体/错拼，向量层回填为词表真实 tag）；发 advisory `semantic_fallback` 标记来源。

### 3.3 运行时

- 嵌入：`onnxruntime-node` 跑量化 multilingual-e5-small（~120MB），单次编码几十 ms。
- 向量检索：sqlite-vec KNN。
- **运行时探测（不设双路径）**：实现期第一步探 `node:sqlite` 的 `loadExtension` 可用性（需 Node ≥22.13/23.5 且 `allowExtension: true`）；可用 → sqlite-vec，不可用 → 直接改用 `hnswlib-node`。只保留一条能跑通的路，无兼容层。
- 查询模块整体重写：`anima-catalog.ts` 与新增 `anima-vector.ts` 合并为一个查询模块；工具层、recall 层、审计层调用点随重构同步修改。

## 4. 建库管线

脚本 `plugins/prompt-master/scripts/build_tag_vector.py`（`.venv` python），产物落 `knowledge/anima-prompt-v1/tag-vector.sqlite`：

1. **读源**：从 `tag-catalog.sqlite` 读全部 records——不直连 tags.sqlite，保证 record_id 天然对齐。
2. **wiki 拉取**：Danbooru 官方 `wiki_pages.json` API 按标题查询；有页取首段纯文本（截 ~512 字符）；限速 ~2 req/s + 指数退避。
3. **断点续跑**：逐条 JSONL 缓存到 `temp/anima-prompt-v1/wiki-cache/`；几万条 wiki 页约数小时，中断后重跑只补缺。
4. **编码**：sentence-transformers 批量编码；遵守 e5 的 `query:` / `passage:` 前缀约定（建库侧 passage，查询侧 query）。
5. **落盘**：临时文件 → 写入 → 原子 rename（复刻 `catalog_build` 的 tmp+rename 模式）。
6. **触发方式**：手动脚本，文档写明；**不新增插件工具**（14 个工具注册面不动，`catalog_build` 不动）。

## 5. 错误处理

| 故障 | 处置 |
|---|---|
| ONNX 模型文件缺失 / 加载失败 | semantic 层降级为空（不阻塞前级级联），console.warn 一次性提示 |
| 向量库缺失 / mtime 对账异常 | 同上，语义层静默缺席，查询行为退化为现状 |
| wiki 拉取限速 429 / 网络故障 | 退避重试；超限跳过该 tag（标记 `fallback`），不阻塞建库 |
| embed 超时/异常 | 该次查询 semantic 层返回空，异常上抛前级结果不受影响 |

原则：semantic 层是**增强层**，任何故障只降级不阻塞——与 `catalog-recall` 的故障兜底语义一致。

## 6. 测试策略

- **embed 接缝**：查询模块暴露 `embed` seam（缺省真模型，测试注入确定性 stub）——向量单测不加载 ONNX，快且确定。
- **单测**（微型 fixture 向量库，~100 tags 手工向量）：级联顺序（semantic 仅 auto + 前级全空触发）、阈值边界、`@` 画师剔除、`text_source` 透传、mtime 重开、`exact` 模式不受影响。
- **审计集成测试**：semantic 命中 → `catalog_miss` 不触发 + `semantic_fallback` advisory；`catalog-recall` 现有 exact-only 测试原样通过（该层不改）。
- **验收探针（手动，结果记入本文档收口）**：
  - `水手服` → `serafuku`（中文跨语言）
  - `selafuku` → `serafuku`（拼写容错）
  - `twintail` → `twintails`（词形变体）
  - `兔耳朵` → 各耳型变体发散（模糊发散）

## 7. 非目标（Non-goals）

- 不做 LLM 翻译 / 语义扩写（后续可加，架构不变）。
- 不做 NPMI 共现统计 / 关联推荐 / 画师推荐（DSO 强项，另立议题）。
- 不做在线增量更新：wiki 快照静态，更新 = 重跑建库脚本。
- 不新增插件工具，不改 `catalog_build` / `catalog_relations` / `catalog_artist_add` 语义。
- 不动 `catalog-recall` 的 exact-only 注入边界。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| multilingual-e5-small 语义天花板低于 bge-m3 | 中文跨语言够用；模型是可替换文件，架构不动 |
| `node:sqlite` loadExtension 实验性 | §3.3 运行时探测 + hnswlib-node 退路，实现期定案 |
| 建库期网络拉取数小时 | JSONL 断点续跑缓存 |
| 向量库 ~0.5GB 落盘 | 独立文件不进 git；int8 量化控制体积 |

**运行时探测结论（§3.3 定案）**：2026-09-15 探测（Node v24.14.0 / sqlite-vec 0.1.9 / @huggingface/transformers 4.2.0，`scripts/probe-sqlite-vec.mjs`）——`node:sqlite` `DatabaseSync(':memory:', { allowExtension: true })` + `loadExtension(getLoadablePath())` 成功加载 vec0 虚拟表，输出 `PROBE_OK`。**选定路径：sqlite-vec（唯一路径，无兼容层）**；hnswlib-node 退路弃用，未选中分支代码不留存。
