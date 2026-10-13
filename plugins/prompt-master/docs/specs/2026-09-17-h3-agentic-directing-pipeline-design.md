# H3 Agentic 短剧导演管线重设计（设计稿 v2）

- 日期：2026-09-17（v2：吸收三参照项目文件级深度分析 Δ1-Δ8 后整体重设计）
- 深度分析证据：`docs/research/2026-09-17-h3-reference-projects-deep-analysis.md`（director-suite workflow-routing/director-schema-v2/director-playbook 精读；leos SKILL/prompt-director/镜头模板精读；short-drama-factory SKILL 精读）
- 关联：`docs/specs/2026-09-17-agentic-pipeline-redesign.md`（anima agentic 形态——本稿槽位/模板/双轨审核哲学来源）、
  `docs/plans/2026-09-17-semantic-dedupe-wiki-priority.md`（catalog_search 语义归一化，H3 工具链复用）
- 范围：**MiniMax-H3 target 的 prompt_author 短剧工程管线**（多镜头）。anima 管线零改动。

## 0. 用户裁决记录

| #    | 裁决    | 内容                                                                                                                                                                                                |
| ---- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-U1 | 范围    | **B：直接上多镜头短剧工程**——剧本 → Beat 拆分 → 逐镜提示词 → storyboard/refs/质检台账                                                                                                               |
| D-U2 | 槽位    | **五槽位对齐 anima**（leos 六部门合并映射，见 §5）                                                                                                                                                  |
| D-U3 | 边界    | **只做提示词工程**——产出物可被 camera-video 执行，执行/抽帧质检/选择性重试不在本管线（后续 spec）                                                                                                   |
| D-U4 | NSFW    | **不设防**——管线内不做分级拦截/改写；`rating` 作为元数据透传。本地 ComfyUI H3 权重推理无云端内容过滤，本地执行语境自洽；推理端实际行为不可控，风险由用户承担                                        |
| D-U5 | 架构    | **方案 1：独立 directing 编排器 + 方言解耦**——anima（compositing/）零触碰                                                                                                                           |
| D-U6 | 增量    | **Δ1-Δ8 全部吸收**（三参照项目文件级深度分析的 spec 增量，见 §4/§5/§6 各标注）                                                                                                                      |
| D-U7 | dialect | **动 dialect（R7 裁决）**：对白发射层按官方契约增强——speaker 稳定 ID `(S1)` 分配、voiceover 固定短语+闭嘴声明、`<scenetrans>`/`<cutoff>` 标记（§6.1）；含对白 golden 再生，非对白 golden 逐字节不变 |

## 1. 现状痛点（会话压缩包 68c427f3 实证）

1. H3 无 agentic 管线：`prompt_author(target=h3)` = 单 LLM intent + 确定性编译。用户要 NSFW 5 秒视频提示词 → agent 被迫绕过工具，手写 shots JSON + 自建 headless harness 直调编译路径（模块路径错误两次）。
2. `h3-rating-gate` safe-only 硬拒：MiniMax 官方政策与用户高频 NSFW 需求冲突，无降级路径（D-U4 裁决不设防）。
3. 无多镜头能力：Beat 拆分/跨镜连续性/工作流路由（t2v/i2v/ref2v）完全缺位。

## 2. 参照项目吸收清单

| 来源                                               | 吸收（→ 本稿落点）                                                                                                                                                                                                                                                                                                                                             | 不采纳                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| director-suite workflow-routing                    | 路由优先级链思想 → §6 G-refbinding；按 class_type 而非节点 ID 的映射哲学 → dialect 编译层既有做法确认                                                                                                                                                                                                                                                          | workflow JSON 构建/提交监控（D-U3）                              |
| **官方 MiniMax-AI/MiniMax-H3 `h3-prompt-writing`** | **官方 5 stages（t2va/i2va/fl2va/l2va/ref2va）+ 分 stage 输出格式（base 三字段/对齐前言/六段式）→ §4 stage 枚举修正、§5 S3 角色重定义（R1/R2）；官方对白契约（speaker ID/voiceover/scenetrans/cutoff）+ 运镜三维语法 + 切点语法 → §6 G-dialogue-official/G-cameramotion/G-cutgrammar（R3/R4）；base-en/ref-en 官方黄金文本 = dialect golden 对账权威源（R6）** | 无——官方规则全吸收                                               |
| director-suite director-schema-v2                  | creative_intent 四件套、shot_intents（new_information 与镜头数严格相等）、continuity_handoff 四通道、reference roles 绑定 H3 标签语法（→ §4/§6）                                                                                                                                                                                                               | V1/V2 双版本共存（不向后兼容，单版本）                           |
| director-suite director-playbook                   | shot purpose 六分类 + 时长 taxonomy（→ §6 机检）；双锚点铁律；Ref2VA 末态泄漏失效模式与 FL2VA endpoint delta；空间连续性先于运镜；对白契约（speaker ID + `<d>` 标签）；QC 八维矩阵；两次同类失败改结构（→ §5/§7）                                                                                                                                              | Higgsfield 平台特定控制                                          |
| leos 六部门                                        | 角色权限负面清单（→ §5 各槽位）；生成授权门 + 版本状态机（→ §7）；编译职位非第二导演（→ S3 persona）；逐镜审稿（→ S4 逐镜 findings）                                                                                                                                                                                                                           | 六个独立 agent（D-U2）；5000 字符限（用官方 tokenizer 精确计数） |
| short-drama-factory                                | 台账先行（无台账不开写 → 连续性机检 critical）；机检 FAIL 不得裸交；冲突裁决优先级链（用户 > spec > dialect > 其他）                                                                                                                                                                                                                                           | 剧本生成层（超范围）                                             |

## 3. 总体架构

**入口路由（显式定案，沿 anima 不向后兼容先例）**：`prompt_author { target: "h3", script: <剧本文本|文件路径>, project?: <工程名> }` 即路由到本 directing 编排器，为 h3 **唯一路径**；旧 h3 shots 直译路径移除（回滚 = revert 提交）。`minimax_scenario`（官方场景模板探索/dry_run）保留——其产出可作为 S2 的参考输入而非替代。

```
pe-framework/directing/orchestrate.ts（新，与 compositing 完全独立）
        ├─ S1 pm-script-analyst    LLM① 一次/工程：剧本文本 → ScriptIR
        ├─ S2 pm-beat-director     LLM② 一次/工程：ScriptIR → DirectingIR.beats[]
        ├─ S3 pm-shot-writer       LLM③ 逐镜：Beat 方案 → 官方结构提示词
        ├─ S4 双轨：机器门(零LLM) ∥ pm-continuity-auditor LLM④ 逐镜+工程级
        ├─ S5 pm-shot-repairer     LLM⑤ 受影响镜头
        ▼
DirectingIR ──→ dialect 编译层（h3: 现行 dialect/h3.ts 零改动）──→ 官方格式文本
```

模块边界：

- 新增 `pe-framework/directing/`：orchestrate.ts、五个 prompt/persona 模块、ir-schema.ts、continuity-check.ts（机检）、engineering/（storyboard.json + prompts/*.txt + continuity-ledger.json 落盘）
- 零触碰：`compositing/**`、`dialect/anima*`、anima audit/envelope 路径
- 复用：`llm/task-text.ts` 统一模板、`llm/subagent-tool-runner.ts`、`render/envelope.ts`、`SubagentHostCtx`
- 方言解耦 = 未来模型扩展点：编排器只消费/产出 DirectingIR；`dialect/registry` 新增 directing 方言注册面（compile + 审计规则 + stage 路由表），新模型 = 新方言包，编排器零改动

## 4. DirectingIR v2 数据契约（= storyboard.json 落盘 schema）

```jsonc
{
  meta: {
    title, source_script_hash, created_at,
    dialect: "h3", director_schema_version: 1,
    rating, original_rating,            // D-U4：透传元数据，管线不改写
    strict_prompt_validation: false,    // N11（双模开关）：true 时机检不合格直接拒绝，默认警告
    climax_segment,                     // N6：高潮段号，机检校验位于全片 60-80%
    audiovisual_signature: {            // N5（8 字段，S1/S2 产出）
      medium, aspect,
      color_ids: { "<角色/势力>": "<色相>" },   // ≤6，每角色一色相
      texture: ["…"],                    // 质感词
      core_theme,                        // 必须可拍：主语+比喻动词+宾语
      master_dna: ["…"],                 // ≤3
      genre_formula: { opening, turn, climax, ending }
    },
    sound_events: ["1 开场基底", "…", "12 结尾尾音"],   // N4：固定顺序 12-slot（无对应写 N/A，禁跳号）
    world_anchors: { origin, equipment, energy, rule, support } | null   // 可选，每条带出处
  },
  characters: [{ id: "S1", name, appearance_lock, wardrobe, notes,
    four_view_refs: { front, side, back, face } | null }],   // N10：四视图登记（D-U3 执行外，字段先立）；speaker ID 与 characters.id 一一对应
  locations:  [{ id, name, spatial_landmarks }],                         // 空间地标 = 轴线/方位依据
  props:      [{ id, name, state_by_beat: { beatId: "初态→触发→末态" } }],  // 道具因果几何三态台账（Δ8）
  beats: [{
    id: "B01",
    purpose,                                   // 本 Beat 信息变化/戏剧目的 ≤2 句
    unit: { dramatic_task, visual_motif, hook } | null,   // N6 单元结构（visual_motif 来自签名；相邻单元 ≥1 种对比；首末 echo）
    creative_intent: {                         // Δ1（director-schema-v2）：四件套必须可观察、非空
      state_before, trigger, state_after, audience_takeaway
    },
    location_id, character_ids,
    shots: [{                                  // Δ2/N3：7 列镜头卡 + 导演字段合一
      id: "B01-S1",
      purpose_tag: "dialogue" | "mixed" | "action" | "establish" | "insert" | "reaction",   // Δ2 强制标签
      time: "mm:ss",                           // 连续时间轴（无空洞无重叠）
      duration_seconds,                        // Δ2 按 purpose_tag 时长区间机检（§6 G-duration）
      shot_size: "极端特写|近景|中近景|中景|中远景|全景|远景",   // N3 景别 7 档中文强制（禁 ECU/CU 缩写）
      camera: "<机位>·<运动>(·<速度修饰>)",      // N3 机位库 11 × 运镜库 15
      transition: "硬切|匹配剪辑|撞切|J切|L切|…",               // N3 转场库 14（默认硬切可省略）
      technique: "<高级技法 8 之一>" | null,
      tags: ["海报帧|伏笔|关键|重特效|长镜|音锚|特设备"],        // ≤2
      sound: "本镜声音（必填，静默也写）",      // N3：7 列镜头卡 sound 列
      stage: "t2va" | "i2va" | "fl2va" | "l2va" | "ref2va",   // R1：官方 5 stages（t2va 文本生全部/i2va 首帧/fl2va 首尾帧/l2va 末帧/ref2va 多参考）
      route_reason,                            // stage 选择理由（一致性需求）
      shot_intent: { new_information, narrative_subject, contains_reaction },   // Δ1：无新信息的 cut 应删除或改为运镜
      reference_plan: [{                       // Δ3 角色绑定 H3 标签语法
        role: "identity_subject" | "location_subject" | "prop_subject" | "composition_picture" | "motion_video" | "audio_reference",
        target: "<characters/locations/props 的 id>",
        h3_label: "Subject 1" | "Picture 1" | "Video 1" | "Audio 1"
      }],
      direction: {                             // S2 产出（leos 三部门合并方案）
        performance, staging, cinematography,
        dialogue: { speaker_id: "S1", line, addressee_id } | null,   // line = 剧本台词逐字
        micro_performance                      // 可含 FACS AU 注释（A-E 强度）
      },
      continuity_handoff: { positions, emotion, props, audio },   // Δ1 四通道：交下一 Beat
      prompt: { text, token_count } | null,    // S3 产出
      audit: { gates: [...], findings: [...], verdict } | null
    }]
  }],
  continuity_ledger: [{ check, beat_span, status, note }]
}
```

契约规则（机检对象，§6）：

- `creative_intent` 四字段可观察、非空；`shots[].shot_intent` 与 shots 数量**严格相等**；对白 Beat 至少一镜 `contains_reaction: true`
- `characters.id` 即 H3 speaker ID 源（`(S1)`），一一对应
- 工程输出物（`temp/prompt-master/<project>/`）：`storyboard.json`、`prompts/B01-S1.txt`、`continuity-ledger.json`
- 部分产出可交付：storyboard 恒为合法 JSON（prompt 可为 null）；增量重跑 = 只重跑 null/违规镜

## 5. 五槽位 LLM 契约

提示词格式沿用统一模板（`<task_persona>`（角色+工具协议+few-shot）→ 数据块 → `<rules>` → `<output_contract>` + 自动反注入）。每槽位带 leos 式**权限负面清单**（"不得擅自改动"）。

| 槽位                       | 工具                      | 输入 → 输出                                                                                                                                                                                                                                                   | 关键纪律（含负面清单）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1 `pm-script-analyst`     | 无                        | 剧本 → ScriptIR JSON                                                                                                                                                                                                                                          | 台词原文不改写；appearance_lock 必填；**不得暗改剧情/角色关系**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| S2 `pm-beat-director`      | catalog_search            | ScriptIR → beats[]（creative_intent/shot_intent/direction 三部门合并方案/stage 路由/reference_plan/道具三态登记）                                                                                                                                             | **双锚点铁律**（identity+location，一 Beat 至多一个空间参考）；空间连续性先于运镜多样性（180° 轴线/同侧 master）；**先导演后提示词，可演动作先于情绪形容词**；**不得用抽象情绪词替代表演动作**；Ref2VA 末态泄漏失效模式 → 相反状态道具优先 i2v 首尾帧；**WenWu 引擎（N2）**：叙事温度判别（高动态/细腻文戏/混合）+ 密度公式（round(T/1.0\|3.0\|2.0)，仅用户未指定结构时）+ 生命核八通道（形场视力念息言续）+ 四种生镜形态；**不得自动补默认时长/画幅**                                                                                                                                                                                                             |
| S3 `pm-shot-writer`        | catalog_search            | Beat 方案 → 逐镜 **H3Shot 内容字段**（what/who/duration/camera/action/micro/carry/ambient/dialogue——R2）；**官方分 stage 格式由 dialect 确定性编译**（t2va 三字段 / i2va·fl2va·l2va 对齐前言+三字段 / ref2va 六段式，golden 已逐字节对齐官方 base-en/ref-en） | **编译职位非第二导演**——冲突交裁决不擅自折中；**官方对白契约（R3）**：speaker 稳定 ID `(S1)(S2)`、`<d>` 内只有语言标签+口语原文（禁角色名/冒号）、voiceover 用固定短语 `says in an off-screen voiceover`+闭嘴声明、跨切 `<scenetrans>`、片尾截断 `<cutoff>`；说话前建立指向关系；反字幕约束；**官方运镜三维语法（R4）**：motion type × amplitude × speed 写成镜头内自然英语动作（禁标签堆叠）；prompt 不得引用 reference_plan 之外的资产；**镜头脉冲七段式**（观察理由→画面入口→新信息→主体变化→摄影机响应→结果落点→牵拉物，N2）；**表演肌理链**（刺激→压住→失效→泄露→选择→余波）+ FACS AU（A-C 日常/D 峰值）；**成文前过生成前检查门 + 生镜校验 17 项自检（N9）** |
| S4 `pm-continuity-auditor` | catalog_search + 机检结果 | 逐镜语义审计 + 工程级跨镜连续性                                                                                                                                                                                                                               | **QC 八维矩阵**（§6）；**findings severity 对齐 P0/P1/P2**（N7：P0=叙事错误/身份不明/空间崩溃/道具状态错/表演相反；P1=情绪无过程/接缝/命题未实现；P2=纹理漂移）；**审片顺序**：先整体判断（讲清了吗/情绪抵达了吗/最好的一刻）再按时间码记录；每镜必跑；verdict+findings 逐镜（沿 anima A3）                                                                                                                                                                                                                                                                                                                                                                        |
| S5 `pm-shot-repairer`      | catalog_search            | findings → 受影响镜头修复版                                                                                                                                                                                                                                   | **单维失败只修该维**；**最小返工路由**（剪辑可解→单镜补拍→小节重做→整场重设计，N8）；**保护好表演**（好表演是稀缺资产——删错误区间/插反应/裁切重构图优先于扩大重做）；**症状→根因→修法表 22 行**为知识库（实施期资料源）；蓝图冻结（DirectingIR beats 方案不可变，只修 prompt）；**两次同类失败 → 上报结构性问题**（改 Beat 结构/锚点，不在 prompt 层硬修）                                                                                                                                                                                                                                                                                                         |

两段式确认（leos 授权门语义 + 版本状态机，§7）：S2 方案产出后默认自动进入 S3；`await_user_approval: true` 时挂起——envelope 返回方案 + `status: "awaiting_approval"`，用户确认后续跑（S3-S5）。版本登记：每次 S3/S5 产出登记进 continuity_ledger（版本号/上游设计 hash/相对上版变化）。

**N12 分镜汇报时间轴强制格式**（S2 产出呈现给用户时，沿 director-suite）：必须逐镜给出「起止时间（精确到秒、连续、无空洞无重叠）→ 画面内容 → 对白」时间轴表格；**禁止宽泛概括**（"前面是开场、中间打斗"类）。用户只改个别镜头时，仅重报被改镜头及其前后衔接，不整片重述。

## 6. 双轨审核与机器门

LLM 轨 `pm-continuity-auditor` **QC 八维矩阵**（Δ5，每镜逐维 verdict）：

| 维度        | 通过条件                               | 典型修复                  |
| ----------- | -------------------------------------- | ------------------------- |
| Story       | creative_intent.audience_takeaway 可读 | 删/重排镜头；强化反应     |
| Identity    | 人脸/发型/服装稳定                     | 改进/复用 identity 锚     |
| Location    | 同一地理与地标延续                     | 拼贴换单一空间图          |
| Blocking    | 方位/景深/高度/朝向合逻辑              | 回同侧 master；锁定地标   |
| Interaction | 视线/握持/接触/指向可信                | 显式写状态与几何          |
| Dialogue    | 台词逐字、说话顺序/对象/时点通过       | 修 speaker 标签与交互调度 |
| Text        | 无意外字幕/可读乱码                    | 补显式反文字约束          |
| Rhythm      | 时长匹配戏剧功能                       | 重排 shot 打包；不凑数    |

机器门（零 LLM，全部 critical 除非注明）：

- **G-schema**：DirectingIR schema 校验（字段/枚举/引用完整性）
- **G-purpose**（Δ2）：purpose_tag ∈ 六枚举；**G-duration**：duration_seconds 落入该 tag 区间（对白 2-4/混合 1.5-3/动作 0.4-1.5/建立 2-4/插入 0.5-2/反应 1-2——violation = important；单生成单元 <4s 或 >15s = critical，H3 硬约束）
- **G-shotcard**（N3）：镜号连续不跳号；**每镜时间连续且时长累加 = 段长**（无空洞无重叠）；sound 必填（静默也写）；tags ≤2
- **G-sound**（N4）：sound_events ≤12、顺序固定禁跳号、每项含 time/event
- **G-signature**（N5）：audiovisual_signature 8 字段齐全；color_ids ≤6（每角色一色相，禁漏色重色）；master_dna ≤3；core_theme 可拍性（主语+比喻动词+宾语）
- **G-unit**（N6）：climax_segment 起始位于全片 60-80%；相邻单元 ≥1 种对比；首末单元意象 echo（默认 warning，strict 模式拒绝）
- **G-intents**（Δ1）：shot_intent 数 = shots 数；每镜 new_information 非空；对白 Beat ≥1 contains_reaction
- **G-refbinding**（R1 修正为官方 5 stages）：**stage ↔ 角色绑定**——t2va：reference_plan 必空；i2va：Picture 1（首帧）；fl2va：Picture 1+2（首/尾帧）；l2va：Picture 1（末帧）；ref2va：identity/location/prop_subject（Subject N）；**引用 stage 不支持的角色 = critical**（"提示词不得引用到不了模型的参考"）
- **G-dialogue-official**（R3 官方契约，**R7 已裁决由 dialect 发射层实现**，详见 §6.1）：对白跨切用 `<scenetrans>` 两处标注；片尾截断用 `<cutoff>`；voiceover 用固定短语 `says in an off-screen voiceover` + 闭嘴声明；speaker ID 跨镜稳定（dialect 发射 + 机检对账双保险）
- **G-cameramotion / G-cutgrammar**（R4 官方语法）：运镜 = motion type × amplitude × speed 自然英语（禁标签堆叠）；首镜无时间戳、切点 mm:ss.mmm 严格递增且在时长内、cut 必须引入新信息（仅距离/角度变化 → 优先运镜）
- **G-dialogue**（Δ4）：`<d>[语言]...</d>` 标签内文本与 script 台词逐字相等（source_script_hash 对账）；标签内禁角色名/冒号；speaker_id ∈ characters
- **G-prop**（Δ8）：props.state_by_beat 覆盖该 prop 出现的全部 Beat；状态三态（初态→触发→末态）结构完整
- **G-handoff**（Δ1）：非首 Beat 的 continuity_handoff 四通道非空
- **G-budget**：官方 tokenizer 精确计数（现行机制复用，t2va/i2va/ref2va 各档预算）
- 其余 `rules-h3.ts` 既有机检（镜头信息增量/cut 时间戳）复用不修改
- **N11 双模开关**：`meta.strict_prompt_validation` 默认 false（G-unit/G-signature 类结构项降为 warning）；true 时机检不合格直接拒绝——沿 director-suite

### 6.1 dialect 对白契约增强（R7，用户裁决 2026-09-17：动 dialect）

不变式修订：`dialect/h3.ts` 编译契约的**对白发射层按官方契约增强**（本节）；其余编译行为零改动。影响面 = `buildDialogue` + `schema/h3-shots.ts` 输入契约 + 含对白的 golden 基线再生。

**① 输入契约扩展**（`schema/h3-shots.ts` parseH3Shot）：`dialogue` 对象形态增三个可选布尔——`voiceover`（画外音）、`continues_across_cut`（台词跨本镜出口切点延续）、`truncated`（被片尾截断）；`<d>` 标签禁入输入的既有校验保留。

**② speaker ID 分配算法**（编译作用域内确定性）：

```
按 shots 顺序扫描；含 dialogue 的 shot：
  key = shot.who ?? `__anon_${shotIndex}`    // 无 who 的发声者按出现次序独立编号
  首次出现 → 分配 S1、S2、…（递增）；同 key 跨镜保持同 ID
```

DirectingIR 管线：`characters[].id`（S1…）直接作为 speaker ID 源注入（工程级跨单元稳定，满足官方"同一说话人跨镜同 ID"）。

**③ 发射格式**（`buildDialogue(shot, speakerId)`）：

- 常规：`The speaker (S1) says: <d>[lang] text</d>`；`who` 存在时用 `${who} (S1) says: ...`
- voiceover：`The speaker (S1) says in an off-screen voiceover: <d>[lang] text</d> while their lips remain completely closed.`（闭嘴声明用性别中性 their——与官方示例 his 的差异记为确定性选择，golden 锁定）
- `continues_across_cut: true`：`<d>` 块后追加 `<scenetrans> the dialogue continues across the cut.`（官方要求切点两处标注——下一镜由其自身 dialogue 的入口语义承接）
- `truncated: true`（仅末镜合法，机检校验）：`<d>[lang] text</d><cutoff>` 紧跟标签后
- 无 dialogue 的 shot 发射不变；非对白编译路径（三字段/六段式的非 dialogue 部分）零改动

**④ golden 再生策略**：仅含 dialogue 的 golden 基线按官方契约再生（提交信息注明 R7 裁决）；非对白 golden 逐字节不变。回归门 = 全量 vitest + dialect golden 双跑。

**⑤ 下游影响**：`rules-h3.ts` 台词比对、camera-video 工作流、envelope——均消费编译后文本，格式增强向后兼容（新增标记为官方语法，非破坏）。

## 7. 递进修复与版本状态机

```
方案确认（S2 产出，await_user_approval 可选挂起）
  → 授权 → S3 逐镜成文（prompt_v1）
  → S4 逐镜审计（八维）+ 工程级跨镜
  → S5 修复（仅受影响镜头；单维失败只修该维）
  → 复审 → …（≤2 轮/镜）→ 批准 → 落盘交付
两次同类失败 → S5 上报结构问题（advisory structural_issue）→ 用户裁决改 Beat 结构
版本登记：每次 S3/S5 产出记入 continuity_ledger（版本/上游 hash/变化摘要）
```

## 8. 错误处理与降级

| 失败点              | 语义                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| S1/S2 失败/解析失败 | fail-fast 显式错误（上游是根，不空手编故事）                                     |
| S3 单镜失败         | 该镜 `prompt: null` 进审计，不阻塞其他镜                                         |
| S4 LLM 故障         | 仅机器门降级（advisory 留痕）                                                    |
| S5 耗尽（≤2 轮/镜） | 保留最后产物 + `loop_exhausted`                                                  |
| 部分产出            | storyboard 恒为合法 JSON；增量重跑 = 只重跑 null/违规镜                          |
| 推理端内容拒收      | 本地执行语境不可控（D-U4）——envelope meta.original_rating 如实标记，不做改写承诺 |

## 9. 测试策略与不变式

- 纯函数 TDD：DirectingIR schema 校验、G-purpose/G-duration/G-intents/G-refbinding/G-dialogue/G-prop/G-handoff 各机检谓词、tokenizer 预算边界、连续性台账匹配
- 编排器全 mock（沿 compositing 模式）：happy path（3-Beat 迷你剧本 golden）/ 单镜失败不阻塞 / 修复循环 / S4 降级 / 两段式确认挂起与续跑 / 递进放宽触发
- **不变式**：anima 全量测试零改动零失败；`dialect/h3.ts` 编译契约**除 §6.1 对白发射层增强（D-U7）外零改动**；rules-h3 复用不修改；`camera-video` 三 stage 工具为下游消费者不改动

## 10. 明确不做（本轮）

- ComfyUI 执行/低清测试/抽帧质检/选择性重试闭环（D-U3，后续 spec；workflow-routing 的参数覆盖表与断点恢复设计在该 spec 复用）
- 剧本从零生成（输入 = 已有剧本）
- 向量库重建（anima 侧遗留，独立计划）
- composition_picture/motion_video/audio_reference 的执行绑定（director-suite 亦为 schema-only——机检按 G-refbinding 拒绝其进入 prompt 引用，待 runner 支持后解锁）

## 11. 实施对齐修订记录（R26 回填，2026-10-13）

directing remediation 批次落地时的实施裁决与语义精化（全量回归绿 + dist 直连集成 8/8 后回填）：

1. **§3 入口签名**：`script` 降为可选——`resumeStoryboard` 续跑可省（省略时逐字对账与 hash 对账自然跳过）；新鲜请求缺 script → 编排器 fail-fast（`directing 缺 script 文本：新鲜请求必填，续跑可省`）。「剧本文本|文件路径」的文件形态仍由工具层读取后传入。
2. **§5/§7 续跑对账**：resume 时若同时提供 script，按 `source_script_hash`（sha256）对账；不一致 → advisory `resume_script_mismatch` + 逐字对账（G-dialogue 的 scriptText）跳过。已批准镜永不被确定性重编译回退（编译循环顶 `shot.prompt != null` → continue）。
3. **§6 门点名词边界**：gate detail 对 shot/beat id 的匹配改词边界正则（`(?<![A-Za-z0-9_-])ID(?![A-Za-z0-9_-])`），废除 includes 子串语义——修复「B01-S1 ⊂ B01-S10 误伤」这一类假阳性路由（S5 只修真正被点名的镜）。
4. **§7/§8 取消语义**：编排器全程尊重调用方取消——`CallerCancelledError` 从 S3/S4/S5/编译各 catch 穿透，不被吞成 advisory 降级。**D7 fail-open 不适用于取消**：取消 = 停止烧钱，不是降级出稿。
5. **§3 方言解耦（R24 裁决）**：新增 `directing/compile.ts` 单一 seam（现委托 compileH3，`Parameters<>` 投影零重复）；registry 包待第二方言接入时再建（Speculative Generality 防御）。
6. **§6 G-cameramotion 投影注记**：机检只验结构面（camera 非空 + 含双语运镜语汇，severity critical）；「自然英语三维语法」属 S3 persona 纪律面——机检不装懂语义。
7. **时间连续门加固**：`parseTimeToSeconds` 对缺字段/非 `MM:SS` 返 null（不可判定跳过）——S2 产出 IR 缺 `time` 不再崩整条链。
8. **A 路对抗审查修复批（2026-10-13 第二轮）**：
   - **§7 S5 修复语义重构（P0-1）**：修复预算按镜计数（≤2 轮/镜，`SHOTS_PER_REPAIR` 语义从「全局共 2 次」改为「每镜 2 轮」）；每轮修复后机器门复审（确定性零成本，LLM 复审仍属 S4 每镜一次）；耗尽判定移到终局门——烧满 2 轮仍被 critical/important 点名的镜 → `loop_exhausted`（ok=false，next_action=manual）。修复产出经键白名单写回（prompt 层内容键；蓝图键幻觉丢弃）。repairer output_contract 补 `duration_seconds`（时长类违规的可修维度）。回归锁同步：author-loop/author-judge/author-blueprint 三处「2 镜不可修复」用例的调用数断言 2→4（旧断言锁定的是被判定为 P0 的旧错误语义）。
   - **§6 G-handoff 缺对象守卫（P0-2）**：非首 Beat 镜缺 `continuity_handoff`（LLM 常态）→ 记四通道全缺门，不再 TypeError 崩链。
   - **§5/§7 挂起语义（P1-1）**：resume + `await_user_approval` 同传 → 忽略挂起（advisory `await_user_approval_ignored_resume`）——挂起只属新鲜请求，旧实现照挂 = 永久死锁。
   - **§4/§5 新鲜装配净化（P1-2）**：S2 产出的 prompt/audit 字段在装配 DirectingIR 时剥除——LLM 幻觉稿不得借 R13 skip 通道绕过 S3/S4/S5。
   - **§5 S3 对齐（P1-3）**：S3 产出三级对齐（who 精确 → 数量一致按序 → 单产出直取）；不中 = 显式失败（advisory `shot_writer_unmatched` + prompt:null），不再静默丢弃且台账照登 prompt_v1。S3 output_contract 同步改为「shots 与 beat.shots 一一对应、who 原样回抄」。
   - **§6 id 转义（P1-4）**：词边界正则对 id 做元字符转义（LLM id 可含正则元字符，未转义 SyntaxError）。
   - **§5/§7 续跑隔离（P1-5）**：resumeStoryboard 深拷贝（structuredClone）——编排回填不突变调用方对象。
   - 投影/归因小修：G-budget gate `source='directing/budget'`（旧值误导归因）；envelope `auditor` 投影带 `shot_id`（R13 跳过镜不再滞留前镜裁决）。
