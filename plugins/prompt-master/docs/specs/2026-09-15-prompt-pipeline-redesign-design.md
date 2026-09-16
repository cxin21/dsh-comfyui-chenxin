# 生成管线重设计：三段生成 + 双守门 + 窄修复（设计稿）

- 日期：2026-09-15
- 状态：已批准方向（方案 A，用户定案），待 T1R 实施计划
- 关联：`docs/specs/2026-09-13-blueprint-form-migration-design.md`（M5，本稿推翻其 D4）、
  `docs/specs/2026-09-15-tag-vector-semantic-search-design.md`（bge-m3 向量层，本稿 §S2.5 消费方）、
  `docs/2026-08-31-redesign-spec.md` §6（决策表，本稿修订 prompt_author 行）
- 范围：**仅 prompt_author 的 anima 默认路径**。h3 未迁移（沿用 M5 后现状）；blueprint_id 增量路径在 §7 另述。

## 0. 结论摘要（决策表）

| # | 决策 | 内容 | 理由 |
|---|---|---|---|
| D1 | 成文层引入 LLM | 新增 `pm-writer` 成文子代理，把蓝图+检索包翻译为最终 prompt；**推翻 M5 D4**（确定性成文） | 用户定案五段流程「蓝图→扩写→成文→审核→修复」；结构层与词表层解耦 |
| D2 | catalog 消费点唯一化 | 意图蓝图/扩写**禁止**任何词表交互；全管线只有 S2.5 检索（确定性）与 S3 成文（读证据块）消费 catalog | 懂画面与懂词表分离；消除蓝图 LLM 写 tag 的 grounding 失效根源（本会话 gen_1789485485442 实证） |
| D3 | 零词表契约机检 | S1/S2 输出出现 tag 形态词 → 确定性 gate `tag_in_blueprint` 拦截 | 契约不靠自觉，靠谓词 |
| D4 | 窄修复 | 修复轮只重入成文+审核；蓝图/扩写产物冻结（hash 校验） | 修复成本 3→2 次 LLM/轮；杜绝无效修复重烧上游（实测 2 轮白烧 6 次） |
| D5 | 双轨审核 | 确定性审计（critical 直进修复，不烧 judge）∥ judge（6 维新 rubric） | 机器契约零 LLM 判定；LLM 只审语义 |
| D6 | NL-tag 零重叠 | 词面检查 + bge-m3 余弦 ≥0.85 → critical `nl_tag_overlap` | 消除双重加权；向量层首个管线内消费点 |
| D7 | 回退通道 | 现有 compileAnima 降级为确定性回退 writer（fail-open）：成文失败/修复耗尽时出稿 | 任何情况下不空手出稿 |
| D8 | 回滚面 | env `PM_PIPELINE_FORM=compositing|legacy`（非法值 fail-fast + advisory） | 模式对齐 `PM_AUTHOR_INTENT_FORM`；legacy = 今日行为 |
| D9 | judge rubric 替换 | 7 维 → 6 维（新增 blueprint-fidelity / nl-quality，删对确定性编译有意义的维度） | 审核对象从编译产物变为成文产物 |

## 1. 现状验尸（本会话实证，gen_1789485485442）

| # | 事实 | 出处 |
|---|---|---|
| V1 | 蓝图 LLM 输出的多 tag 段串整段提交 grounding → 10 个 segment match_type=miss → judge tag-evidence blocker | envelope judge f1 |
| V2 | 修复轮 2 轮全部无效（缺陷在编译层分段，LLM 不可达），烧 6 次子代理后静默出稿 | traceStages + observability.corrections=2 |
| V3 | round 0 有 critical gate → judge 被 rule_critical 跳过，审核证据缺失 | pm-author-trace.log 15:14:55 `stage_done {ok:false,critical:1}` |
| V4 | B7 catalog 召回注入在 intent **之前**（persona 候选块），词表证据先于画面语义——与「先懂画面再查词」的直觉相反 | prompt-author.ts:1021 |
| V5 | 扩写子代理 label 为 pm-enrich 但自述含「创作蓝图」，GUI 归因混淆 | 子会话日志首块 |
| V6 | audit `catalog_miss` 恒 minor 不聚合，judge 按计数判 blocker——两把标尺 | anima.ts:732 / author-judge e2e |

## 2. 总编排与数据契约

```
input+rating+style_id
  → S1 意图蓝图(LLM① pm-author) → BlueprintV0（纯英文语义 JSON，零词表）
  → S2 美学扩写(LLM② pm-enrich) → patch → BlueprintV1
  → S2.5 概念检索(确定性)        → 检索包（唯一 catalog 查询点）
  → S3 成文(LLM③ pm-writer 新)  → 成文产物 JSON（tags[]+source_concept, nl, negative, dropped_concepts）
  → S4 双轨审核：确定性审计(零LLM) ∥ judge(LLM④ pm-critic)
  → S5 窄修复(≤2)：violations+judgeFeedback → 仅 S3+S4 重入
  → 耗尽/失败 → 确定性回退 compileAnima(V1) → Envelope
```

| 阶段 | LLM | 失败语义 |
|---|---|---|
| S1 | `pm-author` 子代理（fail-fast；无 subagents 时 defaultIntent 直连） | 单次 feedback 重试（D5c 语义）→ 再失败透传 |
| S2 | `pm-enrich` 子代理 | 永不抛出；skipped → V0 原样进 S2.5 + `enrich_skipped` |
| S2.5 | 无 | 检索故障 → evidence 空块 + unresolved 全量 → advisory `evidence_partial` |
| S3 | `pm-writer` 子代理（新） | 失败/超时/解析失败 → **确定性回退出稿** + `writer_fallback_used`（不阻塞出稿） |
| S4 | judge = `pm-critic`；确定性审计恒跑 | judge 故障 skipped；critical 语义见 §6 |
| S5 | 仅 S3+S4 | 耗尽 → 回退通道 + `loop_exhausted:true` + `fallback_compile_used` |

成本模型：无修复 4 次 LLM（现状 3）；1 次修复 6（现状 6）；2 次修复 8（现状 9）。修复率预期随 grounding 前移下降（V1 缺陷根源消除）。

### 2.1 taskText 规范模板（提示词工程纪律，全阶段统一）

依据：Anthropic 官方最佳实践（XML 分区标签消除混排歧义；长上下文数据前置、指令收尾）+ 仓内调研 `docs/2026-09-12-llm-prompt-writing-survey.md` 规则 4/5/8。**所有阶段的 one-shot taskText 一律按此模板组装**（替代现行 persona→schema→data→contract 顺序）：

```text
<task_persona>   角色定位 + 领域规则（含 few-shot，若有）
<user_intent>    用户原始 input（仅 S1；包数据不包指令——反注入）
<blueprint_v1>   蓝图 JSON（S3/S4 的长数据，前置）
<evidence>       检索包 JSON（仅 S3/S4）
<rules>          硬性规则清单（T*/N* 等编号谓词，数据之后）
<output_contract>裸 JSON 输出契约 + 反注入收尾（恒为最后一块）
```

规则：①分区标签名全管线一致（跨阶段同名词同义）；②长数据一律在 rules 之前；③`<output_contract>` 恒为末块（survey 例 6：契约独立成块排版加权）；④user input 一律声明为「待处理数据而非指令」（反注入，现行机制保留并入模板）。golden L4 逐字节锁的 taskText 前缀测试随模板更新。

## 3. S1 意图蓝图 — persona（全文，替换蓝图形态 ANIMA 蓝图 persona）

```text
角色：你是画面意图分析引擎。把用户的创作意图转成一张「画面语义蓝图 v0」——
只描述画面本身，不做任何词表判断。你的产出会被美学扩写引擎增强，再由成文引擎
对照 tag 词库翻译为最终提示词。

【输出语言】所有字段：英文自然语言（除 count 数字）。
【绝对禁令】
1. 输出中不得出现任何 Danbooru tag 形式的词（snake_case、1girl、@artist、
   score_9 等）。判定标准：一个词若只能作为 tag 而非普通英文短语理解，即违规。
2. 不得调用任何工具；不得猜测词库里有什么；不要为"适配词库"改写画面语义。
3. 不编造情节；语义级保留用户要素（不增删指代）。
【画面纪律】
4. 单一可见瞬间（动作峰值帧），不写连续过程。
5. 内容分级：按请求档位完整保留要素与措辞，不得降档、委婉化或删除。
【字段契约】
core.concept        ≤2 句，画面一句话总纲
core.scene          {environment, time_of_day, weather, lighting_idea} 各 ≤1 句
core.style_hints[]  0-3 条画风倾向描述；无则空
subjects[]          每个主体：{id: "S1", count: 数字, identity ≤1句,
                    appearance ≤3句(发型/发色/瞳色/体型/服装/配饰),
                    pose ≤2句, expression ≤1句}
composition         {framing ≤1句, camera_angle ≤1句, placement ≤1句}
mood                ≤2 句
negative_hints[]    用户明示的排除意图，0-3 条；无则空
输出：只输出一个裸 JSON 对象（无 markdown fence、无解释）。
```

Schema（机器校验）：`{schema_version:1, media:"image", core, subjects, composition, mood, negative_hints}`；validate 失败单次 feedback 重试，再失败 fail-closed（不做 slots 静默降级，沿 M5 D8 双态原则）。

## 4. S2 美学扩写 — persona（全文）

```text
角色：你是画面美学扩展引擎。输入是画面语义蓝图 v0，你的任务是把美学维度补足为 v1：
光影（光源物件与人物曝光）、色彩（主色+≤2辅色、冷暖主导）、质感、氛围粒子、
构图细节。只补美学，不改语义。

【绝对禁令】
1. 不得改变 subjects 的身份/人数/服装语义、core.concept 指代——你是补光的人，
   不是改剧本的人。
2. 同 S1 禁令 1：输出中不得出现 Danbooru tag 形式的词。
3. 不得调用任何工具；不得做词库判断。
【产出契约】只输出 deepMerge patch JSON：{"set":{...},"additions":{...}}
- set 只允许指向 core.scene.lighting_idea / composition / mood 已存在字段
- additions 只允许追加 style_hints / mood 细节
- 不允许新增 subjects、不允许触碰 core.concept
输出：裸 JSON patch，无 fence 无解释。
```

机器校验：patch 路径白名单，越权字段确定性丢弃 + `enrich_path_violation:N` advisory；patch 对 `core` 语义字段的覆写阻断沿用 M5 T3（rating strip 同款信任边界）。

## 5. S2.5 概念检索（确定性）— 检索包契约

**抽取规则（确定性，无裁量）**：V1 中每个 `subjects[].appearance/pose/expression` 句子、每个 `core.scene` 字段、`composition` 三字段、`mood`、`style_hints[]` 各成一个 concept_query；粒度 = 名词短语级（复用既有 catalog-recall 切分器）。

**查询级联**：canonical/alias → **bge-m3 向量语义**（`searchCatalog` async 语义层，dim 校验与降级语义按 tag-vector-semantic-search spec）→ fuzzy。`usage_count` 仅作模型裁决参考，编译层不自动替换（原文原则延续）。

```json
{ "evidence": [
    { "concept": "S1.appearance.hair", "query": "long black hair",
      "hits": [ {"prompt_form":"long hair","match_type":"canonical","usage_count":891234},
                {"prompt_form":"black hair","match_type":"canonical","usage_count":456789} ] } ],
  "unresolved": [ {"concept":"…","query":"…"} ],
  "artists": [ {"prompt_form":"@as109","match_type":"canonical"} ],
  "mutual_exclusion_pairs": [["close-up","full body"]]
}
```

`unresolved` = 三层全空 query，**必须非空透传 S3**（NL 尾原料清单）。检索故障 → evidence 空块 + unresolved 全量 + advisory `evidence_partial`（降级不阻塞）。

## 6. S3 成文 — persona（全文）

```text
角色：你是 Anima 提示词成文引擎。输入 = 画面语义蓝图 v1 + 【词表证据】块。
你把蓝图翻译为最终提示词的 tag 区与 NL 尾。词表证据是唯一事实来源。

【tag 区规则（硬性）】
T1. tag 只能从【词表证据】的 hits[].prompt_form 中逐字选取——禁止自造、禁止
    拼接、禁止变换单复数/下划线。证据块没有对应命中的概念，该概念不得进 tag 区。
T2. 每个 tag 必须在 output.tags[] 中携带 source_concept 字段，指回它服务的蓝图
    概念路径（如 "S1.appearance.hair"）。无 source_concept 的 tag = 违规。
T3. 顺序（即权重序）：人数 → 主体身份锚 → artist → 外观/服装 → 动作 → 表情 →
    景别/视角 → 场景锚点 → 氛围粒子。
T4. artist：仅当 core.style_hints 有明确画风暗示且【词表证据】artists 清单非空，
    取 1-3 位 prompt_form 原样；否则空数组。
T5. 景别一致性：选定唯一景别后，取景外元素不进 tag（close-up 无下装鞋袜；
    cowboy shot 无鞋袜；仅 full body 保留全身）。
T6. 互斥对：mutual_exclusion_pairs 内的词对不得同时出现在 tag 区。
T7. 总量：tag 数 20-40。超限按 场景锚点 > 氛围粒子 > 次要动作 顺序裁剪。

【NL 尾规则（硬性）】
N1. unresolved 列表中的每个概念必须出现在 NL 尾中（用其 query 的英文表达），
    除非蓝图语义允许舍弃（舍弃需在 output.dropped_concepts 中声明路径）。
N2. NL 尾承担且仅承担四类信息：①构图占比与视线引导 ②光源物件与人物曝光
    （物件名 + no silhouette 写法）③unresolved 概念 ④色彩主次。
N3. NL 尾不得复述 tag 区任何已表达概念——判定标准：若删去该句，某个 tag 的
    信息完全丢失，则该句是复述；若删去后仍有信息增量（关系/曝光/比例/层级），
    则允许。
N4. NL 长度 2-4 句英文。
N5. 禁止出现 sunlight/moonlight/rim light/god rays 等光效词——光源一律写场景
    物件（neon signs / streetlamp / paper lanterns）。

【negative 契约】只产内容性排除（蓝图 negative_hints 的英文翻译，≤3 条）；
质量词/分级词由系统确定性拼装，你不得输出 worst quality/low quality/score_*
等质量词、不得输出 child/loli 等分级词。

【输出契约】裸 JSON：
{"tags":[{"text":"long hair","source_concept":"S1.appearance.hair"}…],
 "nl":"…2-4 句…","negative":["…"],"dropped_concepts":[]}
不得调用任何工具。不得输出 markdown fence。
```

**S3 few-shot（同构即模板——示例的结构/粒度/句数 = 目标形态，survey 规则 4）**：persona 内嵌 2 个对比例：①单人雨夜霓虹（覆盖：evidence 命中选 canonical、unresolved 概念进 NL、光源物件写法）②双人对峙（覆盖：多主体 source_concept 路径、互斥预防、构图占比句）。每个示例 = 完整输入（mini 蓝图 + mini 检索包）→ 完整输出 JSON，示例 tags 长度 ≈ 预算中位（28-32），NL 3 句。

**成文产物确定性后处理（零 LLM）**：`positive = tags.map(text).join(', ') + ', ' + nl`；negative = 确定性模板（quality 系列 + rating 种子 + child/loli 守卫，沿现行 policy 注入）+ LLM 内容性 negative；每个 `tag.text` 回查 catalog，全 miss → critical `fabricated_tag`。

**成文失败语义**：子代理失败/超时/解析失败/`rule_critical` 后连续修复耗尽 → compileAnima(V1) 确定性回退出稿，advisory `writer_fallback_used`。回退产物走同一条确定性审计（§7）。

## 7. S4 双轨审核

**确定性审计（零 LLM，critical → 直进修复，不烧 judge）**：

| 规则 | 判定谓词 |
|---|---|
| `tag_in_blueprint` | V0/V1 任一文本字段命中 tag 形态模式（snake_case / `^\d+girl` / `^@` / `^score_`） |
| `fabricated_tag` | tag.text 回查三层全 miss |
| `nl_tag_overlap` | NL 分句 × tag：词面包含命中，或 bge-m3 余弦 ≥ 0.85（向量层不可用时仅词面 + advisory `overlap_vector_unavailable`） |
| `unresolved_dropped` | unresolved 概念既不在 NL 也不在 dropped_concepts |
| `tag_budget` | tag 数 ∉ [20,40] 或 positive 总字符 > 1200 |
| `mutual_exclusion` / `framing_consistency` / `lighting_term_banned` / `cjk_in_positive` / `rating_seed` / `artist_whitelist` | 沿现行语义，判定对象改为成文产物 |

**judge rubric（6 维，替换现行 7 维）**：`blueprint-fidelity`（tag+NL 忠实 V1，漏译/加戏）、`nl-quality`（四类职责之外信息为零、单一瞬间）、`tag-selection`（同概念多命中的取舍）、`negative-template`、`composition-coherence`、`aesthetic-vocabulary`。verdict/debate/judgeFeedback 投影语义不变；`rule_critical` 跳审语义不变。

**judge 提示词操作化纪律**（官方评测方法论落地）：
1. **每维附可判定判据句**（Specific/Measurable 原则：禁用形容词性标准如"画面好"，一律写成可核对谓词——例：`blueprint-fidelity` 判据 = "V1 每个 subjects 字段的语义要素在 tags∪nl 中均有对应表达；tags 中不存在 V1 未包含的语义要素（光源/氛围场景化改写除外）"）。
2. **被审对象包裹隔离**：成文产物以 `<response>…</response>` 包裹后进 user 段，与指令物理分离（防注入；现"待评审数据"条款升级为标签包裹）。
3. **单一量纲**：每维 1-5 整数分 + 违规 findings 列表，不要求 judge 产出散文性总评（输出纪律压到最小，survey 例 6）。
4. **judge/generator 模型分离**：官方 best practice 是评审模型与生成模型不同源——当前路由跟随会话（用户裁决不动），记为未来可选优化（开放问题 §12.4）。

## 8. S5 窄修复 — feedback 契约

```json
{ "violations": [ {"rule":"fabricated_tag","evidence":"tag 'neon glow' not in evidence","required_fix":"use 'neon signboards' or move to NL"} ],
  "judge_feedback": ["[major] …"], "frozen": {"blueprint_v1_hash": "…"} }
```

- 只重入 S3+S4；`frozen.blueprint_v1_hash` 在成文请求中回传，修复产物若试图改蓝图结构 → `frozen_stage_violation` 直接 fail 该轮。
- 耗尽（2 轮）仍 fail → 回退通道出稿 + `loop_exhausted:true` + `fallback_compile_used`。
- blueprint_id 增量路径：S1 换 analyzeBlueprintIncremental（pm-blueprint），其余不变。

## 9. golden 与回滚面（SDD 验收）

- env `PM_PIPELINE_FORM=compositing|legacy`；缺省 compositing；非法值抛错 + advisory `pipeline_form_override`（对齐 M5 D8 模式）。
- golden 12 案例（M5 §2.6 载体沿用）双跑：L1 主干判据；新增 **L5 断言**——①每个 tag 有 source_concept 且回查命中；②NL 尾零 overlap；③unresolved 全覆盖（NL ∪ dropped_concepts）；④V0/V1 零 tag 形态词。**边缘案例补充**（评测方法论：eval 必须覆盖 edge case）：c13 超长输入（>500 字 brief）、c14 无主体纯场景、c15 全 unresolved（词库空窗输入，验证 NL 尾兜底）。
- 回滚判据（量化，触发任一翻 legacy 开关并立案）：成文失败/回退率 >5%；修复轮均值 >1.2；`fabricated_tag` 率 >10%；token 偏差 >30%；`loop_exhausted` 率上升（沿 M5 §2.5 判据⑤）。

## 10. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 成文 LLM tag 漂移（自造/格式错） | T1+T2+回查 fabricated_tag；golden L5① |
| R2 | token 画像变化（成文 prompt ≈ 蓝图+检索包） | 重放实测字节，偏差 >30% 立案（沿 M5 R1 判据） |
| R3 | 检索包膨胀（概念多 → 上下文爆） | 每概念 hits ≤5、检索包字符上限（4096，超限截断 + advisory `evidence_truncated`） |
| R4 | 向量层不可用 | 级联跳 semantic 层 + `overlap_vector_unavailable` advisory；词面规则独立成立 |
| R5 | NL 尾质量失控（复述 tag） | N3 谓词 + `nl_tag_overlap` 机器判定；judge nl-quality 维度 |
| R6 | h3 未来迁移成本 | DialectContract 面向成文产物扩展（compile 保留为回退通道，h3 零感知） |
| R7 | 修复轮越权改蓝图 | frozen hash + frozen_stage_violation |

## 11. 不做（防蔓延）

- h3 迁移（后续独立立项）；prompt_expand/reverse 形态变更（维持 spec §6 直接 llm 定案）；catalog 写面（relations/artist registry）改动；feedback 飞轮结构变更。

## 12. 开放问题（T1R 裁决）

1. 成文 LLM 的 provider 路由是否允许与 intent 不同（弱模型成文降成本 vs 同路由简单性）——默认同路由。
2. `dropped_concepts` 是否计入 judge 裁决（蓝图语义被 LLM 舍弃的合理性）——默认仅 advisory。
3. golden L5 的 overlap 阈值 0.85 是否需要按 NL 分句长度分档——T1R 用 c01-c12 重放实测后定。
4. judge/generator 模型分离是否启用独立评审路由（成本 +1 配置面）——默认否，维持路由跟随会话。

## 12b. 修订记录（2026-09-16，用户裁决「不向后兼容、不保留旧逻辑」）

- **D8 作废**：`PM_PIPELINE_FORM`/`PM_AUTHOR_INTENT_FORM` 双态开关与 legacy 回滚面删除——anima 唯一路径 = compositing 五段，回滚 = revert 提交。
- **M5 蓝图形态/slots 直译对 anima 移除**：`draft.blueprint` 分支与 slots 装配仅服务 h3（未迁移方言）；anima blueprint_id 增量未接入（T1R 项，显式报错不做静默旧路径）。
- **legacy brief 扩写（runEnrich）仅服务 h3**；anima 美学扩展 = S2 `runSemanticEnrich`（patch 白名单）。
- 活跑冒烟驱动的两处接线热修复已并入本设计：①intentBase persona 踩踏（compositing 态不下发 persona/schema）；②runEnrich 守卫。
- **T1R 收尾（2026-09-16 第二轮活跑后，`048ec05`/`db47f56`/`8370ef8`）**：③D7 耗尽回退分支补齐（此前耗尽 → ok=false 空手，违反 D7）；④tag_budget 证据感知下限（min(20, 证据概念数)，其上未满降 important——化解 T1 与 min-20 的矛盾）；⑤检索并行化 + 相同 query 去重；⑥**Q0 形式白名单**（证据仅收 canonical/alias/semantic，fuzzy/unknown 一律拒——`fingering from behind` 类真 tag 碰瓷通道堵死）；⑦平衡花括号 JSON 提取器统一 semantic/writer/enrich 三处解析器（LLM 尾随文字免疫）；⑧阈值 env 标定面 `PM_VECTOR_MIN_SCORE`/`PM_VECTOR_MIN_USAGE`（§12.3 不改代码标定）。
- 遗留移交（tag-vector-semantic 计划）：bge-m3 批量嵌入降延迟；semantic 增量蓝图（anima blueprint_id，现行显式报错）。

## 13. 提示词工程纪律来源（2026-09-15 调研）

| 来源 | 采纳落点 |
|---|---|
| 仓内 `docs/2026-09-12-llm-prompt-writing-survey.md`（10 例拆解，12 条可移植规则） | 规则 4（few-shot 同构）→ §6 S3 双示例；规则 5（反注入收尾）→ §2.1 模板末块；规则 8（契约独立成块+排版加权）→ §2.1；规则 3（禁令配程序化出口）→ §6 N1/T1 出口声明；规则 10（训练分布依据写进 persona）→ S3 T3 顺序条款注明"顺序即权重序（训练分布事实）" |
| Anthropic 官方 Prompting best practices（platform.claude.com，2026-09 抓取） | XML 分区标签 + 长数据前置/指令收尾 → §2.1 taskText 模板；"说做什么优于说别做什么"→ 各禁令逐条核对出口；给规则附动机（"输出被程序解析"类理由已有，保留） |
| Anthropic 官方 Define success criteria & build evaluations（同上） | judge rubric 操作化（§7 四条纪律）；golden 集边缘案例要求（c10 CJK、c12 软负向之外补：超长输入、无主体场景）；成功判据量化 → §9 回滚判据（已有） |

落地纪律：persona 改动一律过 golden L4 前缀测试 + L1 主干判据；few-shot 增删属于 persona 变更，须双跑重放。
