# 扩写层 + 默认质量评审 + 语言归一化 设计

> 2026-09-08 · prompt-master 插件 · 质量飞轮之后的第二期增强
> 决策（用户确认）：enrich 自由发挥模式；语言归一化不加翻译轮；enrich 默认开；judge 默认 fast。
> 上游：质量飞轮已合入（711 基线，HEAD d1fbac8）。

## 1. 目标

1. `judge_mode` 默认从 `'off'` 改为 `'fast'`——质量评审默认启用
2. 生成前增加 `enrich` 扩写阶段：把一句话意图富化为七维度结构化创作 brief
3. 语言归一化：中文等输入直接产目标语言结构（Anima 锁英文；H3 跟随用户），不做独立翻译轮，角色名词锚定

非目标：不做翻译审稿轮；不做 creative 参数化档位（自由发挥即唯一档，YAGNI）；不动 compile/audit 确定性路径；不加新方言。

## 2. enrich 阶段设计

### 2.1 管线位置

```
用户输入（任意语言）
  → 【新】enrich（LLM，subagent 路线，输出 JSON schema 强约束）
  → intent 拆解（现有；input 从生句子变为 brief）
  → 编译 → 审计 → 评审（现有，零改动）
```

enrich 失败/超时/schema 不合 → 降级：跳过 enrich，intent 直接吃原始输入（advisory `enrich_skipped`），**永不阻塞**（对齐质量飞轮 §2.5 纪律）。

### 2.2 brief 结构（七维度，JSON schema）

```ts
interface EnrichedBrief {
  outputLang: 'en' | 'zh' | 'ja'          // Anima 强制 'en'；H3 跟随用户或显式指定
  subject:     { text: string; source: 'user' | 'enriched' }[]   // 主体/外观/服饰/表情/动作
  scene:       { text: string; source: ... }[]                   // 环境/地点/时间/天气
  composition: { text: string; source: ... }[]                   // 景别/视角/机位或运镜
  lighting:    { text: string; source: ... }[]
  color:       { text: string; source: ... }[]
  style:       { text: string; source: ... }[]                   // 媒介/画风/质感
  mood:        { text: string; source: ... }[]
  nameAnchors: { original: string; anchored: string }[]          // 角色名词锚定（见 §4）
}
```

每个字段带 `source`：`user`（用户显式指定，硬约束）| `enriched`（自由发挥补全）。全部字段进 Envelope 顶层 `enrichment` 段，可追溯可复盘（「这是我说的还是它编的」一查便知）。

### 2.3 自由发挥的边界

- **唯一硬约束**：不与用户显式指定冲突；`source='user'` 的字段 intent 阶段必须原样保留
- 扩写可自由新增元素/风格/氛围设定，无数量限制
- **Anima 证据边界**（模型适配非创作限制）：style/mood 词优先落 catalog 有证据的 canonical 英文 tag；enrich 输出后由现有 catalog 闸门与评审自然拦截无证据词（不在 enrich 内做查询，保持一次 LLM 的简洁）
- H3：不新增镜头数（时长公式决定），只填充每镜头内容量；风格词同样受方言约束
- enrich persona 按 target 区分：anima 富化画面词与视觉细节；h3 富化分镜内容与节奏感

### 2.4 参数与默认

- `enrich?: boolean`，**默认 `true`**
- audit_only=true 时跳过 enrich（读路径）
- enrich 计一次 LLM 调用；与 judge fast 叠加后一次 author 典型 = intent + enrich + judge = 3 次调用（fast pass 情形）

## 3. judge 默认 fast

- `prompt-author.ts` 默认值 `'off'` → `'fast'`；`enrich` 默认 `true`
- 受影响测试：所有断言「缺省 judge=undefined / provider 零调用」的用例改为显式传 `judge_mode:'off'`（语义不变的测试），新增「缺省=fast」断言
- AGENTS.md / troubleshooting 同步：默认评审、每次 author 典型 3 次 LLM 调用、如何关

## 4. 语言归一化（不加翻译轮）

- enrich/intent 输出 schema 显式 `outputLang`；Anima 方言锁 `en`（danbooru 体系），H3 跟随用户输入语言或显式指定
- **术语锚定**：风格/要素词取 catalog canonical 英文形式；用户角色名在 enrich 阶段固定英文映射（`nameAnchors`），brief 全程携带，intent 不得改名——该锚点直接喂给 h3 rubric 的 cross-shot-consistency 维度
- 不产出独立英文 brief 供审稿；brief 是中间产物（envelope 的 enrichment 段可事后查看）

## 5. 文件清单

新增：
```
src/pe-framework/enrich/brief.ts          EnrichedBrief schema + 校验
src/pe-framework/enrich/engine.ts         enrich 意图执行（persona/schema 组装 + subagent 调用 + 降级）
src/pe-framework/enrich/personas.ts       anima/h3 两套 persona
tests/pe-framework/enrich/…               单测（mock provider：七维度、source 标记、降级、outputLang 锁定、nameAnchors）
tests/plugin/author-enrich.e2e.test.ts    author 接线 e2e（默认开、audit_only 跳过、降级不阻塞）
```

修改：
```
src/tools/prompt-author.ts                enrich 接线（intent 输入从原文变 brief 文本）、judge/enrich 默认值
src/pe-framework/intent/subagent-provider.ts   persona 注入扩展（若现有机制不够）
docs/2026-09-08-*.md、preset AGENTS.md / troubleshooting   文档同步
```

## 6. 降级汇总

| 故障 | 行为 |
|---|---|
| enrich LLM 不可用/超时/schema 不合 | 跳过 enrich，intent 吃原始输入，advisory `enrich_skipped`，出稿照常 |
| 用户输入与 enrich 冲突 | intent 以 `source='user'` 为准，advisory 标注被覆盖的 enriched 字段 |
| judge 写失败/评审故障 | 沿用质量飞轮 §6 既有降级 |

## 7. 测试策略

- brief schema 校验单测（七维度、source 枚举、outputLang 锁定）
- enrich 引擎单测（mock provider：正常/降级/nameAnchors 传递）
- author e2e：缺省=fast+enrich 双开的行为、显式 off 的回退、audit_only 跳过两者
- golden 零破坏（enrich 在意图层，不进确定性编译路径）
- 现有 711 基线：所有假设缺省 off/无 enrich 的用例改为显式参数（语义保持）

## 8. 交付

单一里程碑 M-E1（一个实施计划可承载）：schema → 引擎 → author 接线 → 默认值切换 → 文档同步。验收：vitest 全绿 + 缺省行为=fast+enrich 实测 + golden 零破坏。

## 9. 自审记录

- 占位符：无 TBD。
- 一致性：enrich 降级与 §6 表一致；「自由发挥 + user 硬约束」边界在 §2.3 单点定义，§4 术语锚定不与其冲突（锚定是术语映射不是创作约束）。
- 范围：单计划可承载。
- 歧义：outputLang 的 H3「跟随用户语言」明确为 detectLanguage（h3.ts 已有该函数）+ 显式指定优先；「典型 3 次调用」仅指 fast-pass 情形，修正轮会更多（已知，终审 M4 已记录）。

---

## 10. 增补：一期审计待实现项全量纳入（用户指令：完整实现）

> 2026-09-08 独立审计（~90% 完整）的 P0-P3 遗留全部纳入本期范围。
> 审计误报更正：evalset 目录（assets/knowledge/{anima,minimax-h3-prompt}/evalset/）实际已存在（T9 建），无需实现。

### 10.1 P0 语义纠偏

**A1 证据回查复核**（§2.1 证据铁律的闭环）：critic 在 parse 得到 findings 后，对每条含 evidence 的 finding 调 `bridge.query(tool, query)` 回查：查询失败（ok=false）→ 丢弃该 finding；查询成功但 result 摘要与声称 result 的关键词完全无交集 → 标 `evidenceUnverified` 并丢弃（blocker/major 不得基于未验证证据打回）。回查本身失败（bridge 整体不可用）→ 保留 findings + advisory `evidence_unverified`，不阻塞。bridge 未传（off 评审的旧调用方）→ 跳过回查（向后兼容）。

**A2 strict 复审独立 schema**：revision 轮不再复用全量评审 schema。独立输出契约：`{ verdict: 'pass'|'needs_revision', closedFindingIds: string[], unresolved: string[], rebuttalVerdicts: [{finding_id, accepted: boolean, reason}] }`。score 沿用首轮（复审不改分）；verdict=pass 条件 = 全部 blocker/major 关闭或反驳被接受。首评审的 score 进 debate round2.reviewer.score 透传。

### 10.2 P1 缩水补齐

**A3 praise 锚点**：`makeRevisionProvider` 与 revision 轮 prompt 注入首轮 praise（「以下优点须保留：…」）。
**A4 rebuttal 生产**：`makeRevisionProvider` v2——输出结构化 `{ changes, rebuttals: [{finding_id, rebuttal, evidence}], revisionNote }`；对不成立的 finding 给带证据反驳，其余照改。parseRebuttals 从「revisionNote 内嵌 JSON」降级为直接消费结构化字段（内嵌 JSON 解析保留为兜底）。
**A5 evidence_partial 白名单**：`DialectRubricDimension` 增可选 `evidenceOptional?: boolean`。critic 的证据铁律对该类维度放行无证据 findings（标注 `evidenceAssumed: true`）；bridge 缺工具时所有含该工具的维度自动视为 evidenceOptional。
**A6 rubric weight 参与评分**：critic 输出 schema 升级为 `dimensionScores: Record<dimId, 0-100>`（必填），`score = Σ weight×dimScore`（四舍五入）；LLM 只产维度分，总分由代码加权计算（权重真正生效）。单数字 score 字段废弃（schema 不再接受，防御归一逻辑作用在加权后的 score 上）。
**A7 负反馈词表常量**：`feedback/vocab.ts` 导出 `FEEDBACK_TAG_VOCAB: Record<'anima'|'h3', readonly string[]>`（anima：构图/肢体/风格偏差/颜色/细节崩坏/与描述不符…；h3：角色不一致/镜头冗余/节奏/运镜/穿帮/与描述不符…）；prompt_feedback record 时 tags 不在词表 → 接受但附 advisory `tag_not_in_vocab`（不强制）。
**A8 h3 shot-structure 指令补 cut 时间戳抽查**（评委抽查项；确定性审计已有，属评委复核）。

### 10.3 P2 补齐

**A9 迭代 loop 驱动器**：`scripts/optimize-loop.mjs`（node 直跑 dist，CLI 级不注册工具）——参数 target/persona 文件/n 评测条数；串 loadEvalset → proposeMutation → evaluateCandidate（runWith 真装配：调 author 内部管线 mock judge 或真 judge，可配）→ renderMarkdown 落盘报告。人审闸门不变：只产报告。
**A10 评委校准视图**：`statsFeedback` 增 `alignment` 字段：{ pairs: number, avgJudge: number, avgHuman: number, pearson: number|null }（pearson 样本 <5 为 null）；prompt_feedback stats action 透出。
**A11 （evalset 目录已存在，审计误报，无需实现）**

### 10.4 P3 工程卫生

**A12** `prompt-author.ts` 增 `judgeRepair?: boolean`（默认 true=现状每修正轮重评；false=修正轮跳过评审，省成本）。
**A13** `makeRevisionProvider` 稿内编辑：输入 compiled 结构，按 findings 做字段级 patch（定位 slot/shot 字段），失败时回退整稿重拆（现行为）。delegate 到修复轮内部实现，接口不变。
**A14** feedback.sqlite 迁 `data/runtime/feedback.sqlite`：首次使用时若旧路径存在则迁移（move）旧文件；AGENTS.md 落点更新。
**A15** `listFeedback`/`listGenerations` 增 `limit` 参数（默认维持现值），harness 传大值。
**A16** store.ts 导出 `rowToFeedback`，prompt-feedback 工具层复用，删重复映射。
**A17** prompt-feedback internal_error 路径补测试（坏 dbPath 注入）；测试 mkdtempSync 统一 afterEach 清理。

### 10.5 增补自审

- A1 回查的「关键词交集」判定：result 与 claimed result 各取实词集合，交集非空即通过——宽松但防纯编造；严格语义比对留给 A10 校准数据积累后。
- A2 复审 schema 的 closedFindingIds 依赖 finding 标识 → CriticFinding 增 `id`（`f1`/`f2`…首轮内稳定编号，同时修复终审 M3 的 harness findingsMustClose 悬空引用）。
- A6 与 A5 交互：dimensionScores 对 evidenceOptional 维度照常打分，不受铁律影响（铁律只管 findings 证据，不管打分）。
- A13 为最小稿内编辑：patch 失败回退重拆，保证不劣化现状。
- 顺序依赖：A2/A6 改 critic schema → A3/A4 依赖 A2 的 finding id → enrich 层（§2-§4）独立可并行 → 默认值切换最后（依赖 enrich 与 critic 稳定）。
- 勘误（终审 I-1）：A5 的「bridge 缺工具→维度自动 evidenceOptional」实现为方言级放宽（evidenceTools 无维度映射，维度级不可实现），finding 级 tool 保护收窄爆炸半径；A4 的 parseRebuttals 内嵌 JSON 兜底已随结构化直通整体移除（ledger 一期裁定可接受）。

## 11. 二审补遗（用户质询后深审，4 处缺口裁定）

1. **「逐项否决」不做独立 API**（讨论中提过、设计曾遗漏）：否决路径 = envelope `enrichment` 段追溯定位 + 用户下一次输入自然语言排除（intent 的 `source='user'` 硬约束天然支持「不要 X」）。理由：单用户场景 API 化是过度设计；代价：否决要多一轮对话。
2. **brief 大小硬上限**：schema 校验每维度 ≤6 条、单条 ≤200 字符；超限 → enrich 整体 skipped 降级（**不静默截断**——截断可能丢 user 来源字段）。理由：H3 prompt 上限 7000 字符，brief 必须有界。
3. **GenerationRow 增 `enrich: 0|1` 列**：author 落库时写入（store schema 加列，旧库 ALTER 兼容）。理由：不记则 A3 评测语料无法区分有无扩写，会被污染。
4. **nameAnchors 不单独传给 critic**：锚定经 enrich→intent 已固化进 compiled（角色名即锚定后英文名），critic 评 compiled 自然可见。无需新参数。
