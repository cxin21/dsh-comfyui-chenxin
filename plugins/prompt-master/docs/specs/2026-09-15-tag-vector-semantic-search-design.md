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

#### 验收探针结果（2026-09-15 收口实测，Task 8 / t6）

**环境**：真实 ONNX 模型（`Xenova/multilingual-e5-small` q8，118MB，本地缓存离线）+ 全量库 `tag-vector.sqlite`（payload 1,374,902 = wiki 198,738 / fallback 1,176,164，fallback 占 85.5%）；经 dist `searchCatalog(mode='auto', limit=10)` 驱动（探针脚本 `temp/sdd-t8/probe_acceptance.mjs`）。全量回归基线：**138 files / 1255 passed / 1 skipped / 0 failed**（`npx vitest run` exit 0）。

| 输入 | 期望 | 实际 top hit + score（逐字） | 判定 |
|---|---|---|---|
| `水手服` | top hit semantic → serafuku | `1女孩蓝色 眼睛蓝色 头发绯红katagiri himeko长袖momotsuki gakuen 校服…水手领`（fallback 拼接长串，usage 0）0.8786；#2 `水着` 0.8740；#3–#10 全部 water 词形噪声（`hand in water` 0.8735 / `water clothes` 0.8729 / `water in hands` 0.8709…）；canonical `serafuku`（wiki）不在 top-10 | **未达标** |
| `selafuku` | top hit semantic → serafuku | `@selpuku`（画师 tag，usage 6）0.8644；serafuku 家族部分召回：#2 `serafuku,`（usage 0 退化 tag）0.8627、#3 `seerafuku` 0.8622、#5 `seafuku` 0.8616、#10 `serafuk` 0.8589；canonical `serafuku`（wiki）不在 top-10 | **未达标**（拼写容错召回存在但被画师/退化 tag 压顶） |
| `twintail` | top hit prompt_form 含 twintails | `twintails`（**alias 级**命中，usage 1,310,823，2ms；semantic 未触发——前级已接住） | **达标**（单复数词形变体由既有 alias 级覆盖，验收目标达成） |
| `兔耳朵` | ≥3 个耳型相关 tag | `hair米语 (blue archive)裤袜兔 ears`（fallback 拼接串，usage 0）0.8635；#2 `huan` 0.8627、#3 `huan455210` 0.8627、#4 `huannnnn` 0.8563、#5 `yorn` 0.8555…——**0 个规范耳型 tag**（animal_ears / rabbit_ears / animal_ear_fluff 均未出现） | **未达标** |

附加精度探针：gibberish `zzzzzzzzq` 在全量库上仍返回 10 hits ≥0.55（top `shitp zzz` 0.8824，全部 fallback）——阈值 0.55 对短文本 fallback 语料无区分力，与 Task 7 小样观察一致。

**阈值校准实测（brief Step 3）**：`PM_SEMANTIC_THRESHOLD=0.50` 与 `0.60` 重跑三个未达标探针——**排名逐位不变**（三探针全部命中 score 挤在 0.8517–0.8786 窄带，0.60 上界内无一被过滤）。取值依据：失败是**排序问题**（退化/噪声 passage 与正确 tag 的 cosine 差 <0.02）而非阈值问题，0.50–0.60 区间校准无效，**维持缺省 0.55 不动**（不引入既不改善精度也不改善排序的伪调参）。

**失败原因分析**（如实记录）：

1. **e5-small 短文本 cosine 压缩（主因，模型天花板）**：查询与近邻 passage 的相似度全部挤在 0.85–0.88 窄带（Task 7 诊断实测 0.888–0.897），排名由 passage 构成的微小差异决定；gibberish 与正确语义几乎不可分。
2. **fallback 语料质量（85.5% 行无 wiki）**：退化 fallback passage（usage 0 的拼接串、带逗号 tag 名如 `serafuku,`）与规范 tag 挤在同一分数带，且 KNN 无 usage 信号——usage 0 tag 压顶。探针目标均为高用量 head tag，正确 tag 本身在库内（`serafuku` wiki rowid 203、`rabbit_ears` 等都在），是**排序与语料问题，非建库缺行**。
3. **中文跨语言未达预期**：`水手服` 被嵌入到 water 词形簇（水着/water clothes/hand in water），未映射到 serafuku 语义簇——multilingual-e5-small 的跨语言能力对"具体服装名词→罗马音 tag"这类映射不足（spec §2 决策"多语言嵌入模型直接编码 wiki 释义已可覆盖中文跨语言"**实测不成立**，见 §8）。
4. **探针暴露的 spec 合规缺口（代码修复不在 t6 范围，转交处置）**：§3.2 规定 semantic 层"保留 `@` 画师剔除"，实现中 F3 `@` 剔除只在 fuzzy 级（anima-catalog.ts L221），semantic 层无此过滤——实测 `@selpuku`/`@sleppu`/`@selaf` 等画师 tag 出现在 semantic 命中中（selafuku 探针 10 席占 5）。
5. **可取的正向结论**：拼写容错召回本身存在（selafuku 探针召回 4 个 serafuku 家族 tag）；词形变体（twintail→twintails）由既有 alias 级稳定覆盖且 semantic 自动让位（级联纪律正确）；semantic 层降级/触发/JOIN/阈值机制全程无故障（4 探针均正确走完"前四级全空→semantic 追加"路径，性能 1.1–2.2s/查询，含模型首次加载）。

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

**验收探针已知限制（Task 8 收口定案，§6 实测依据）**：

| 已知限制 | 依据与缓解方向 |
|---|---|
| 中文跨语言映射不足（e5-small 天花板）：`水手服`→water 词形簇而非 serafuku，`兔耳朵`→0 规范耳型 tag | 模型是可替换文件（架构不动）；缓解候选：换更强多语模型（bge-m3）、semantic 命中后 usage_count 重排（Node 侧）、passage 构成 v2（name 复现/尾部放置）——均超出 v1 范围，v1 按 brief"不阻塞收口"记为已知限制 |
| 阈值校准无效：0.50–0.60 全区间排名逐位不变（命中分挤 0.85–0.88 窄带） | 缺省 0.55 维持；gibberish `zzzzzzzzq` 10 hits ≥0.55 属实——阈值只能截尾不能排序，精度提升须靠重排/换模型 |
| semantic 层缺 `@` 画师剔除（§3.2 契约缺口，探针暴露） | 修复归属后续任务（semantic 命中过滤 `display.startsWith('@')` 即可，改动面小）；t6 只记录，不改代码 |
| 退化 fallback passage（usage 0 拼接串/带逗号 tag）与规范 tag 同分带竞争 | 85.5% 行无 wiki 是语料现实；候选缓解同上（usage 重排 / wiki 覆盖提升 / passage v2） |

---

## 附录：后合并修订（2026-09-15，用户定案）

本 spec 合并（main @ 9854da7）后，基于 Task 8 探针实证与用户决策，模型与匹配策略做如下修订：

1. **放弃跨语言**：中文跨语言映射（水手服→serafuku）被用户显式放弃——中文 tag 回到 catalog_miss advisory 既有路径（ZH 概念桥接表 / recall 英文注入兜底不变）。
2. **模型换装**：multilingual-e5-small（384 维，探针 3/4 不达标）→ **bge-base-en-v1.5（768 维，英文单语）**。建库端 BAAI/bge-base-en-v1.5（sentence-transformers，CLS 池化），查询端 Xenova/bge-base-en-v1.5（ONNX，fp16 可选），DIM=768；PM_EMBED_MODEL / PM_EMBED_DIM 可配置，e5 系列可经 env 切回（前缀/池化按模型名条件化）。选型依据：bge-m3（1024 维）在本机笔记本 GPU 热节流至 ~9 行/s（ETA 37h）不可接受，e5-base 同参数级（109M）建库 ~2-3h。
3. **英文匹配约束**：查询含 CJK（汉字/假名，正则 /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/）时在向量入口直接拒绝——不编码、不检索。实现于 nima-vector.ts 查询函数入口，单测覆盖（spy 断言 embedder 零调用）。
4. **在线 API 嵌入通道（env 可插拔，默认不启用）**：PM_EMBED_PROVIDER=api + PM_EMBED_API_BASE/KEY/MODEL 走 OpenAI 兼容 /embeddings；Python 建库侧同通道（批次断点续跑）。用户实测 Ark doubao-embedding-vision（2048 维）单请求上限 10 条、持续限速 ~5.8 行/s（全量 4 天）后弃用在线路线，保留通道作为升级路径。此为对 §5「查询期零网络」底线的**可选扩展**——默认路径仍离线。
5. **@ 画师剔除缺口**（§8 表第 3 行）已在合并后修复（91dc763，semantic JOIN 点过滤 + TDD + live-index 实测），不再列为已知限制。