# H3 Agentic 短剧导演管线重设计（设计稿）

- 日期：2026-09-17
- 状态：设计四节经用户逐节认可，待实施计划
- 范围：**MiniMax-H3 target 的 prompt_author 短剧工程管线**（多镜头）。anima 管线零改动。
- 关联：`docs/specs/2026-09-17-agentic-pipeline-redesign.md`（anima agentic 形态，本稿的槽位/模板/双轨审核哲学来源）、
  `docs/plans/2026-09-17-semantic-dedupe-wiki-priority.md`（catalog_search 语义归一化，H3 工具链复用）

## 0. 用户裁决记录

| #    | 裁决 | 内容                                                                                                                                                                                                                        |
| ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-U1 | 范围 | **B：直接上多镜头短剧工程**——剧本 → Beat 拆分 → 逐镜提示词 → storyboard/refs/质检台账                                                                                                                                       |
| D-U2 | 槽位 | **五槽位对齐 anima**（leos 六部门合并映射，见 §3）                                                                                                                                                                          |
| D-U3 | 边界 | **只做提示词工程**——产出物可被 camera-video 执行，但执行/抽帧质检不在本管线（后续 spec）                                                                                                                                    |
| D-U4 | NSFW | **不设防**——管线内不做分级拦截/改写；`rating` 作为元数据透传。注：本地 ComfyUI H3 权重推理无云端内容过滤，"不设防"在本地执行语境自洽；推理端对违规内容的实际行为不可控，风险由用户承担（envelope 如实标记 original_rating） |
| D-U5 | 架构 | **方案 1：独立 directing 编排器 + 方言解耦**——anima（compositing/）零触碰                                                                                                                                                   |

## 1. 现状痛点（会话压缩包 68c427f3 实证）

1. H3 无 agentic 管线：`prompt_author(target=h3)` = 单 LLM intent + 确定性编译。用户要 NSFW 5 秒视频提示词 → agent 被迫绕过工具，手写 shots JSON + 自建 headless harness 直调编译路径（模块路径错误两次）。
2. `h3-rating-gate` safe-only 硬拒：MiniMax 官方政策与用户高频 NSFW 需求冲突，无降级路径（D-U4 裁决不设防）。
3. 无多镜头能力： Beat 拆分/连续性/工作流路由（t2v/i2v/ref2v）完全缺位——三个参照项目（director-suite/leos 六部门/short-drama-factory）的核心价值均在插件外。

## 2. 参照项目借鉴面

| 项目                      | 借鉴                                                                                                                   | 不采纳                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| minimax-h3-director-suite | Beat 按信息变化拆分（非固定切段）；镜头轴线/空间地标；道具状态台账；工作流路由（Ref2VA/T2V/FL2VA）；工程目录三件套思想 | ComfyUI 本地 runner/抽帧质检（D-U3 范围外） |
| leos 六部门               | 六导演角色 → 五槽位合并映射；逐镜审稿覆盖矩阵；提示词版本/Take 追溯思想（→ continuity_ledger + audit 留痕）            | 六个独立 agent（成本）；现场制片管理        |
| short-drama-factory       | 机检脚本思想（结构校验非艺术评价）；台账先行                                                                           | 剧本生成层（明确超范围）                    |

## 3. 总体架构

**入口路由（显式定案，沿 anima 不向后兼容先例）**：`prompt_author { target: "h3", script: <剧本文本|文件路径>, project?: <工程名> }` 即路由到本 directing 编排器，为 h3 **唯一路径**；旧 h3 shots 直译路径移除（回滚 = revert 提交）。`minimax_scenario`（官方场景模板探索/dry_run）保留不动——其产出可作为 S2 的参考输入而非替代。

```
        │
        ▼
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

## 4. DirectingIR 数据契约（= storyboard.json 落盘 schema）

```
{
  meta: { title, source_script_hash, created_at, dialect: "h3", rating, original_rating },
  characters: [{ id, name, appearance_lock, wardrobe, notes }],
  locations:  [{ id, name, spatial_landmarks }],
  props:      [{ id, name, state_by_beat: { beatId: state } }],
  beats: [{
    id: "B01",
    purpose,                              // 本 Beat 信息变化/戏剧目的 ≤2 句
    location_id, character_ids,
    shots: [{
      id: "B01-S1",
      duration_seconds,                   // 按 Beat 节奏分配
      stage: "t2v" | "i2v" | "ref2v",
      route_reason,                       // stage 选择理由（一致性需求）
      reference_plan: { characters, location_id, props },
      direction: { performance, staging, cinematography,
                   dialogue: { speaker, line, addressee } | null, micro_performance },
      anchor,                             // 末帧锚点（跨镜衔接依据）
      prompt: { text, token_count } | null,
      audit: { gates: [...], findings: [...], verdict } | null
    }]
  }],
  continuity_ledger: [{ check, beat_span, status, note }]
}
```

- 工程输出物（`temp/prompt-master/<project>/`）：`storyboard.json`、`prompts/B01-S1.txt`、`continuity-ledger.json`
- schema 机器校验（沿 blueprint/schema 手写校验模式）；部分产出可交付：storyboard 恒为合法 JSON（prompt 可为 null）

## 5. 五槽位 LLM 契约

提示词格式沿用统一模板（`<task_persona>`（角色+工具协议+few-shot）→ 数据块 → `<rules>` → `<output_contract>` + 自动反注入）。

| 槽位                       | 工具                      | 输入 → 输出                                                                          | 关键纪律                                                                          |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| S1 `pm-script-analyst`     | 无                        | 剧本 → ScriptIR JSON                                                                 | 台词原文不改写；appearance_lock 必填                                              |
| S2 `pm-beat-director`      | catalog_search            | ScriptIR → beats[]（direction/stage 路由/reference_plan/anchor/道具状态登记）        | Beat 按信息变化拆分；stage 必给 route_reason                                      |
| S3 `pm-shot-writer`        | catalog_search            | Beat 方案 → 官方结构提示词（integrated_multimodal_description + overall_soundscape） | 台词逐字保真；仅本镜；token 预算自觉（机检兜底）                                  |
| S4 `pm-continuity-auditor` | catalog_search + 机检结果 | 逐镜语义审计 + 工程级跨镜连续性                                                      | 三维度：画面保真/连续性/预算合规；verdict+findings 契约同 anima auditor；每镜必跑 |
| S5 `pm-shot-repairer`      | catalog_search            | findings → 受影响镜头修复版                                                          | 最小改动；蓝图冻结（DirectingIR beats 方案不可变，只修 prompt）                   |

两段式确认：S2 方案产出后默认自动进入 S3；`await_user_approval: true` 参数支持人工确认模式（方案产出后挂起等用户确认）。

## 6. 双轨审核与连续性机检

- 机器门（零 LLM）：`rules-h3.ts` 机检复用（镜头信息增量/cut 时间戳/台词原文比对）+ tokenizer 精确预算 + DirectingIR schema 校验 + **连续性台账机检**（props.state_by_beat ↔ 逐镜 prompt 状态词匹配、anchor 非空与衔接完整性、stage 路由合法性枚举）
- LLM 轨：`pm-continuity-auditor` 每镜必跑（A3 语义沿袭：废除 critical 跳审）+ 工程级跨镜审查一次；故障 → 仅机器门降级
- NSFW 不设防（D-U4）：`h3-rating-gate` 在新管线不调用；rating 元数据透传；`original_rating` 若与 MiniMax safe 档不一致仅在 meta 标记，不改写要素

## 7. 错误处理与降级

| 失败点              | 语义                                                    |
| ------------------- | ------------------------------------------------------- |
| S1/S2 失败/解析失败 | fail-fast 显式错误（上游是根，不空手编故事）            |
| S3 单镜失败         | 该镜 `prompt: null` 进审计，不阻塞其他镜                |
| S4 LLM 故障         | 仅机器门降级（advisory 留痕）                           |
| S5 耗尽（≤2 轮/镜） | 保留最后产物 + `loop_exhausted`                         |
| 部分产出            | storyboard 恒为合法 JSON；增量重跑 = 只重跑 null/违规镜 |

## 8. 测试策略与不变式

- 纯函数 TDD：DirectingIR schema 校验、连续性台账机检（道具状态匹配/anchor 衔接）、tokenizer 预算边界、stage 路由合法性
- 编排器全 mock：happy path（3-Beat 迷你剧本 golden）/ 单镜失败不阻塞 / 修复循环 / S4 降级 / 两段式确认模式
- **不变式**：anima 全量测试零改动零失败；`dialect/h3.ts` 编译契约零改动；rules-h3 复用不修改；`camera-video` 三 stage 工具为下游消费者不改动

## 9. 明确不做（本轮）

- ComfyUI 执行/低清测试/抽帧质检/选择性重试闭环（D-U3，后续 spec）
- 剧本从零生成（short-drama-factory 层超范围；输入 = 已有剧本）
- 向量库重建（anima 侧遗留，独立计划）
