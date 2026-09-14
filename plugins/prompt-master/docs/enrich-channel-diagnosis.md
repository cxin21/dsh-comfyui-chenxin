# M5-DIAG：enrich 直连通道真实会话 100% 失败诊断

**日期**：2026-09-14　**执行者**：impl-2（t16）
**现象来源**：清单④真实会话重放（captain 新会话执行，两次运行 = 01:52 与 00:46 两代 dist）
**结论速览**：插件侧可修，已修（maxTokens 截断 + 失败原因不可观测 + c04 artist 槽引导缺失）；非宿主凭据限制。

---

## 1. 现象（实测 6/6）

| 项 | 观测 |
|---|---|
| 失败率 | 6/6（两代 dist、多案例一致，非输入相关） |
| 时长 | traceStages `blueprint_enrich` 10.3s / 11.3s / 10.5s / 10.4s / 10.9s（高度均匀） |
| envelope 痕迹 | `expansions=['enrichment_failed:fallback_to_v0']`，蓝图回退 v0 |
| 对照通道 | intent 走 DSH 子代理基础设施 15-95s 全部成功（同会话路由可用） |
| mock 面 | engine/orchestration 全绿——stub route 不暴露真实通道问题 |
| 级联后果 | 美学扩展层生产空转 → `tag_count_out_of_range`（c02 11/c03 9/c04 6 content tags）+ `aesthetic_*_missing` 全家桶 |

## 2. 链路核查（route.ts + complete.ts + engine.ts）

```
prompt-author 蓝图出口 → enrichBlueprint(ctx, route, v0, opts)   [enrichment/engine.ts]
  route = resolveRoute(exec)        [llm/route.ts] — 会话 requestHeader().config → agent.options → 报错
  complete(ctx, {provider, model…}) [llm/complete.ts] — ctx.llm.stream（宿主 llm 服务，插件直连）
  → BlockAssembler → finish.kind ∈ {stop|tool-calls|max-tokens|aborted|error}
  → JSON.parse(stripFences(text)) → patch 应用 → v1
```

- **凭据/路由无嫌疑**：`ctx.llm` 是宿主服务（cordis inject），凭据与会话同源；intent 子代理成功证明会话路由与凭据可用。`resolveRoute` 若解析失败会显式抛错（不产生 fallback_to_v0），与实测形状不符。
- **失败被三处 `catch {}` 吞掉**（engine.ts 旧 L216/223/283）：llm 抛错、JSON.parse 失败、patch 应用抛错三个分支返回**同一个** generic token——真实会话 envelope 无从区分 auth/timeout/截断/parse 四类原因。这是诊断只能靠猜的直接原因，也是本次必修的可观测性缺陷。

## 3. 根因定位

### 根因①（主因，已修）：maxTokens=1024 截断 → parse 失败 → generic fallback

- dsh-llm `FinishReasonMap` 中 **`max-tokens` 是正常终止**（非 error/aborted）——截断的补全**不会抛错**，静默返回非 JSON 文本（patch 回显或推理文本被预算切头）→ `JSON.parse` throw → 落入旧代码的 parse catch → generic fallback。
- **量化吻合**：~10.3-11.3s ≈ 1024 tok @ ~100 tok/s（会话模型生成速度同量级）；100% 失败（预算必被吃满，截断必发生）与输入无关。
- 对照：intent 子代理通道的 token 预算由宿主 subagent 基础设施控制（大预算），同一会话模型成功产出完整蓝图 JSON——排除模型本身不能输出 JSON 的可能。
- 修复：`maxTokens 1024 → 4096`（增量 patch + expansions 余量；对比 analyzer intent 1400 起步仍成功）。

### 根因②（已修）：失败原因零可观测

三处 catch 分支现已各自携带原因进 `expansions`（legacy token `enrichment_failed:fallback_to_v0` 保持**首位不变**，既有断言面零漂移）：

| 失败类 | 新增 expansions 条目 |
|---|---|
| llm 调用抛错（auth/timeout/transport…） | `enrichment_failed_reason:llm:<code>:<message≤160>` |
| parse 失败（含截断文本） | `enrichment_failed_reason:parse:<finishKind>:<文本head JSON≤200>` |
| parse 成功但非对象 | `enrichment_failed_reason:parse:<finishKind>:non-object:<typeof>` |
| patch 应用/自检抛错 | `enrichment_failed_reason:apply:<message≤160>` |

真实会话下一次运行即可直接读出分类：若为 `llm:AUTH/NO_ADAPTER/...` → 届时才是宿主侧限制，按 code 升级宿主问题；若为 `parse:max-tokens:` → 预算仍不足（再调）；若为 `parse:stop:` → 模型输出形态问题（persona/解析策略再修）。

### 根因③（已修，c04 artist 槽丢失）：蓝图 persona/schema 对 artist_hints 零引导

- `ANIMA_BLUEPRINT_SCHEMA` 的 `core.style` 只有 `{base, theme, palette}`——**无 `artist_hints` 字段**；`ANIMA_BLUEPRINT_PERSONA` 十条规则**零画师引导**。
- 而 `projectToAnima` 的 artist 槽**只**消费 `core.style.artist_hints`（catalog grounding 编译期升级 @形）；slots 时代的 `ANIMA_PERSONA` 有完整【artist 槽】块（画师清单 + 防编造规则），蓝图迁移时该引导**未随迁** → 真实会话 LLM 把 wlop 写进文本字段（narrative/style.base 一类）→ 投影后落入 detail_mood 通道文本，artist 槽空。
- 修复（blueprint/analyzer.ts，**预告 scope 增量**）：schema `core.style` 增 `artist_hints` 键（用户未提及则省略整键）+ persona 规则 11（用户明确提及的画师裸名原样入 `artist_hints`、不写文本字段、不确定存在不写防编造）。

### 顺带（低危，已修）：孤儿 AbortController

旧代码 `new AbortController().signal` 从不取消且与调用方生命周期无关——`EnrichOptions` 增 `signal?: AbortSignal` 透传（缺省行为不变）；prompt-author 侧 `exec.signal` 接线属编排文件（不在本任务 scope），留待后续任务。

## 4. 宿主侧结论

**非宿主侧限制**：直连通道走宿主 `ctx.llm` 服务（与会话同凭据同路由），intent 子代理同期成功证明凭据/路由/网络可用；失败形状（均匀 ~10-11s + max-tokens 正常终止 + parse 失败）与凭据/配额类失败（快速 4xx 或重试爬升）不符。若升级后的真实会话 reason 显示 `llm:AUTH|NO_ADAPTER|...`，再按 code 升级宿主问题。

## 5. 真实会话验证路径（修复后）

1. **重启 DSH 会话**（挂载新 dist）。
2. **单案例实测**：任选一 replay 案例（建议 c04，顺带验证 artist 修复）调用 `prompt_author`（judge off），查 envelope：
   - `expansions` **不含** `enrichment_failed:*` → 直连通道恢复，美学扩展层生效（`aesthetic_*_missing` 收敛）；
   - 仍含 → `enrichment_failed_reason:*` 直接给出分类，按 §3 表继续。
3. **replay 补充**：按 `docs/blueprint-migration-replay.md` §4 sheet 跑 12 案例，记录各案例 expansions 与 `aesthetic_*_missing` 收敛情况，回填 replay doc §8 指标③④。
4. c04 专项：envelope `blueprint_id` 对应落库蓝图的 `core.style.artist_hints` 应含 `wlop`（repo.load 或 blueprint_id 增量入口可查）。

## 6. 测试与验证留痕

- engine.test.ts +6（M5-DIAG describe，TDD RED→GREEN）：maxTokens=4096 透传 / error finish reason（code+message）/ max-tokens 截断 parse reason（finish kind + 文本 head）/ 非对象 reason / apply throw reason / signal 透传。legacy token 首位断言贯穿全部失败路径。
- analyzer.test.ts 前缀断言（基座逐字）与 schema 断言与增量编辑兼容；golden 40 / e2e 8 / orchestration 33 全绿。
- 全量 + tsc + build 见任务载荷 commandsRun。

---

## 7. DIAG2 收口（2026-09-14，captain 第一性原理分析 + 亲自修复，用户裁定不派代理）

**最终根因链（三层，全部有实测证据）**：

1. **reasoning 预算吞噬**：直连路由跟随会话模型（fangzhou/ark-code-latest，reasoning 类）；思考 token 计入
   maxTokens 预算且不产出 text 块——1024@10.5s / 4096@38.7s / 1400@13.6s 三档恒打满（≈106 tok/s）且文本头
   恒空（`parse:max-tokens:""`）。T16 的「量化回调」方向性错误：上限本身是错误参数，思考期要多少都吃。
   **修复**（aecb720，用户裁定「不设 maxTokens 上限」）：直连通道全面省略 maxTokens → 宿主 defaultMaxTokens
   语义（主对话同路径本来就正常出内容）；纪律 persona 保留、v0 fallback + reason 透传兜底不变。
2. **text 块 text=undefined**：maxTokens 解除后 text 流首次真实到达，暴露适配器流首块 text 块 text 字段
   undefined → complete() `b.text.trim()` 裸崩。**修复**（a43616e）：`(b.text ?? '').trim()` 防御合并。
3. **CJK 回流 → loop_exhausted**（c04 探针 ok=false 实录）：intent/enrich persona 零语言纪律 + enrich few-shot
   样板自身含中文值（教学效应）；修复轮把 intent 改好后 enrich 每轮把中文写回 tag 字段，cjk_in_positive
   critical 永不收敛。**修复**（b703304）：双 persona 硬性英文纪律（intent 规则 12 / enrich 规则 11）+ 样板
   去 CJK——掐断污染源而非绕过 CJK gate（compile 层注释明确该 gate 是修复闭环的驱动器，不得删除）。

**重放期衍生修复**（c07/c12 实录，同属本通道信任边界）：negative 条目形状 fail-closed 校验 + L1 确定性丢弃 +
投影防御（33e2bce）；LLM 负向 hard→soft 确定性降格（987f804，hard 为安全通道专属域，与 core.rating strip
D6/R7 同哲学）。

**终局**：12/12 golden + h3 真实探针全绿、0 超时、0 loop_exhausted、enrich 三轮真实产出（expansions 7–14 条/轮）。
诊断设施留痕：阶段级文件 trace（%TEMP%/pm-author-trace.log，工具边界 CRASH stack 捕获后原样 rethrow），
缺陷定位后可移除。指标与缺陷台账见 replay doc §4.3/§4.4/§8。
