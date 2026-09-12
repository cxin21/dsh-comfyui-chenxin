# prompt-master 提示词质量外部基准对比（2026-09-11）

对照 4 个外部仓库诊断 `plugins/prompt-master` 的 Anima 提示词产出质量。

## 一句话结论

我们的管线是**「结构工程强、美学内容空」**：审计/编译/段级溯源做得比所有对照仓库都细，
但喂给 LLM 的美学知识接近零、标签生成靠模型记忆而非检索证据、风格库是中文散文而非
danbooru 词表——所以产出「正确但平庸」，没有美学与设计感。

## 反向拆解：四家各解决什么、凭什么有效

### 1. DanbooruSearchOnline（226★）——证据层
- **问题**：LLM 凭训练记忆写 tag → 幻觉、漏配、废弃标签。
- **方案**：4 维语义向量检索（英文 / 中文扩展词 / 维基释义 / 中文核心词）+ 标签共现
  NPMI 推荐 + 画师共现推荐 + 官方 alias 归一。提供 MCP / API / GUI 三端。
- **关键选择**：检索发生在生成之前/之中，而不是生成之后校验。「完整画面查找」
  直接把一段中文描述转成整套 tag；关联推荐沿共现图补全用户想不到的细节。

### 2. ComfyUI-NewBie-LLM-Formatter（107★）——规范层 + Agent 循环
- **Agent 模式（v1.2.9）**：LLM 边生成边调 DanbooruSearch 的 MCP 实时搜标签库，
  四档努力（Close / Low / Medium / High，Medium=最多 8 轮迭代搜索）。
- **`system_prompt_anima`（约 5000 字）是四家里质量最高的 Anima 规范文本**，核心内容：
  - Hard Tags vs Natural Language 的职责分工：tag 管身份/外观/服装/动作/道具/场景锚点；
    NL 管构图、主体占比、空间关系、光照、曝光、色彩。
  - 实证行为知识：「背景 NL 过多 → 模型拉远镜头」「`full body` 只保证身体完整可见，
    不保证人物占画面大」。
  - 构图占比数字：人物主导 65–85% 画面高度 / 人景平衡 45–65% / 环境主导 25–45%。
  - **景别一致性裁剪**：`close-up` 必须删除画面外衣服/腿/鞋袜/全身姿势 tag。
  - 光照公式：主光源 → 方向 → 照亮的部位 → 背景光作用 → 暗部细节；防意外剪影。
  - 色彩主次：一个主色 + ≤2 辅助色，冷暖必须写明谁主导。
  - 多人物特征分离 11 规则（按角色分组 tag、每角色独立锚定句、互动句明确主宾）。
  - 冲突清单（open/closed mouth、spread fingers/clenched fist、solo vs 多人…）。
  - 标签预算按复杂度分档（简单 16–30 / 标准 22–38 / 复杂 30–48）+ 裁剪顺序。
  - 输出前**最终自检 11 条**。
  - 输出格式：`## Prompt`（tag 单行 + 英文 NL）+ `## 中文解释`（分点讲设计逻辑）。
- 另有 few-shot 对注入、真实画师库（`artists_anima`）、数十个画师混搭风格预设。

### 3. SD-Anima-Prompt-Studio（105★）——策展层
- 纯前端、无 LLM：12+ 人工策展 prompt 类别 + **智能互斥**（Action tag 与 NL 描述互斥、
  冲突组合自动防护）+ 质量/风格分组。价值全在「策展 + 冲突规则」。

### 4. ComfyUI-Animagine-Prompt（16★）——结构层
- 按 Animagine-XL-4.0 官方 guideline 结构化：quality/score/rating/year 分组开关、
  CSV 角色库（GENDER, CHARACTER, COPYRIGHT 三列保证角色一致性）、推荐负向、wildcard。

## 我们 vs 它们：六个差距（按影响排序）

| # | 差距 | 我们的现状 | 对照 |
|---|------|-----------|------|
| 1 | ** persona 是「保守补全器」不是「艺术指导」** | `ANIMA_PERSONA` 约 250 字、9 条结构规则、零美学知识、零示例；「只补全不重写」「不编造情节/最小化解释」直接扼杀设计感；schema 示例本身平庸（`red dress`/`standing`/`smile`，`detail_mood: ["cinematic"]` 还撞在自家空泛词表上） | NewBie 规范 ≈5000 字实战知识 + 自检 11 条 |
| 2 | **证据流反了**：generate → 事后校验 | LLM 全程看不到 catalog；`catalog_miss` 只是事后 advisory，自动替换仅限词级子集候选 | DanbooruSearch / NewBie：search → compose，边查边写 |
| 3 | **无画师层** | persona/编译器/风格库均无 @artist 概念 | 三家 Anima 相关仓库都把画师当作画风第一杠杆 |
| 4 | **无设计说明输出** | 只回 positive/negative + 机械溯源 segments/notes | NewBie `## 中文解释` 分点讲构图/光照/标签选择理由 |
| 5 | **风格库不在词表空间** | 11 个风格 × 1 行中文散文短语（「IMAX 胶片质感，Panavision C 系 35mm f4…」），Anima 方言吃不到；方言包 `few_shot_examples: []`、`style_hints: []` 全空 | NewBie styles：英文 tag + 真实画师组合 + 负向 |
| 6 | **judge 只查结构不评美学** | ANIMA_RUBRIC 五维里 aesthetics 仅「抽象词占比过高=major」 | 缺构图/曝光/色彩/叙事维度的评审判据 |

另：`MUTUAL_EXCLUSIONS` 只有 5 对（from front/behind、from above/below、pov|full body、
close-up|full body、looking at viewer|facing away），比 NewBie 冲突清单少一多半；
无景别一致性检查（close-up 时 lower-body tag 不报警）。

## 部署约束适配（不照抄的点）

- **jailbreak/破限文本不迁移**（合规风险，与我们无关）。
- **矢量检索基建暂不上**：需要 embedding 服务；现有 783MiB FTS5 catalog（1.39M 行）
  先做候选注入已够用。
- **光照词禁令是我们部署的特有约束**（camera-anima 工作流的光照由 LoRA/控件承接，
  prompt 侧 LIGHTING_BAN 全词禁用，且 narrative 一并受检）：NewBie 的「NL 写光照公式」
  必须改写为「光源写作物（neon signs/streetlamps 合法），光效词禁用，光照交给工作流控件」。
- **质量前缀不同**：Anima 用 `masterpiece, best quality, score_7`；NewBie XML 模式的
  `very_aesthetic, no_text` 是 NewBie 模型的，不搬。
- **规范文本自己写**（对方的 MIT 文本也不逐字抄：槽位结构、narrative 条件纳入、
  1200 字符预算等我们的方言契约不同）。

## 可复用规律（迁移清单）

1. **领域规范文本是第一杠杆**：模型能力够用时，产出质量差距主要来自 system prompt 里
   有没有「模型行为实证知识 + 数字化设计准则 + 输出前自检」。
2. **证据要进生成回路，不要在出口把关**：检索/候选注入发生在写之前，事后 advisory 只兜底。
3. **画师 tag 是 Anima 画风的第一杠杆**，风格预设 = 画师组合 + 词表风格 tag + 负向。
4. **设计说明是质量的一部分**：让模型为自己的选择负责（`## 中文解释`）。
5. **互斥/一致性规则是确定性代码的事**：冲突清单、景别裁剪检查放审计 gate，不靠 LLM 自觉。

## 行动清单（四期）

### A 期：规范文本 + 审计扩容（纯文本/纯代码，零基建，见效最大）
1. 重写 `ANIMA_PERSONA` → 完整 Anima authoring spec：Hard Tags/NL 分工、构图占比基准、
   光源写法（适配我们的禁令）、色彩主次、景别一致性裁剪、多人物分离规则、冲突清单、
   输出前自检。保留锚点保真原则但放开「艺术指导式补全」（checkFidelity 已兜底）。
2. 2–3 个完整 few-shot 好例（单人标准 / 复杂多人）进 persona 或
   `dialect.aesthetics.few_shot_examples`。
3. 修 `ANIMA_SCHEMA` 示例（去掉 `cinematic`，换有信息量的示范 tag）。
4. `MUTUAL_EXCLUSIONS` 扩容（solo|多人、open|closed mouth、spread legs|legs together、
   spread fingers|clenched fist…）。
5. 新增景别一致性 gate（close-up/upper body 与下装/鞋袜/全身专属 tag 同现 → important）。
6. `prompt_author` 输出增加 `design_notes`（中文设计说明，讲构图/光照/标签选择逻辑）。

### B 期：证据注入（一次额外检索，无 agent 循环）
7. authoring 前置候选召回：brief 关键名词 → `searchCatalog` → top 候选注入 persona
   （「catalog 里存在这些规范 tag 可用」）， miss 率应显著下降。
8. 画师预设：每个 `MINIMAL_STYLES` 挂真实画师 tag 候选集（人工核验存在性后入库）。

### C 期：风格库升级
9. `MINIMAL_STYLES.prompt_fragments` 改写为 danbooru 词表（英文 tag + 画师 + 负向），
   中文只留 `name` 字段；`style_hints` 接入方言包。

### D 期：judge 升级
10. `ANIMA_RUBRIC.aesthetics` 拆为构图/曝光与色彩/叙事职责三项，评委与 A 期规范同源。

## 验证方式
- A 期落地后用固定 5 条基准 brief（单人/多人/特写/场景主导/风格指定）跑
  `prompt_author` 前后对比；审计 gate 全绿 + 人工看图。
- `npx vitest run`（基线 831 passed）+ `npx tsc --noEmit` + `npm run build`（dist 铁律）。

## 实施状态（2026-09-11，A–D 全部落地）

| 项 | 内容 | 文件 |
|---|---|---|
| A1 | ANIMA_PERSONA 重写：锚定补全 + 艺术指导层（方言分工/景别一致/光源物件写法/色彩主次/多人物分离/互斥自查/自检）+ 内嵌 few-shot | `src/pe-framework/intent/subagent-provider.ts` |
| A2 | few-shot 内嵌 persona（雨夜霓虹回眸基准例，信息密度对标 NewBie） | 同上 |
| A3 | ANIMA_SCHEMA 示例去 `cinematic`，换高信息量示范；新增 artist 槽 | 同上 |
| A4 | MUTUAL_EXCLUSIONS 5 对 → 12 对（solo×人数、open/closed mouth、spread legs/legs together、spread fingers/clenched hand） | `src/pe-framework/dialect/anima.ts` |
| A5 | 新 gate `framing_tag_mismatch`（close-up/upper body/cowboy shot × 取景外服饰 tag）；close-up\|full body 互斥让位给本 gate | 同上 |
| A6 | `design_notes` 设计说明投影（segments → 槽位中文汇总/narrative 职责/锚定率，零 LLM，observability 透传） | `src/tools/prompt-author.ts` + `render/envelope.ts` |
| A7 | 艺术指导卡片 ↔ LIGHTING_BAN 一致性修复：8 张光影卡 + 3 张其他卡片的禁词 tag 全部改为合规词汇；一致性测试钉死不变式 | `enrich/art-direction.ts` + 测试 |
| B7 | catalog 候选召回注入：`catalogCandidatesForText`（3/2/1-gram + 词位覆盖吞并 + exact-only + @画师跳过）→ intent req → persona 候选块 + `catalog_recall_injected` advisory | `dialect/catalog-recall.ts` + `tools/prompt-author.ts` + `intent/subagent-provider.ts` |
| B8 | artist 槽全链路：SLOT_ORDER（count→character→artist）+ AnimaSlots + 校验白名单 + StyleRef.artist_hints + projectToAnima 映射 + persona 画师菜单（13 位 catalog 验证画师） | `pe-framework/anima.ts`、`dialect/anima.ts`、`blueprint/schema.ts`、`blueprint/project.ts` |
| C9 | MINIMAL_STYLES 词表化：11 风格 fragments 中文散文 → danbooru 英文短语；negative_hints 英文化；proportionalFragment 中英文逗号兼容 | `enrichment/style.ts` |
| D10 | ANIMA_RUBRIC 5 维 → 7 维：composition / lighting-color / aesthetic-vocabulary（与 A1 规范同源）；judge mock 同步 | `eval/rubrics/anima.ts` + e2e mocks |

新增测试：`anima-external-benchmark.test.ts`（A4/A5/B8）、`art-direction-ban.test.ts`（A7）、
`catalog-recall.test.ts`（B7）、`author-design-notes.test.ts`（A6）；更新：style/project/framework-types/
author-judge.e2e/author-enrich.e2e（mock 维度分对齐 7 维）。

### 画师清单（catalog 验证，2026-09-11，category=artist）
kantoku(2591) / as109(1988) / mika pikazo(1071) / hong (white spider)(1031) / satou kibi(850) /
atdan(796) / guweiz(705) / ask (askzy)(533) / rella(482) / wlop(397) / quasarcake(362) /
ciloranko(239) / gozz(191)。存裸名，grounding 命中后经 prompt_form 升级 `@形` 输出。
