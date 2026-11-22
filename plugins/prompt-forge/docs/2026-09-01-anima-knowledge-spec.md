# Anima 知识资产管理面吸收 · 设计 Spec（G1-G7 全量）

> 版本：v1.0 · 日期：2026-09-01 · 状态：brainstorming 分节确认完成，待用户终审
> 依据：`docs/2026-09-01-anima-absorb-audit.md`（吸收完整性审计：10 项裁定 = PARTIAL 6 / MISSING 3，差距 7 条）
> 用户裁决：①G1 用独立新工具 `catalog_relations`（读写分离）；②范围全量 G1-G7；③分三批实施（审计建议顺序）
> 延续原则：接口红线（spec §8 上一轮）、只读/可写分离、声明制扩展、日志摘要级

## 0. 问题定义

插件对 anima-prompt-v1 的吸收呈「算法内核保真、知识资产管理面缺位」：搜索级联/grounding 红线/golden 双跑均已对等，但 tag 字典作为**活资产**的管理闭环（build/verify 深检/browse/stats/relation 沉淀/重建后对账）未吸收——插件是知识的只读消费者，skill 是维护者。本 spec 补齐管理面。

## 1. 总架构与批次

```
B1（第一批 S×3，堵正确性风险）
  G4 句柄刷新（mtime 检测 → close+reopen+重新对账）
  G3 browse/stats/verify 深检
  G5 candidate 标记 + usage≥1000 阈值 advisory
B2（第二批 M）
  G2 phase_status + segments/citations.source 投影
B3（第三批 M+S）
  G1 catalog_relations 工具（relation 生命周期，可写 overlay）
  G7 单模式查询 + category/source 过滤
```

## 2. 第一批：正确性 + 发现面（G4/G3/G5）

### 2.1 G4 句柄刷新（`anima-catalog.ts` 改造）

```ts
let _lastMtimeMs = 0;
function db(): DatabaseSync {
  const path = catalogPath();
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    /* 首次打开前缺失由 assert 报 */
  }
  if (_db && mtime !== _lastMtimeMs) {
    _db.close();
    _db = null;
    _manifestChecked = false; // 重新对账
  }
  if (!_db) {
    verifyManifestOnce();
    _db = new DatabaseSync(path, { readOnly: true });
    _lastMtimeMs = mtime;
  }
  return _db;
}
```

- 每次 db() 打开 statSync 一次（开销可忽略）；mtime 变化 → close 旧句柄 + 重置对账 flag + 重开
- 对账结果新增进程内状态 `lastManifestCheck(): { ok: boolean; reason?: string } | undefined`——供 catalog_search 输出 `manifest` 状态（对 agent 可见，替代 console.warn-only）

### 2.2 G3 browse/stats/verify（`anima-knowledge/browse.ts` + `verify.ts`）

```ts
// browse.ts
export function browseCatalog(opts?: { category?: string; source?: string; limit?: number }): CatalogHit[];
// SQL: names JOIN records [WHERE r.category=? / r.source=?] ORDER BY usage_count DESC LIMIT ?（无 query 扫表）

// verify.ts
export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}
export function verifyCatalog(): VerifyResult;
// ① manifest checksum vs sha256 实算（既有 assertAnimaCatalog 逻辑内联/复用）
// ② COUNT(catalog_fts) == COUNT(names)（漂移检测）
// ③ 4 表存在：records/names/catalog_fts/sources（catalogMeta 的表枚举复用）
// ④（可选后置）PRAGMA table_info 列序对齐
```

### 2.3 G5 candidate + 阈值 advisory（`tools/catalog-search.ts` 扩展）

- hits 投影：`candidate: match_type === 'fuzzy'`（纯输出投影，查询不动）
- 顶层 advisory：命中 fuzzy 且 `usage_count < 1000` → `fuzzy_below_threshold: usage_count=N 低于采纳阈值 1000，仅作候选参考`
- **G4 联动**：输出 JSON 增加 `manifest: { ok, reason? }`（对账状态对 agent 可见）

### 2.4 验收

- G4：mtime 变化 → close+reopen+重新对账（mock statSync）；不变不重开；重建后查询自动用新库
- G3：browse category/source/limit；stats 三计数（fixture 小库对账）；verify 四检查 ok/fail 分支
- G5：candidate 标记；阈值 advisory；canonical 无 candidate

## 3. 第二批：G2 author 载荷投影

### 3.1 `compileAnima` 返回值扩展（`anima.ts`）

```ts
export interface CompileAnimaResult {
  positive: string;
  negative: string;
  notes: string[];
  assumptions: string[];
  // G2 新增：
  segments: Array<{
    text: string;
    channel: 'positive' | 'negative';
    origin: 'policy' | 'grounded' | 'user-fuzzy' | 'narrative' | 'exclusion';
    priority: number;
    slot?: string;
    citation?: AnimaCitation;
  }>;
  phaseStatus: { policy: 'PASS'; grounding: 'PASS' | 'ADVISORY'; composition: 'PASS'; inspection: 'PASS' | 'ADVISORY' };
  metadata: { variant: string; subject?: string };
}
```

- **segments**：3c 循环已有的 base/slotName/citation 直接投影（去掉 `void base`）；origin = policy/grounded/user-fuzzy/narrative/exclusion
- **phaseStatus 推导**：policy 恒 PASS；grounding = 存在 record_id citation → PASS 否则 ADVISORY；composition 恒 PASS；inspection = gates 有 important+ → ADVISORY 否则 PASS
- **citations.source**：citation 建立时补 `SELECT s.value FROM sources s JOIN records r ON r.source_id=s.source_id WHERE r.record_id=?`（sources 表已在 4 表清单）
- **metadata.subject**：slots.subject 存在则带上（G6 顺带：validateAnimaSlots 对 subject 加「可选 string」校验）

### 3.2 Envelope 投影（路径定稿）

- **compile 返回值承载**：`segments/phaseStatus/metadata/citations` 是 compileAnima 的返回字段（方言特有载荷，与 h3 的 `text_zh` 同模式）→ 经 runStage 的 `stage.result` 进入 Envelope 的 `result` 内（`result.segments` 等）。
- **顶层 `phase_status`**：SKILL.md:343-356 要求 agent 逐字报告四阶段状态——故 anima 分支的 envelope **顶层**额外带 `phase_status`（render 层 `assembleEnvelope` 增加可选第四参 `dialectTopLevel?: Record<string, unknown>`，方言组装点传入；h3 不传则不出现在其 Envelope——保持方言特有载荷不入通用层）。
- **citations**：从 notes 字符串升级为 result.citations 结构化数组（record_id/canonical/prompt_form/source/match_type），notes 保留人话版。

### 3.3 验收

golden 双跑不受影响（positive/negative 逐字节不变——segments 是附加投影）；segments 结构逐项测试；phase_status 四态；citations.source 查询。

## 4. 第三批：G1 relation 生命周期 + G7 查询扩展

### 4.1 存储与模块（`anima-knowledge/relations.ts` + `tools/catalog-relations.ts`）

- **overlay 库**：`<preset>/temp/anima-prompt-v1/relation-overlay.sqlite`——独立**可写**库（node:sqlite 读写模式），与只读 catalog 分离（skill 红线）
- **校验链纯函数**（relation_submission.py 203 行移植）：

```ts
export interface RelationProposalInput {
  source_tag: string;
  target_tag: string;
  relation: string;
  confidence?: number;
  note?: string;
}
export function validateProposal(input, catalog: CatalogQueryPort): { ok: true } | { ok: false; issues: string[] };
// ① 端点存在性（source/target 须 canonical/alias 命中）② cooccurrence 拒收
// ③ signature 归一化去重（source→target 与 target→source 同签名）④ proposal_id = sha256(signature)
export function submitProposal(db: DatabaseSync, input, model?: string): { proposal_id: string; status: 'candidate' };
export function listProposals(
  db,
  opts?: { status?: 'candidate' | 'accepted' | 'rejected' | 'all'; limit?: number },
): ProposalRow[];
export function decideProposal(
  db,
  proposalId: string,
  decision: 'accept' | 'reject',
): { proposal_id: string; status: string };
// accept 的 canonical 降级保护：已有 canonical 命中的 tag，accepted overlay 不覆盖（UPSERT 语义）
```

### 4.2 工具面：`catalog_relations`

```ts
name: 'catalog_relations'
actions:
  submit  {source_tag, target_tag, relation, note?}   → 校验链 → candidate 态入 overlay
  list    {status?, limit?}                            → 提案列表
  accept  {proposal_id}                                → 决策（searchCatalog 随后命中 overlay 别名）
  reject  {proposal_id}
  status  {}                                           → overlay 库状态/提案计数
```

### 4.3 闭环打通

accept 后 `searchCatalog` 查询命中 overlay 别名——现有 `applyRelationOverlay` 空壳升级为真实读取 overlay 库的 accepted 别名（alias 级插入，canonical 保护）。

### 4.4 G7 查询扩展（`anima-catalog.ts` CatalogQueryOptions）

```ts
mode?: 'auto' | 'exact' | 'canonical' | 'alias' | 'fuzzy'   // 单模式直查
categories?: string[]                                        // r.category IN (...)
sources?: string[]
// 兼容：auto/exact 语义不变（golden 不动）
```

### 4.5 验收

- 校验链：端点缺失拒 / cooccurrence 拒 / 重复 signature 幂等 / proposal_id 确定性（同输入同 id）
- 闭环：submit → candidate → accept → searchCatalog 命中 overlay 别名 → canonical 保护
- G7：单模式直查 + categories 过滤 SQL
- overlay 库写入失败（temp 目录缺失等）→ 可读错误

## 5. DSH 接口真实性（全部已验证，无新增）

| 接口                                        | 使用批次 | 验证                                                  |
| ------------------------------------------- | -------- | ----------------------------------------------------- |
| node:sqlite DatabaseSync（readOnly + 读写） | 全部     | 现有 readOnly 直读运行中 ✅；读写模式为 Node 标准能力 |
| statSync（mtime）                           | G4       | node:fs 标准 ✅                                       |
| ctx.logger（info/warn）                     | 全部     | cordis L457-460/L1687 ✅                              |
| randomUUID / createHash                     | G1       | node:crypto 标准 ✅                                   |
| resolveKnowledgePath / setPresetRoot        | 全部     | 本插件 Task 1 ✅                                      |

## 6. 日志与可观测性

- 纯函数层零日志；relations.ts 的库写入返回结构化结果，工具层打 `ctx.logger.info`
- catalog_search 输出的 `manifest` 状态（G4）让对账失败对 agent 可见
- relation 决策日志：`relation accept proposal_id=... → status`

## 7. 测试策略

| 层   | 用例                                                                                    |
| ---- | --------------------------------------------------------------------------------------- |
| G4   | mtime mock 变化 → reopen；重建后重新对账；不变不重开                                    |
| G3   | browse 过滤/limit；stats 对账（fixture 库）；verify 四检查分支                          |
| G5   | candidate/阈值 advisory/canonical 无标记                                                |
| G2   | segments 逐项（origin/priority/slot）；phase_status 四态；citations.source；golden 不变 |
| G1   | 校验链四条 + 闭环（submit→accept→search 命中）+ canonical 保护 + 幂等                   |
| G7   | 单模式直查 + categories 过滤                                                            |
| 回归 | 全量（400 基线）+ fidelity 52                                                           |

## 8. 实施批次

| 批     | 任务                                                                                          | 验收                   |
| ------ | --------------------------------------------------------------------------------------------- | ---------------------- |
| 第一批 | G4 句柄刷新 + G3 browse/stats/verify + G5 candidate/阈值                                      | 全绿 + fixture 对账    |
| 第二批 | G2 segments/phase_status/citations.source/metadata                                            | golden 不变 + 投影测试 |
| 第三批 | G1 catalog_relations + 校验链 + G7 单模式/过滤                                                | 闭环测试 + 全绿        |
| 收尾   | usage 文档 + 端到端（relation submit→accept→search 闭环 + skill 重建 catalog 后插件自动刷新） | —                      |

## 9. 决策记录

- D1（用户）：G1 独立新工具 `catalog_relations`（读写分离）
- D2（用户）：范围全量 G1-G7，分三批
- D3：catalog 恒只读；overlay 独立可写（skill 红线）
- D4：G4 对账失败不硬崩——warn + `manifest` 状态输出（agent 可见），与既有 estimate 回退语义同级
- D5：segments/citations 是**附加投影**——golden 双跑（positive/negative 逐字节）不受影响
- D6：G7 单模式/过滤为便利面（golden 已锁 auto 级联，新模式不改级联语义）
- D7：B3（上一轮）定界的定界封套/垃圾分类器仍不做——与本 spec 正交

## 10. 明确不做

- catalog.build（tags.sqlite→catalog 重建）——属 skill CLI 的资产管理，插件消费重建产物即可（G4 让重建自动生效）
- prompt_author 的完整 CLI envelope 形态复刻（只投影 phase_status/segments/citations/metadata 四个契约面）
- relation 的 UI/GUI 面
