# 2026-09-15 semantic 层活性实测报告（catalog 向量+wiki 检索验证）

## 背景与触发

真实会话 gen_1789483412121_99prwpiv（anima/explicit）出稿后，用户质疑：① intent/judge 子代理不可见；② catalog 查询未走设计的"向量+wiki"逻辑。本报告只覆盖问题②的实测裁决；问题①的根因分析（one-shot 子代理无 UI 观测面 + traceStages 拼接顺序假象）见会话记录。

## 实验设计

| 探针 | 路径 | 目的 |
|---|---|---|
| A1/A2 | `catalog_search mode=auto`（DSH host 进程 = 真实运行时） | 观测 auto 级联能否到达 semantic 层 |
| B1 | node 进程内直调 `dist/.../anima-vector.js` `createVectorSearch`（默认 embedder，无 PM_EMBED_MODEL） | 复现查询侧完整路径，暴露被吞的降级 warn |
| B2 | sqlite-vec 扩展加载后 `SELECT length(embedding) FROM vec_items` | 终审索引维度 |
| B3 | 反查命中 record_id → tag-catalog records | 评估语义命中质量 |

## 实测结果

1. **B1：向量检索成功，零降级。** 查询 `shiny skin tight outfit on adult lady` → 2.9s 返回 5 个 semantic 命中（score 0.755–0.778，全部过 0.55 阈值）。无 `[prompt-master] semantic layer degraded` warn。
2. **B2：索引维度 = 768（int8 字节直读）。** `tag-vector.sqlite`：mtime 2026-09-15T05:40:36Z，1091.7 MB，1,374,902 行。查询侧默认 `Xenova/bge-base-en-v1.5`（768d，fp32/CLS）与索引**同维**——`anima-vector.ts:54-55` 警告的维度错配**当前未发生**。
3. **B3：语义命中质量良好。** 5 命中 = shiny_bodysuit(33) / sexy_outfit(2) / shiny_clothed / shiny_costume / shiny_skin_bikini——lexical 域正确，排序合理。注意：命中 `text_source='fallback'`（库内 wiki/fallback 混合）。
4. **CJK 硬约束生效。** 中文查询直接拒绝（`anima-vector.ts:234`），返回空，不编码不检索。
5. **A 路：semantic 层在 auto 级联中实际可达性 ≈ 0。** 两条探针短语全部被 fuzzy 层截胡（FTS5 OR+前缀过宽，`shiny skindated` 这类 usage_count=0 噪声也命中）。fuzzy 不空 → 级联永不走到末位 semantic。

## 裁决

**"向量+wiki"层是活的、健康的、同维的；但生成主链路（prompt_author）结构性地够不着它**，三层叠加：

1. **设计定案**（spec §3.2 双入口拆分）：grounding/F2/B7 召回全部 exact-only，semantic 永不参与采纳；
2. **级联截胡**（本次新发现）：auto 级联 fuzzy 层 OR+prefix 对多词短语几乎必然命中 → semantic 末位实际不可达；
3. **接线缺口**：post-hoc semantic_fallback 转换只挂在 `prompt_audit` 工具；prompt_author 内嵌 audit 缺省 sync seam 永远看不到 semantic 层。

## 附带发现（provenance 风险）

- 索引实际 768d（bge-base），与 L2 记忆"09-15 bge-m3 1024d 重建落盘"**矛盾**；preset 内无 1024d 文件。落盘的重建产物与脚本默认（`build_tag_vector.py:34` MODEL 默认 BAAI/bge-m3）不一致，说明重建时 env 覆盖或产物落点需向操作记录求证。
- `tag-vector.sqlite` **无 model/dim 元数据表**（仅 vec0 内部 info）——建库模型/维度不可自证。查询侧（默认 bge-base 768d）与建库侧（默认 bge-m3 1024d）**默认值不同**，当前对齐纯靠偶然/历史 env。任何人按脚本默认重建索引而不设 `PM_EMBED_MODEL`，semantic 层将**静默降级**（catch→warn→[]，生成回路无感）。

## 建议

1. **建库侧写元数据**：build_tag_vector.py 落库时写入 `meta(model, dim, built_at)`；查询侧打开时对账，不匹配 fail-fast（升级为显式错误而非静默降级）。
2. **消除双默认漂移**：查询侧默认改为与建库脚本同一来源（或两侧都强制 env）。
3. **级联可达性**：若要让 semantic 真正兜底，需决策——fuzzy 层加 usage_count 门槛（噪声候选直接放行到 semantic），或 semantic 不再要求"前级全空"。
4. **prompt_author 接线**：把 prompt_audit 的 post-hoc semantic_fallback 转换搬进 author 审计汇编（只发 advisory 不参与采纳，保住防幻觉语义）——需修订 spec §3.2 定案，用户拍板。

## 裁决更新（2026-09-15 深夜，建议 1 落地 + 疑点 2 结案）

**疑点 2（bge-m3 产物去向）由 git 证据结案**：L2 记忆"bge-m3 1024d 重建落盘"已过时。时间线：
- `aa64512`（09-14 21:29）bge-m3 切默认 → **`73198be`（09-14 23:37）spec 修正案：模型换轨回 bge-base-en-v1.5（768d），跨语言按 probe 证据放弃** → `ce901f5`（09-15 13:44）查询侧默认对齐 merged bge-base index（索引 mtime 13:40，commit 仅晚 4 分钟）。
- 现库即终态：bge-base 768d，两侧本就对齐；本报告"附带发现"中的"矛盾"实为记忆未同步，bge-m3 无产物留存属预期。

**建议 1 已落地**（commit 待本轮回归确认）：
- 建库侧：`build_tag_vector.py` 新增 meta 表（model/provider/dim/count/quant/distance/text_sources/built_at）+ 首批实测维度守卫（embedder 输出 ≠ PM_EMBED_DIM 时显式退出，防 768 模型灌进 1024 表）。
- 查询侧：`anima-vector.ts` 新增 `readMeta` 对账——维度错配抛 `VectorDimensionMismatchError`（console.error 每次留痕 + 类型化穿透 catch-all，`searchCatalog` 降级语义不变）；无 meta 的旧库按 legacy 一次性提示，向后兼容。
- 测试：`anima-vector.test.ts` fixture 支持 meta，新增 legacy 兼容 / meta 匹配 / 错配 fail-fast 三用例。
