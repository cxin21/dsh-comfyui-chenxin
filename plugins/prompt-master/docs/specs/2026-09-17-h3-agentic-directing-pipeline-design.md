# H3 Agentic 短剧导演管线重设计（设计稿 v2）

- 日期：2026-09-17（v2：吸收三参照项目文件级深度分析 Δ1-Δ8 后整体重设计）
- 深度分析证据：`docs/research/2026-09-17-h3-reference-projects-deep-analysis.md`（director-suite workflow-routing/director-schema-v2/director-playbook 精读；leos SKILL/prompt-director/镜头模板精读；short-drama-factory SKILL 精读）
- 关联：`docs/specs/2026-09-17-agentic-pipeline-redesign.md`（anima agentic 形态——本稿槽位/模板/双轨审核哲学来源）、
  `docs/plans/2026-09-17-semantic-dedupe-wiki-priority.md`（catalog_search 语义归一化，H3 工具链复用）
- 范围：**MiniMax-H3 target 的 prompt_author 短剧工程管线**（多镜头）。anima 管线零改动。

## 0. 用户裁决记录

| #    | 裁决 | 内容                                                                                                                                                         |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-U1 | 范围 | **B：直接上多镜头短剧工程**——剧本 → Beat 拆分 → 逐镜提示词 → storyboard/refs/质检台账                                                                        |
| D-U2 | 槽位 | **五槽位对齐 anima**（leos 六部门合并映射，见 §5）                                                                                                           |
| D-U3 | 边界 | **只做提示词工程**——产出物可被 camera-video 执行，执行/抽帧质检/选择性重试不在本管线（后续 spec）                                                            |
| D-U4 | NSFW | **不设防**——管线内不做分级拦截/改写；`rating` 作为元数据透传。本地 ComfyUI H3 权重推理无云端内容过滤，本地执行语境自洽；推理端实际行为不可控，风险由用户承担 |
| D-U5 | 架构 | **方案 1：独立 directing 编排器 + 方言解耦**——anima（compositing/）零触碰                                                                                    |
| D-U6 | 增量 | **Δ1-Δ8 全部吸收**（三参照项目文件级深度分析的 spec 增量，见 §4/§5/§6 各标注）                                                                               |

## 1. 现状痛点（会话压缩包 68c427f3 实证）

1. H3 无 agentic 管线：`prompt_author(target=h3)` = 单 LLM intent + 确定性编译。用户要 NSFW 5 秒视频提示词 → agent 被迫绕过工具，手写 shots JSON + 自建 headless harness 直调编译路径（模块路径错误两次）。
2. `h3-rating-gate` safe-only 硬拒：MiniMax 官方政策与用户高频 NSFW 需求冲突，无降级路径（D-U4 裁决不设防）。
3. 无多镜头能力：Beat 拆分/跨镜连续性/工作流路由（t2v/i2v/ref2v）完全缺位。

## 2. 参照项目吸收清单

| 来源                              | 吸收（→ 本稿落点）                                                                                                                                                                                                | 不采纳                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| director-suite workflow-routing   | 路由优先级链思想 → §6 G-refbinding；按 class_type 而非节点 ID 的映射哲学 → dialect 编译层既有做法确认                                                                                                             | workflow JSON 构建/提交监控（D-U3）                              |
| director-suite director-schema-v2 | creative_intent 四件套、shot_intents（new_information 与镜头数严格相等）、continuity_handoff 四通道、reference roles 绑定 H3 标签语法（→ §4/§6）                                                                  | V1/V2 双版本共存（不向后兼容，单版本）                           |
| director-suite director-playbook  | shot purpose 六分类 + 时长 taxonomy（→ §6 机检）；双锚点铁律；Ref2VA 末态泄漏失效模式与 FL2VA endpoint delta；空间连续性先于运镜；对白契约（speaker ID + `<d>` 标签）；QC 八维矩阵；两次同类失败改结构（→ §5/§7） | Higgsfield 平台特定控制                                          |
| leos 六部门                       | 角色权限负面清单（→ §5 各槽位）；生成授权门 + 版本状态机（→ §7）；编译职位非第二导演（→ S3 persona）；逐镜审稿（→ S4 逐镜 findings）                                                                              | 六个独立 agent（D-U2）；5000 字符限（用官方 tokenizer 精确计数） |
| short-drama-factory               | 台账先行（无台账不开写 → 连续性机检 critical）；机检 FAIL 不得裸交；冲突裁决优先级链（用户 > spec > dialect > 其他）                                                                                              | 剧本生成层（超范围）                                             |

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
    rating, original_rating            // D-U4：透传元数据，管线不改写
  },
  characters: [{ id: "S1", name, appearance_lock, wardrobe, notes }],   // speaker ID 与 characters.id 一一对应
  locations:  [{ id, name, spatial_landmarks }],                         // 空间地标 = 轴线/方位依据
  props:      [{ id, name, state_by_beat: { beatId: "初态→触发→末态" } }],  // 道具因果几何三态台账（Δ8）
  beats: [{
    id: "B01",
    purpose,                                   // 本 Beat 信息变化/戏剧目的 ≤2 句
    creative_intent: {                         // Δ1（director-schema-v2）：四件套必须可观察、非空
      state_before, trigger, state_after, audience_takeaway
    },
    location_id, character_ids,
    shots: [{
      id: "B01-S1",
      purpose_tag: "dialogue" | "mixed" | "action" | "establish" | "insert" | "reaction",   // Δ2 强制标签
      duration_seconds,                        // Δ2 按 purpose_tag 时长区间机检（§6 G-duration）
      stage: "t2v" | "i2v" | "ref2v",
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
        micro_performance
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

| 槽位                       | 工具                      | 输入 → 输出                                                                                                       | 关键纪律（含负面清单）                                                                                                                                                                                                                                |
| -------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 `pm-script-analyst`     | 无                        | 剧本 → ScriptIR JSON                                                                                              | 台词原文不改写；appearance_lock 必填；**不得暗改剧情/角色关系**                                                                                                                                                                                       |
| S2 `pm-beat-director`      | catalog_search            | ScriptIR → beats[]（creative_intent/shot_intent/direction 三部门合并方案/stage 路由/reference_plan/道具三态登记） | **双锚点铁律**（identity+location，一 Beat 至多一个空间参考）；空间连续性先于运镜多样性（180° 轴线/同侧 master）；**先导演后提示词，可演动作先于情绪形容词**；**不得用抽象情绪词替代表演动作**；Ref2VA 末态泄漏失效模式 → 相反状态道具优先 i2v 首尾帧 |
| S3 `pm-shot-writer`        | catalog_search            | Beat 方案 → 官方结构提示词（integrated_multimodal_description + overall_soundscape）                              | **编译职位非第二导演**——冲突交裁决不擅自折中；台词逐字装 `<d>[语言]...</d>`（禁角色名/冒号入标签）；说话前建立指向关系；反字幕约束；prompt 不得引用 reference_plan 之外的资产                                                                         |
| S4 `pm-continuity-auditor` | catalog_search + 机检结果 | 逐镜语义审计 + 工程级跨镜连续性                                                                                   | **QC 八维矩阵**（§6）；每镜必跑；verdict+findings 逐镜（沿 anima A3：无 critical 跳审）                                                                                                                                                               |
| S5 `pm-shot-repairer`      | catalog_search            | findings → 受影响镜头修复版                                                                                       | **单维失败只修该维**；最小改动；蓝图冻结（DirectingIR beats 方案不可变，只修 prompt）；**两次同类失败 → 上报结构性问题**（改 Beat 结构/锚点，不在 prompt 层硬修）                                                                                     |

两段式确认（leos 授权门语义 + 版本状态机，§7）：S2 方案产出后默认自动进入 S3；`await_user_approval: true` 时挂起——envelope 返回方案 + `status: "awaiting_approval"`，用户确认后续跑（S3-S5）。版本登记：每次 S3/S5 产出登记进 continuity_ledger（版本号/上游设计 hash/相对上版变化）。

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
- **G-intents**（Δ1）：shot_intent 数 = shots 数；每镜 new_information 非空；对白 Beat ≥1 contains_reaction
- **G-refbinding**（Δ3）：**stage ↔ 角色绑定**——t2v：reference_plan 必空；i2v：仅 composition_picture（首/尾帧）；ref2v：identity/location/prop_subject（Subject N）；**引用 stage 不支持的角色 = critical**（"提示词不得引用到不了模型的参考"）
- **G-dialogue**（Δ4）：`<d>[语言]...</d>` 标签内文本与 script 台词逐字相等（source_script_hash 对账）；标签内禁角色名/冒号；speaker_id ∈ characters
- **G-prop**（Δ8）：props.state_by_beat 覆盖该 prop 出现的全部 Beat；状态三态（初态→触发→末态）结构完整
- **G-handoff**（Δ1）：非首 Beat 的 continuity_handoff 四通道非空
- **G-budget**：官方 tokenizer 精确计数（现行机制复用，t2va/i2va/ref2va 各档预算）
- 其余 `rules-h3.ts` 既有机检（镜头信息增量/cut 时间戳）复用不修改

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
- **不变式**：anima 全量测试零改动零失败；`dialect/h3.ts` 编译契约零改动；rules-h3 复用不修改；`camera-video` 三 stage 工具为下游消费者不改动

## 10. 明确不做（本轮）

- ComfyUI 执行/低清测试/抽帧质检/选择性重试闭环（D-U3，后续 spec；workflow-routing 的参数覆盖表与断点恢复设计在该 spec 复用）
- 剧本从零生成（输入 = 已有剧本）
- 向量库重建（anima 侧遗留，独立计划）
- composition_picture/motion_video/audio_reference 的执行绑定（director-suite 亦为 schema-only——机检按 G-refbinding 拒绝其进入 prompt 引用，待 runner 支持后解锁）
