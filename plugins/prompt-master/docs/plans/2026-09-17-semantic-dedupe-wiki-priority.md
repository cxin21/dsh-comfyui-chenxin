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

1. TDD：normalize 纯函数 6 用例（去重代表选择/形状清洗/wiki 分桶优先/跨桶不重排/非语义透传/lookup 缺行 grace）
2. 既有 anima-catalog-semantic 测试全绿（stub record_id 落在真实库上，断言按新契约校准并留 justification）
3. 活体终验：`catalog_search` 对 "1girl" 类查询的语义命中不再出现 `1_girl,` 类变体；wiki 行浮出
