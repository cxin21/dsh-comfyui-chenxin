# H3 参照项目深度分析 v2（文件级两轮精读）与 spec 增量

- 日期：2026-09-17（v2：三库整库克隆后第二轮全量精读）
- 方法：三库 `git clone --depth 1` 本地化，逐文件精读。第一轮 9 份 + 第二轮 10 份 = **19 份文档/脚本级证据**（详见各节证据范围；未读文件均标注理由）。
- 关联 spec：`docs/specs/2026-09-17-h3-agentic-directing-pipeline-design.md`（v2）——本文件 §D 提出增量吸收（N1-N12）。

---

## A. minimax-h3-director-suite（6 份核心文档全读）

证据：SKILL.md、references/wenwu-director.md、references/storyboard-schema.md、references/workflow-routing.md、runner/references/director-schema-v2.md、runner/references/director-playbook.md。（未读：setup-guide/api-and-mcp/autodl/cloudflared/resource-monitoring/hybrid-example——执行向，D-U3 范围外；scripts/*——执行脚本。）

### A1 SKILL.md —— 流水线全貌与三模式

- **三提示词模式**：`official`（H3 官方六段式英文：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）/ `wenwu`（中文导演分镜）/ **`hybrid`（推荐：官方六段式外壳 + WenWu 导演级内容）**；`meta.prompt_mode` + `prompt_mode_reason` **强制写入 storyboard.json，禁止静默走默认**
- **人物四视图**：每主要角色 front/side/back/face 四图锁定同一身份；网上已有角色先搜下载再生成四视图；`refs/<角色名>_*.png` 登记进 characters
- **段结构**：段 = 一个 H3 视频单元（默认 10s，5-15s），段内 2-3 分镜；上下镜至少传递一个衔接锚点（动作方向/视线/光线/道具/轮廓/声桥/受力），禁止无理由跳切；**每段独立生成，禁止引用上一段尾帧（衔接靠文字锚点）**
- **分镜汇报强制精确时间轴**（"几秒到几秒→画面→对白"表格，时间连续无空洞无重叠；用户只改个别镜头只重报受影响段）
- 失败恢复：连续 3 次无变化停下报告；单段重试失败不静默跳过

### A2 wenwu-director.md —— ★导演级内容引擎（S2/S3 persona 的规则源）

- **三生命迹象**：注意力在流动 / 动作有前因后果 / 镜头有观看动机
- **叙事温度判别 + 镜头密度公式**：高动态（0.4-1.5s/镜，`round(T/1.0)`）/ 细腻文戏（2-4s/镜，`round(T/3.0)`）/ 混合（1.5-3s/镜，`round(T/2.0)`）；仅当用户未指定镜头结构时启用
- **创作者指令优先级**：用户硬约束（一镜到底/镜头数/分镜顺序）精确遵守 > 自动导演
- **生命核**：人物身份/材质/状态 + 跨镜持续要素 + 开始/转折/最终三态——只写影响成片的细节
- **镜头脉冲七段式**：`观察理由 → 画面入口 → 新信息 → 主体变化 → 摄影机响应 → 结果落点 → 下一脉冲牵拉物`
- **表演肌理链**：`刺激抵达 → 本能反应刚要出现 → 主动压住 → 保护层失效 → 身体泄露 → 选择 → 余波`；先身体变化后情绪结论；禁止同瞬间堆叠多表情
- **八条生命通道**：形（身份材质）/ 场（空间关系）/ 视（摄影机注意力：远答何处/中答身体/近答控制/特写只服务决定性证据）/ 力（动作因果：准备-发力-接触-受力-恢复）/ 念（未说出口的目的→停顿眼神呼吸）/ 息（情绪=压力穿透保护层的过程，呼吸先于台词）/ 言（台词三阶段：开口前-说话时-说完后；双引号只装口语）/ 续（跨镜锚点传递）
- **FACS AU 面部微调**：AU1-26 强度 A-E 分级（日常 A-C、D 峰值、E 罕用）；AU 组合须同一心理原因，与自然动作冲突时删 AU
- **四种生镜形态**：关系燃烧 / 动力对抗 / 九态视觉谱（九状态格）/ 精准改造
- **素材契约**：H3 实际标签 `<Picture N>/<Video N>/<Audio 1>`；每素材分配职责；不能从未取听音频编造台词
- **生镜校验 17 项**（交付前自检，不输出过程）

### A3 storyboard-schema.md —— 数据规范全集

- **官方六段式结构**（模式 A）：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music——顺序固定、英文书写、镜头间写衔接锚点、`<d>[Chinese]...</d>` 装原生对白、无 BGM 写 N/A
- **hybrid 映射表**（WenWu 概念 → 六段落位）：生命核→subject_definitions；最终发展线→summary；八通道核对→retention_analysis（fully_preserved/partially_preserved/attribute_transfer/weak_reference）；镜头脉冲→detailed_description（起止时间+景别机位+唯一事件+主体变化+摄影机回应+交镜锚点）；声音脉络→overall_soundscape；视觉母题/风格禁令→结尾 `constraints:` 块
- **7 列镜头卡**：no/time/duration/shot_size/camera/content(≤30字)/sound(必填，静默也写)/transition(默认硬切)/technique/tags(≤2，枚举：海报帧/伏笔/关键/重特效/长镜/音锚/特设备)；镜号连续；**时长累加 = 段长**
- **景别 7 档中文强制**（禁 ECU/CU 缩写）+ 速查（情感顶点→极端特写；对白→中近景；动作→中远景交替；建立→全景/远景）；**机位库 11**、**运镜库 15**（速度修饰：慢推/急摇接切/Flash Cut）、**转场库 14**、**高级技法 8**
- **视听签名 8 字段**（hybrid 建议）：medium/aspect/color_ids(≤6，每角色一色相)/texture/core_theme(必须可拍：主语+比喻动词+宾语)/master_dna(≤3)/genre_formula(opening/turn/climax/ending)
- **单元结构**：unit/dramatic_task(25-60字)/visual_motif(3-6字，来自签名)/hook；相邻单元至少 1 种对比；高潮单元位于全片 60-80%；首末单元意象 echo
- **声音 12-slot**（固定顺序不许跳号）：开场基底/第一个高频锚点/仪式启动音/第一次撞击/中频群/关键V.O./第一次静默/静默回归/主题动作音/高潮余震/全片唯一/结尾尾音；overall_soundscape 按低/中/高频+人声四层
- **ASL 节奏统计**：段 ASL 偏离全片均值 >50% 诊断；σ<0.3 过平、>1.5 过抖；高潮前呼吸段 ≥2× 均值
- **world_anchors 5 slot**（origin/equipment/energy/rule/support，每条带出处）；characters 可选字段（function/visible_shots/dialogue_count/gender_age；反派 size/color_id/sound_signature/drive/appearances）
- **后端校验清单**：段时长累加偏差 ≤5%、climax 60-80%、签名 color ≤6/dna ≤3、sound_events ≤12、镜头卡 7 列齐全镜号连续、ASL 诊断、world_anchors 齐全、visible_shots 引用、reference_films ≤6——**默认警告；meta.strict_prompt_validation=true 直接拒绝**
- **分镜汇报格式**：强制时间轴表格（连续/精确到秒/无空洞无重叠）

### A4 workflow-routing / director-schema-v2 / director-playbook（第一轮已析，要点保留）

路由优先级链与按 class_type 参数覆盖；creative_intent 四件套 + shot_intents 严格相等 + continuity_handoff 四通道 + reference roles 六类绑定 Subject/Picture/Video/Audio N（schema-only 角色 runner 不支持 → 编译拒绝）；shot purpose 六标签强制开头 + 时长 taxonomy；双锚点；Ref2VA 末态泄漏 → FL2VA endpoint delta；QC 八维矩阵；两次同类失败改结构。

## B. leos 六部门（7 份精读 + 10 份目录级）

证据：SKILL.md、prompt-director.md、video-prompt-template.txt、output-contracts.md、review-and-repair.md、generation-control.md、scripts/validate_prompt_text.py。（未读：role-council/directing-grammar/performance-direction/cinematography-direction/spatial-and-assets/continuity-and-learning/knowledge-and-provenance——S2-S4 persona 实施期的**内容源资料**，已列入实施计划必读；validate_review_coverage.py——单审计 LLM 架构不需要覆盖矩阵校验；4 个 CSV 模板——台账字段样例。）

### B1 SKILL.md（第一轮已析）+ B2 prompt-director.md / output-contracts.md（本轮深挖）

- **输出契约模板集**（output-contracts）：六角色联合会诊表 / 场次导演拆解（戏剧节拍表、Blocking states 表、空间可行性、尺度契约、主观视点与轴线、道具/动作状态机、镜头覆盖、控制强度、待核验项）/ 导演生成方案 / 表演指导工作单（逐 Beat 表演谱：刺激|可演动作|注意对象|目光呼吸|台词动作|反应延迟|退出状态|禁用套路）/ 摄影指导工作单（承托/运镜路径/触发/速度曲线/光源动机/明暗比/色温/相邻接缝）
- **联合会诊结构**：总导演总判断 → 已知事实/导演推断/待核验三分 → 各岗位独立小结 → 生成门状态 → 逐镜审稿表（角色×镜头笛卡尔全覆盖，没问题也写"通过"）→ 裁决与验收条件
- **validate_prompt_text.py 机检谓词**（可移植）：最终产物禁 JSON；有效字符（非空白）≤5000；全局必备字段（空间布局/对白规则/环境活动/风格）；【镜头N】编号连续不跳号；**声明镜头总数与实际一致**；每镜必备字段（机位/摄影机运动/摄影机位置/背景/动作/微表演细节）；前置信息占比 ≤25% 警告、逐镜占比 ≥55% 警告；旧版固定时长/画幅结尾检测
- **generation-control**：七方输入合同收齐或标 N/A；"电影感/紧张/高级"必须落实成可观察条件；**一条生成尽量只用一个场景参考**（多场景分开生成防资产污染）；互动分支分别生成；跨段接缝=重叠覆盖区+显式写出上段结束/下段进入状态；重试分类（空间/资产/表演/物理/画质/能力边界六类根因），第二次必须改变条件；高优先级禁止项可移到资产绑定之后复测（模型对末尾注意不均）

### B3 review-and-repair.md —— ★审片分级与最小返工路由（S4/S5 契约源）

- **审片顺序**：先完整看一遍（这场戏讲清了吗/情绪抵达了吗/观众知道看谁/空间可信/摄影支持主戏/最好的一刻），第二遍按时间码记录
- **P0/P1/P2 分级**：P0 必须修（叙事信息错误/身份看不懂/空间因果崩溃/道具状态错误/表演与剧情相反）；P1 优先（情绪无过程/无反应时间/节奏单一/背景静止舞台/接缝/摄影命题未实现）；P2 集中处理（纹理/车牌/轻微漂移）
- **保护好表演**：好表演比小连续性更难重现——删错误区间/插反应/插特写/裁切重构图/只补过渡/声音连接，优先于扩大重做
- **最小返工路由**：剪辑可解 → 单镜补拍 → 小节重做 → 整场重设计（每修法写保留区间/首选/备选/新资产/验收条件）
- **症状→根因→修法表 22 行**（人物漂移→无 master；情绪跳变→无过渡状态；群戏僵尸→无逐人任务；动作漂浮→未拆状态重量接触；AI 感表演→无对手刺激微表演通道过载；反应早于事件→未定义时序；运镜花哨无张力→无触发点路径落点；道具跳变→未建状态机……）
- **通过标准**（10 条，P0 清零 + P1/P2 不反向破坏）

### B4 生成前检查门（generation-control §7）

台词前因可见 → 大全景比例现实可测 → 近景继承 master 位置与摄影机侧 → 每个可见角色任务/时点/强度不同 → 关键道具三态写明 → …（逐项确认后才送模型）

## C. short-drama-factory（2 份精读）

证据：SKILL.md、references/continuity-ledger.md。（未读：其余 11 references——剧本层创作工艺，D-U3/D-U1 边界外；validate_episode/validate_series——单集正文与全剧台账机检，验证对象是剧本文本而非视频提示词，谓词思想已被我们机检吸收。）

### C1 continuity-ledger.md —— 四类账与读写规程

- **四类账**：伏笔账（埋/养/收/废 + 超期机检）、人物账（存活状态机，死人不能开口）、**道具状态账**（每次易手/损毁/出示记一行；断章道具特写写前必核对持有者）、世界观规则账（能力边界/代价/禁忌，违反 → FAIL）
- **读写规程主循环**：写前读台账 → 写 → 机检 FAIL 即修 → 写后更新台账（第 5 步没做视为未完成）→ 每 5 集跑一次全量机检
- **"台账是唯一事实源，正文与台账冲突时停下向用户确认"**

## D. Spec 增量（第二轮，N1-N12；并入 spec v2 裁决：全部吸收）

| Δ   | 内容                                                                                                                                                                                                                                                                                                                  | spec 落点 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| N1  | **格式映射澄清**：H3 存在两种目标格式——官方六段式（云 API）vs 集成格式（本地 ComfyUI 节点，我们 dialect 契约）。S3 输出 = 集成格式（不变式不动）；**六段式思维作为内容组织标准**：characters→subject_definitions、beats.purpose→summary、八通道核对→retention、镜头脉冲→detailed_description、声音→overall_soundscape | §4/§5     |
| N2  | **WenWu 引擎进 persona**（本轮最大增量）：S2 注入叙事温度判别+密度公式+生命核八通道+四种生镜形态；S3 注入镜头脉冲七段式+表演肌理链+FACS AU+生镜校验 17 项自检；景别 7 档/机位 11/运镜 15/转场 14 库作为 persona 附录（中文强制，禁英文缩写）                                                                          | §5        |
| N3  | **7 列镜头卡并入 DirectingIR.shots**：no/time/duration/shot_size/camera/content(≤30字)/sound(必填)/transition/technique/tags(≤2)；机检：镜号连续、时长累加=段长、sound 必填                                                                                                                                           | §4/§6     |
| N4  | **声音设计**：DirectingIR 增 sound_events（12-slot 固定顺序）+ overall_soundscape 四层 + non_diegetic_music（BPM/进出时间）；机检 ≤12 跳号检查                                                                                                                                                                        | §4/§6     |
| N5  | **视听签名 8 字段**入 meta.audiovisual_signature（S1/S2 产出）；机检 color_ids ≤6、master_dna ≤3、core_theme 可拍性                                                                                                                                                                                                   | §4/§6     |
| N6  | **单元结构增强字段**（unit/dramatic_task/visual_motif/hook + climax_segment 60-80% + 首末 echo）+ ASL 节奏统计机检（默认警告；meta.strict_prompt_validation=true 拒绝——沿 director-suite 双模开关）                                                                                                                   | §4/§6     |
| N7  | **S4 findings severity 对齐 P0/P1/P2**：P0=critical（叙事错误/身份不明/空间崩溃/道具状态错/表演相反）、P1=major、P2=minor；**审片顺序**（先整体判断再按时间码）与**通过标准 10 条**注入 S4 persona                                                                                                                    | §5        |
| N8  | **S5 最小返工路由**：剪辑可解→单镜补拍→小节重做→整场重设计（每级写保留区间/首选/备选/验收）；**保护好表演**原则；**症状→根因→修法表 22 行**作为 S5 知识库（validation 期资料源）                                                                                                                                      | §5        |
| N9  | **S3 生成前检查门**（generation-control §7 逐项清单 + WenWu 生镜校验 17 项）成文前自检                                                                                                                                                                                                                                | §5        |
| N10 | **reference_plan 增四视图**：identity_subject 细化 front/side/back/face（D-U3 执行外，字段先立）；跨段接缝=显式写出上段结束/下段进入状态（禁假定模型理解"续拍"）——continuity_handoff 语义强化                                                                                                                         | §4        |
| N11 | **strict_prompt_validation 双模开关**：meta.strict_prompt_validation=true 时机检不合格直接拒绝（默认警告）——沿 director-suite                                                                                                                                                                                         | §6        |
| N12 | **分镜汇报时间轴强制格式**（连续/精确到秒/无空洞；用户只改个别镜头只重报受影响段）→ S2 后 envelope/await_user_approval 呈现契约                                                                                                                                                                                       | §5        |

## E. 明确不采纳（同第一轮 + 本轮新增）

workflow JSON 构建/提交监控/剪映拼合（D-U3）；剧本生成层；六独立 agent；5000 字符限（tokenizer 精确计数）；V1/V2 双版本；审稿覆盖矩阵（单审计 LLM）；leos output-contracts 的中文纯文本模板外壳（我们输出集成格式 JSON 管线，模板思想进 persona 纪律）。

---

## F. ★官方提示词技能精读（第三轮：MiniMax-AI/MiniMax-H3 官方库）

用户质询"官方的提示词技能"后定位官方本体：**`MiniMax-AI/MiniMax-H3` 模型库内 `skills/h3-prompt-writing/`**（SKILL.md + `references/base-en.txt` 222 行 + `references/ref-en.txt` 341 行，全读）+ `skills/` 下 10 个官方下游技能（3d-animation/brand-promo/game-intro/music-video 等，各含 qc-checklist/shot-table-spec/storyboard-guidelines——目录级，实施期按 stage 取材）。整库 `git clone` 本地化：`C:\Users\11245\AppData\Local\Temp\h3-refs\MiniMax-H3\`。

### F1 官方 stage 模型（修正 spec 事实缺口）

**官方 5 stages**：T2VA / I2VA / FL2VA / L2VA / Ref2VA。官方输出格式：

- **base 四模式**（T2VA/I2VA/FL2VA/L2VA）：`integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music` 三字段；I2VA/FL2VA/L2VA 首行为固定对齐前言（逐字：`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.` / `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark...; Picture 2 (from Shot N) aligns with the S.SS-second mark...` / `<Picture 1> (from [Shot N]) aligns with the S.SS-second mark...`）
- **Ref2VA**：六段式 subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music
- **对照结论：dialect/h3.ts 已逐字实现全部分 stage 格式**（alignmentPreamble 三种前言与官方逐字一致；buildRef2vaText 六段式 + `[reference generation]` 前缀 + fully_preserved 文案；golden 测试锁定的即官方文案）——**spec v2.1 的 stage 枚举（t2v/i2v/ref2v）写错，本节修正为官方 5 stages**

### F2 官方对白契约（G-dialogue 权威依据，含 dialect 缺口）

- 稳定 speaker ID `(S1)(S2)`，合唱 `(S1,S2)`；跨镜同 ID；从不发声的角色无 ID
- 身份描述短语 + ID + 动作 + 语气在 `<d>` **之外**；`<d>` 内**只有语言标签 + 用户口语原文**（逐字保真，不翻译不改写）
- 画外音：固定短语 `says in an off-screen voiceover` + `<d>` 块后紧跟 `while his lips remain completely closed.`
- 对白跨切：`<scenetrans>` 两处标注 + 显式声明跨切延续；片尾截断：`<cutoff>`
- **dialect 缺口**：`buildDialogue` 只发 `<d>[lang] text</d>`，无 (S1) ID 发射/voiceover 短语/scenetrans/cutoff——触及"dialect 契约零改动"不变式，标注为 **dialect 增强候选（需用户裁决）**；管线侧先以机检/审计承载

### F3 官方运镜三维语法

12 种 motion type（Zoom In/Out、Push In/Out、Pan L/R、Truck L/R、Tilt Up/Down、Pedestal Up/Down、Arc Shot、Tracking Shot、Static Shot、Shake Slightly/Strongly、POV、Roll CW/CCW）× 幅度（small/large amplitude，中幅常省略）× 速度（slow/fast）；**写成镜头内自然英语动作**（"The camera pushes in with small amplitude at slow speed toward..."），禁止堆叠标签

### F4 官方切点语法

首镜**无时间戳**；后续镜 `[Shot N] At 00:03.500, ...`（mm:ss.mmm，严格递增且在时长内）；切点动词枚举（camera cuts to/shot cuts to/transitions to/changes to/switches to；cross-dissolve/fade/wipe 仅用户要求时）；**cut 必须引入新信息**——仅距离/角度变化优先运镜

### F5 官方声音/画面文字规则

- overall_soundscape：1-4 句英文单段（环境/动作声/非人声）；对白/歌声/剧中音乐不重复进此段；N/A 仅当用户明确要求全静默
- non_diegetic_music：1-3 句（乐器/速度/节奏/动态），禁抽象情绪词；角色可听音乐是剧中事件归 multimodal；无则 N/A
- 画面可见文字：英文双引号逐字保留原语言（"营业中"例）

### F6 Ref2VA 六段细则（ref-en.txt）

- **summary 任务类型前缀六分类**（可 `+` 组合）：`[reference generation]` / `[keyframe completion]` / `[video editing]` / `[video continuation]` / `[audio reuse]` / `[audio reference]`；仅提供运镜/节奏的视频 → reference generation 而非 editing
- **retention 标记**：可见 fully_preserved / partially_preserved / attribute_transfer / weak_reference；音频 fully_copy / partially_copy / reference / weak_reference；条目格式 `<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - ...`
- **reference label 语法**：`<Subject N>` 可复用内容（一人可多资产合成定义）；`<Picture N>` 独立条目仅限首帧/关键帧/末帧/构图锚（仅定义角色服装时并入 Subject 不单列）；`<Video N>` 整片关系专用；`<Audio N>` 音色参考绑定 `<Subject N> (S1)`
- **FL2VA 偏好单镜**（连续插值）；L2VA 结构：合理前态→显式过渡→末镜收敛→落位
- 时长 4-15s；detail 标准：每镜明确构图/主体位置/环境光照/动作状态变化/运镜/当前声音/参考生效点——**禁止剧情摘要式或纯参考关系列表式描述**

## G. Spec 修正（v2.2，基于 F 节官方证据）

| Δ   | 内容                                                                                                                                                                                                                                          | spec 落点 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| R1  | **stage 枚举修正**：t2v/i2v/ref2v → 官方 5 stages `t2va/i2va/fl2va/l2va/ref2va`；G-refbinding 矩阵按 5 stages 重建（t2va 无引用；i2va=Picture 1 首帧；fl2va=Picture 1+2 首尾帧；l2va=Picture 1 末帧；ref2va=identity/location/prop subjects） | §4/§6     |
| R2  | **S3 角色重定义**：逐镜产出 **H3Shot 内容字段**（what/who/duration/camera/action/micro/carry/ambient/dialogue），**官方分 stage 格式由 dialect 确定性编译**（golden 已逐字节对齐官方 base-en/ref-en）——LLM 产内容、确定性层管格式，零格式漂移 | §5        |
| R3  | **官方对白契约进 S3 persona + 机检**：speaker 稳定 ID/`<d>` 只装口语原文/voiceover 短语+闭嘴声明/`<scenetrans>`/`<cutoff>`                                                                                                                    | §5/§6     |
| R4  | **官方运镜三维语法 + 切点语法进 S2/S3 persona + 机检**（12 motion types × amplitude × speed 自然英语；首镜无时间戳/切点递增/cut 必须引入新信息）                                                                                              | §5/§6     |
| R5  | **Ref2VA 六段细则进机检**：summary 任务类型前缀六分类、retention 四标记枚举（dialect 已实现，机检对账）、detailed_description 禁剧情摘要式                                                                                                    | §6        |
| R6  | **h3-prompt-writing base-en/ref-en 官方黄金文本 = golden 测试与 dialect 对账的权威源**（官方技能引用进 spec 证据链）                                                                                                                          | 全文      |
| R7  | **dialect 增强候选（需用户裁决，触及不变式）**：buildDialogue 补 (S1) 稳定 ID 发射/voiceover 短语/`<scenetrans>`/`<cutoff>`——当前管线以机检+审计承载，不动 dialect                                                                            | §6 标注   |

## H. 证据覆盖声明（v2）

三轮累计：director-suite 6 份核心文档全读；leos 7 份精读（另 7 份 = persona 实施期资料源：directing-grammar/performance-direction/cinematography-direction/spatial-and-assets/role-council/continuity-and-learning/knowledge-and-provenance）；short-drama 2 份精读（其余为剧本层工艺，超范围）；**官方 MiniMax-AI/MiniMax-H3 库：h3-prompt-writing 三件全读 + 官方下游技能 10 个目录级**（实施期按 stage 取材其 qc-checklist/shot-table-spec/storyboard-guidelines）。
