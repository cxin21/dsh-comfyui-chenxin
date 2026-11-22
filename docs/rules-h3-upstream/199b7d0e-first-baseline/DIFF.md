# DIFF — 199b7d0e 首版基线对照（2026-11-22）

| | |
| --- | --- |
| **官方锚点** | [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3) main HEAD commit `199b7d0e1fd95e7b3eafa8c15eca692534142427`（2026-10-28） |
| **官方版本号** | 无 release、无 tag（官方仓 API 均返回空数组）——目录名以 commit 短哈希 `199b7d0e` 为版本锚 |
| **快照** | [../_snapshot/2026-11-22-first-baseline/](../_snapshot/2026-11-22-first-baseline/SOURCE.md)（4 文件 verbatim，上游 blob SHA 逐一校验一致） |
| **对照范围** | 本仓审计规则 `plugins/prompt-forge/src/pe-framework/audit/rules-h3.ts` + `auditH3Full` 语义闸门 vs 官方 skill 三份文本（SKILL.md / references/base-en.txt / references/ref-en.txt） |

**裁决原则**（父票 #19 维护者裁决，2026-10-13）：prompt 形态规则官方为准；工程约束（budget 门、审计接线、envelope 形状）本仓为准；采纳新规则一律新文件进 `rules-h3` 并注册，现有文件零改动。

**本版结论：零新规则采纳。** 现有规则与官方 199b7d0e 基线无实质冲突；已识别的差距项共 5 条，全部登记为 §8 语义层候选（当前由 `auditH3Full` 的 `shot_execution` 语义闸门覆盖或暂缓），无一需要新增确定性 gate。

---

## 1. 输入模式与结构

| 官方条款 | 本仓现状 | 采纳裁决 |
| --- | --- | --- |
| 五种输入模式 T2VA / I2VA / FL2VA / L2VA / Ref2VA（SKILL.md frontmatter + §Base Modes + §Full-Reference Mode） | `contractGatesH3(stage, …)` 按 stage 分支：`ref2va` / `t2va` / `i2va` `fl2va` `l2va`（keyframe 桶）各有独立闸门 | 已对齐，无动作 |
| Ref2VA 六节固定顺序 subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music（ref-en.txt §1） | `auditH3Full` 的 `field_order` gate 校验六段式顺序与内容（prompt-audit.ts 兜底引导同文案） | 已对齐，无动作 |
| 三个核心字段 `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`（SKILL.md frontmatter；base-en.txt §2.2） | 审计规则映射表 `ruleForMessage` 的 `soundscape_dialogue` 条目覆盖两声音字段；`field_order` 覆盖整体结构 | 已对齐，无动作 |
| 用户约束（constraints）不可违反（SKILL.md §Output Rules "禁止情节摘要"等输出纪律） | `constraints_block` gate（ruleForMessage 首位特异映射） | 已对齐，无动作 |

## 2. 时间线与镜头

| 官方条款 | 本仓现状 | 采纳裁决 |
| --- | --- | --- |
| 描述总时长须匹配请求视频时长，**4–15 秒**（SKILL.md §Tips 第 1 条） | `contractGatesH3` parse_request gate：`!(4 <= d && d <= 15)` → critical | 已对齐，无动作 |
| `[Shot 1]` 不带时间戳；后续 `[Shot N] At MM:SS.mmm`，切点**严格递增**且落在时长内（base-en.txt §4.2） | `cut_timestamps` gate（ruleForMessage 映射 auditH3 检查器的 sequential / timestamp / MM:SS 消息） | 已对齐，无动作 |
| 切换动词白名单：`the camera cuts to` 等 5 个普通动词；cross-dissolve / fade / wipe 仅用户明示时可用；切镜须带来新信息（base-en.txt §4.2） | 无确定性 gate；`auditH3Full` 的 `shot_execution` 语义闸门（important 分层）在语义层评审切镜合理性 | 官方条款适用，但确定性 gate 误报风险高（自由英文表述变体多）；**记为语义层覆盖，暂不采纳**（§8 候选 1） |
| per-shot duration 显式契约（全部显式或全部缺省；显式时 Σ=duration_seconds；单镜 ≥0.4s） | `shot_duration_mixed` / `shot_duration_sum` / `shot_duration_short`(minor) 三个 gate | **官方无此条款**——本仓工程增强（分镜规划与预算需要确定性 per-shot 结构）；工程约束本仓为准 |
| 官方镜头数无显式上限公式（范例中 4–15s 内 1–3 镜） | `max_shots` gate：cap = `1 + floor((d-1)/3)`（4s→2 镜，15s→5 镜） | **官方无此公式**——本仓工程约束（防超载分镜），本仓为准；与官方范例密度不冲突 |

## 3. 运镜与画面表达

| 官方条款 | 本仓现状 | 采纳裁决 |
| --- | --- | --- |
| 运镜三维表达：12 种 motion type × 幅度（small/large）× 速度（slow/fast），写成镜头内自然英文动作句（base-en.txt §4.3） | 无确定性 gate；`shot_execution` 语义闸门评审运镜表述 | 同候选 1 逻辑：句式变体多、确定性校验误报率高；**语义层覆盖，暂不采纳**（§8 候选 2） |
| 画面内文字（横幅/招牌/字幕）用英文双引号包裹、原文逐字保留（base-en.txt §4.5） | 无独立 gate；`dialogue_markup` / `label_resolution` 仅覆盖对白与引用标签 | （§8 候选 3）：低频场景、可由 `shot_execution` 语义评审兜底；**暂不采纳，观察后续官方更新是否强化** |

## 4. 说话人、对白与声音

| 官方条款 | 本仓现状 | 采纳裁决 |
| --- | --- | --- |
| 对齐指令必须为首行 + 固定英文句式（base-en.txt §2.1） | `alignment_preamble` gate（ruleForMessage 映射 preamble / alignment 消息） | 已对齐，无动作 |
| 发声主体稳定 ID `(S1)/(S2)`、复合 ID `(S1,S2)`、跨镜头不变；首次出现须给足身份信息（base-en.txt §4.4） | `dialogue_markup` gate（ruleForMessage 映射 dialogue 消息；含 ID 与身份要求） | 已对齐，无动作 |
| `<d>[Language] …</d>` 内只有语言 tag 与用户原文，逐字保留不翻译；画外音固定短语；`<scenetrans>` / `<cutoff>`（base-en.txt §4.4；ref-en.txt §5.4 `[unclear]` 与标点规范化） | `dialogue_markup` gate 覆盖 `<d>` 标记与语言 tag；逐字保留与 `[unclear]` 属语义层 | 已对齐（`dialogue_markup` + 语义层）；`[unclear]` / 标点规范化不单独立 gate |
| `overall_soundscape` 1–4 句、只写环境音/动作音/非语言人声；`non_diegetic_music` 1–3 句、禁抽象情绪词（base-en.txt §4.6–4.7） | `soundscape_dialogue` gate = `auditSoundMusicSeparation`（rules-h3.ts:161）：校验**内容隔离**——soundscape 不得含 `<d>`、不得出现 non-diegetic / background music 字样；music 不得含 `<d>`。**句数上限（1–4 / 1–3）与"禁抽象情绪词"无确定性 gate** | 内容隔离已对齐；句数与抽象情绪词**未覆盖**——句数可机器化但官方表述是"1–4 句连续段落"，英文句切分歧义（缩写/引号/冒号）误报风险实在，抽象情绪词属语义判断。二者交由 `shot_execution` 语义闸门覆盖，**本版不采纳**（§8 候选 5） |

## 5. 引用标签（Ref 模式）

| 官方条款 | 本仓现状 | 采纳裁决 |
| --- | --- | --- |
| 四类引用标签 `<Subject N>` / `<Picture N>` / `<Video N>` / `<Audio N>`，一经分配跨节含义不变（ref-en.txt §2） | `label_resolution` gate（ruleForMessage 映射 reference / Subject / Picture 消息，未消解标签报错） | 已对齐，无动作 |
| retention 四种可见标记（fully_preserved / partially_preserved / attribute_transfer / weak_reference）+ 四种音频标记（fully_copy / partially_copy / reference / weak_reference），且只能在 subject_definitions 已定义角色内选（ref-en.txt §4） | 无确定性枚举 gate；`retention_analysis` 节的结构存在性由 `field_order` 覆盖，标记枚举正确性由 `auditH3Full` 语义评审 | 官方条款；枚举可机器化（值为固定 8 个字符串），但先要确认生产输入中标记错误的真实频率，避免为罕见路径加闸门；**本版暂不采纳**（§8 候选 4） |
| Ref2VA 引用数与组合（官方无硬性数量公式；标签体系支持多资产合成） | `ref_count` gate：ref2va 须 1 或 3、t2va 0、keyframe 1–2 | **官方无此公式**——本仓工程约束（对应多视图工作流的资产拼装形态），本仓为准 |

## 6. 工程约束（本仓特有，官方不涉及）

| 本仓条款 | 裁决 |
| --- | --- |
| budget 门：`buildH3Budget(stage, text, refs)` → envelope `budget` 报告 | 工程约束，本仓为准 |
| audit envelope 形状：gates + budget + `ok = 无 critical` 序列化 | 工程约束，本仓为准 |
| `prompt_audit` 对裸文本/非六段内容的引导降级（不 throw，返回引导 gate 指向 prompt_author / prompt_compile） | 工程约束，本仓为准 |

## 7. 机制修正记录（裁决前提变更）

维护者裁决第②问原为"订阅官方 releases"。本次基线核实：**官方仓 0 release、0 tag**（2026-11-22 API 实测），演进只体现在 main 分支 commit（skill 内容最后变动 2026-08-15，PR #44）。修正：

- **版本锚** = main HEAD 的 skill 子树内容哈希（本快照以 commit `199b7d0e` 记录锚点）；
- **触发** = `scripts/check_h3_upstream.py` 内容哈希对比（天然覆盖 commit 演进，不依赖 release 机制）+ 半年巡检兜底；
- 裁决实质（官方更新即对照、半年兜底）不变，仅载体描述修正。README.md 同步更新。

---

## 8. 未采纳候选清单（语义层覆盖，留待后续版本评估）

本版 5 条差距项全部**未**转为确定性 gate。共同判断依据：官方条款是**自然语言写作指导**，同一语义有大量合法英文表述变体（语序、同义动词、复合句）；确定性正则校验在这种自由度上误报率高于收益，而现有 `auditH3Full` 的 `shot_execution` 语义闸门（LLM 评审，`important` 分层）已能覆盖判据本身。**"不采纳"不等于"不管"**——语义层仍在管，只是不走硬闸门。

| # | 官方条款 | 为何不做确定性 gate | 若要落地的前置条件 |
| --- | --- | --- | --- |
| 1 | 切换动词白名单（base-en.txt §4.2） | 白名单本身有限（5 个普通动词 + 3 个特效用明示触发），但"切镜是否带来新信息"是语义判断，无法正则化；只校验动词白名单会漏掉核心意图 | 先积累 feedback 数据，确认"非白名单动词"在真实输入里的占比与误报率 |
| 2 | 运镜三维表达：12 motion type × 幅度 × 速度（§4.3） | 组维度可枚举，但官方要求"写成镜头内自然英文动作句而非句尾标签堆叠"——同一个运镜可用运镜名、也可用 `the camera slowly pushes in` 等纯动作描述，正则无法判定等价 | 需要运镜表述的规范化词表 + 真实样本分布统计 |
| 3 | 画面内文字用英文双引号包裹（§4.5） | 低频场景；双引号在 H3 文本里还承担其他用途（引用台词、标注标题），全局校验会误伤 | 需要"画内文字出现位置"的可靠标记约定 |
| 4 | retention 八种固定标记枚举（ref-en.txt §4） | **这是唯一可干净机器化的候选项**（值为固定 8 个字符串，无歧义）；暂缓理由不是技术，而是需要先确认生产输入里标记写错的真实频率，避免为罕见路径加闸门 | feedback 数据显示该错误出现 ≥ 阈值，即可新文件进 `rules-h3` 并注册 |
| 5 | soundscape 1–4 句 / music 1–3 句 + 禁抽象情绪词（§4.6–4.7） | 句数上限看似可数，但英文句切分在缩写（`Mr.`）、引号、冒号列表处有真实歧义；"抽象情绪词"是语义判断 | 句数部分若确需硬约束，须先定英文句切分口径并接受已知误报面；情绪词部分不做 |

**下版本复核方式**：本表随官方新条款一起重审；若 `prompt_feedback` 的数据（`data/runtime/feedback.sqlite`）能支撑候选 4 的真实错误率，则优先落地候选 4。
