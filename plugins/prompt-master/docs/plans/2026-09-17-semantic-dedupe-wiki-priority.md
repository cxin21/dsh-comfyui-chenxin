# 语义层近邻去重 + wiki 优先加权 实施计划

- 日期：2026-09-17
- 状态：用户裁决「先做 2、3，不做 1」（不重建向量库——1.1GB/137 万行重建成本高；本计划全部为**查询侧**改动）
- 实测依据（2026-09-17 catalog_search 实测）：
  - "1girl" 原词向量近邻 top-10 全为变体垃圾（`1_female`/`1_girl,`/`standing_female`，usage 0），真 wiki 行（id 10768，usage 9.2M）被挤出
  - 索引 payload：wiki 19.9 万（14.5%）/ fallback 117.6 万（85.5%）；所有实测语义命中 text_source 均为 fallback
  - tag-vector.sqlite 无 meta 表（pre-meta 建库）——维度对账缺位属问题 1（本轮不修）

## D1 语义命中归一化（近邻去重 + 形状清洗）— 修订：usage 门改递进式（用户裁决 2026-09-17）

硬门 usage<100 过狠（全库 94% 行 <100，实测会误伤冷启动真实 tag）。改为**两档递进**：

```
Stage 0 形状清洗（无条件，任何档位不回收）：prompt_form 含逗号/空白异常 → 丢弃
Stage 1 严档：usage ≥ minUsage(默认 100) → 归一化形去重 → wiki 分桶排序 → 幸存数 N
触发：N < minResults(默认 10) 且存在被 usage 门挡掉的候选
Stage 2 宽档：回收 usage 门候选（形状清洗/去重不放宽）→ 合并重排序
排序键（两档同）：[score 分桶(0.05) 降序, wiki 降序, usage 降序, score 降序]
——usage 0 变体只垫尾，wiki 真行/主流 tag 居首，质量不倒挂
可观测：放宽 → semantic_usage_relaxed:true；未放宽且有丢弃 → semantic_usage_dropped:N
阈值可注入：normalizeSemanticHits(items, lookup, { minUsage, minResults })
```

新模块 `dialect/semantic-normalize.ts`：

```
TagLookupFn = (recordIds: string[]) => Map<string, TagRow>
TagRow = { canonical_name: string; prompt_form: string; category: string; usage_count: number }
// 默认实现：queryCatalogInternal 查 tag-catalog.sqlite records 表（单库即含全部字段）
normalizeSemanticHits<T>(items: T[], lookup: TagLookupFn, opts?): { items: T[]; advisories: string[] }
// 只处理 match_type==='semantic' 的项；其余（fuzzy/substring/tie-break 晋升项）原位透传
// 丢弃槽位压缩收缩（不得写 undefined——回填 bug 修复纪律）
```

确定性谓词：

1. **形状清洗**：prompt_form 含 `,`、trim 后为空 → 丢弃（danbooru 单 tag 无逗号；抓取脏行实证 `low tied long hair,`）
2. **归一化形去重**：键 = strip 非字母数字小写（`1_girl,`≈`1girl`）；代表行 = wiki 优先 → usage 降序 → score 降序；代表 score = 组内 max
3. **KNN 过采样**：searchCatalog 的语义查询 k = limit×3，归一化后裁回 limit——去重不缩水

## D2 wiki 优先加权（限幅，防弱 wiki 压强 fallback）

- 排序键（仅语义项内部）：`[bucket = floor(score/0.05) 降序, isWiki 降序, usage_count 降序, score 降序]`
- 语义：同 0.05 分桶内 wiki 优先；跨桶严格按分数——0.94 fallback 永远排在 0.83 wiki 前（实测警示：bge-base 活跑现实区间 0.6-0.8，盲排 wiki 会引入弱命中）
- advisory：`semantic_dedupe:<n>`、`semantic_malformed_dropped:<n>`（可观测，计数非阻断）

## D3 接线

`searchCatalog` 语义分支：`vs(normalized, limit*3)` → `normalizeSemanticHits` → 裁 limit → 既有 substring 合并 / joinWithCatalog / tie-break 流不变。lookup 默认实现走 `queryCatalogInternal`（既有 G3 句柄缓存通道），测试可注入。

## 明确不做

- 不重建向量库（问题 1，用户裁决不做）；索引内脏行仍在，仅查询侧不再让它们冒充结果
- 不动 retrieval-pack（管线已不消费）；不动 fuzzy/canonical/alias 层
- 拼接畸形（`looking_backlooking_at_viewer` 类）无确定性形状谓词可依——不在本轮（usage 门已在管线侧兜底），标注遗留

## 验收

1. ✅ TDD：normalize 纯函数 9 用例（递进放宽/严档保持/minResults 注入/归一化形去重/形状清洗/wiki 分桶优先/跨桶不重排/非语义透传/lookup 缺行 grace）
2. ✅ 既有 anima-catalog-semantic 测试全绿（种子校准为 twintails usage 1.31M；'组合' 测试按递进式契约重写并留 justification）
3. ⚠️ 活体终验（部分达成，见下「完成记录」遗留）：变体清场/放宽/垫尾/形状清洗全部生效；**1girl 概念近邻的 wiki 浮出未达成**——根因在索引内容（变体行 passage 与真行向量近乎重合，查询侧排序无法分离），根治需方案 1（重建向量库）

## 完成记录（2026-09-17，commit 6c7d368）

- 新增 `dialect/semantic-normalize.ts`（纯函数，递进两档）+ `anima-catalog.ts` 装配（createCatalogTagLookup 独立缓存句柄 / searchCatalogWithMeta / KNN 过采样 ×3 / sub 召回长度门 24 + Levenshtein ≥0.5 相关门）+ `catalog-search` 工具切 meta 版透传 advisory。
- 实现期修复三处自伤：①回填 undefined（门丢弃后 semanticResults 短于槽位 → 压缩语义）；②SemanticHit 无 match_type 字段（joinWithCatalog 之后才加——调用点显式打标）；③泛型 spread 丢 T（Object.assign as T）。
- 活体终验（新 dist 真实查询）：
  - 长自然语言查询：`semantic_usage_relaxed:true` + `semantic_malformed_dropped:2`，脏行（`one eye closed,`）消失，usage 降序可见 ✅
  - selafuku：serafuku fuzzy 提位 #1，serfafuku 等 usage 0 变体宽档垫尾（不再饿死）✅
  - 1girl 概念近邻：**wiki 浮出未达成**——KNN 近邻被 fallback 变体 passage 挤占是索引内容问题，查询侧无法分离；根治 = 方案 1 重建（变体行不建/按 canonical 合并建 + meta provenance），届时本模块自动受益
- 全量：tsc 0 / eslint 0 / 155 files / 1328 tests pass
