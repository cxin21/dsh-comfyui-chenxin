# 创作蓝图 IR 重构设计（Blueprint IR Redesign）

> 日期：2026-09-07
> 状态：草案（待用户评审）
> 关联文档：`2026-08-31-redesign-spec.md`、`architecture.md`、`2026-08-31-e2e-session-analysis.md`
> 范围：plugins/prompt-master —— 在现有插件上做架构升级，不重写正确骨架

---

## 1. 背景与目标

### 1.1 用户诉求（原文提炼）

需要**一个可扩展适配不同生图生视频模型的提示词生成插件**，核心能力三件事：

1. **分析意图**：把用户的模糊创作意图拆成结构化创作蓝图（角色/场景/叙事/风格/镜头/情绪）
2. **扩展意图**：在蓝图骨架上丰富细节——具体名词化、按美学 ROI 补全、注入风格
3. **生成极具美学和高质量的提示词**：产出适配目标模型方言、过审计、可直接投喂的提示词

附加约束（用户明确）：**在现有 prompt-master 插件基础上优化重构**，很多功能与逻辑现有插件已满足；使用形态为 **DSH agent 会话内**；风格为**综合风格库按需选择**；模型适配**现有 Anima + H3 优先，架构上不设限**；意图处理**以结构拆解为骨干，支持增量修改**。

### 1.2 现状（已读源码确认）

| 模块 | 现状 | 判定 |
|---|---|---|
| 方言注册表 `DialectContract{normalize,compile,audit,budget,intent}` | 多模型适配骨架 | ✅ 保留，升级为「方言包」 |
| `runStage` 管线内核（normalize→compile→audit→budget→Envelope） | 正确内核 | ✅ 不动 |
| Envelope（ok/audit.gates/budget/advisories/target_slot_hint/observability） | 统一输出 | ⚠️ 加 `next_action` |
| Profile 体系（56+：expand/reverse/train/minimax 场景/torii） | 风格库种子 | ⚠️ 升级为分层风格库 |
| 知识资产（anima tags.sqlite 213MB + tag-catalog 816MB、H3 官方 tokenizer） | 知识底座 | ✅ 复用 |
| intent 子代理（persona+schema 方言化，继承父路由，60s 超时） | 意图分析种子 | ⚠️ 升级为「蓝图分析器+扩展引擎」 |
| `continue/engine.ts`（保留已写文本、只补缺失） | 增量续写 | ⚠️ 复用模式到增量修正 |
| `model-capabilities`（temperature/truncation/mediaTargets） | 模型能力表 | ⚠️ 扩展进方言包 |
| 审计体系（contract gates + text gates + official-tokenizer budget） | 确定性校验 | ⚠️ 语义闸门分层 + CJK 修复 |
| Anima `exclusions?: string[]` 字段 | 负向意图种子 | ✅ 直接利用 |
| golden fidelity + parity 测试 | 回归基线 | ✅ 保留 |

### 1.3 会话事故复盘（session-34706f38，实证）

用户「3 分镜 × 5 秒打斗 CG」的完整失败链：

```
prompt_author(t2va) → ❌ shot_execution 误报（CJK 语义判空）+ loop_exhausted，85s 白烧
prompt_compile(duration=5, 3 shots) → ❌ max_shots 契约违例（duration 语义二义）
模型错误归因「5s 最多 2 镜，必须拆三段」→ 3× 单镜 compile ✅ → 交付 3 段不连续 prompt
```

根因：语义闸门伪确定性（CJK 误报）+ duration 语义未显式化 + 约束靠试错 + 失败无指引。本次重构的 Phase 1 必须全部解决。

---

## 2. 第一性原理问题清单（18 项全覆盖矩阵）

提示词生成本质 = **意图→方言翻译**，5 个正交要求：保真、可编译、可接受、可执行、可演进。落在**确定性轴**（可判定）与**语义轴**（不可判定）两轨；核心错误是把语义轴启发式当确定性硬闸门。

| # | 问题/缺陷 | 来源 | 对策 | 模块 |
|---|---|---|---|---|
| 1 | CJK 语义误报（`semanticShot` ASCII-only，中文全判空） | 会话实证+源码 | 语义闸门降级 advisory；确定性闸门才 critical | audit 分层 |
| 2 | `duration_seconds` 语义二义（总时长 vs 每镜） | 会话实证 | schema/persona/工具描述三处显式化 | 蓝图 schema + 方言包 |
| 3 | 约束靠试错、无 preflight | 会话实证 | 方言包能力约束表 + preflight | 方言包 |
| 4 | 失败语义不可操作 | 会话实证 | Envelope 加 `next_action` | Envelope |
| 5 | 修正回环无状态重来 | 源码 | 蓝图结构化反馈→只修失败字段 | 增量修正引擎 |
| 6 | 工具面 10 个、路由负担 | 源码 | 收敛：author=全链入口，compile/audit 辅助 | 工具面 |
| 7 | 意图只拆不扩展 | 用户要求 | 分析→v0，扩展引擎→v1 | 扩展引擎 |
| 8 | 无负向意图入口 | 反思盲区 | `negative[]` 进蓝图；投影映射 | 蓝图+投影器 |
| 9 | 无角色一致性 | 反思盲区 | 角色卡：外观锚点/服装/道具/标志物 | 蓝图 characters[] |
| 10 | 无多模态意图提取 | 反思盲区 | 参考图/视频美学特征提取（Phase 2） | 意图分析器 |
| 11 | 风格库平铺 | 反思盲区 | 风格库分层：基底/主题/情绪 | 风格库 |
| 12 | 风格一致性与创新无调节 | 反思盲区 | `conformity` 参数 | 扩展引擎 |
| 13 | 评估无闭环 | 反思盲区 | 契约审计+具体性自检+LLM 评委 | 评估层 |
| 14 | 无 LLM 调用预算 | 反思盲区 | 每任务 LLM 上限 + 纯规则路径 | 管线 |
| 15 | 蓝图 schema 版本化 | 反思盲区 | IR schema 版本号+迁移 | 蓝图 |
| 16 | 方言许可证 | 本地 manifest | 方言包携带 license 声明 | 方言包 |
| 17 | 测试金字塔错位 | 反思盲区 | 意图→蓝图契约级测试（非字节级） | 测试层 |
| 18 | duration/分镜数可算约束 | 第一性原理 | 确定性预修（算出来直接改，不花 LLM） | 增量修正引擎 |

---

## 3. 设计原则（全部有事实依据）

| 原则 | 依据 |
|---|---|
| 分层 IR：公共创作核 + 媒介维度层 | 调研二：各模型意图字段是层层包含关系（MJ 七要素 ⊂ 可灵八层 ⊃ H3 三字段） |
| 字段顺序 = 优先级 | 调研二：可灵「越靠前权重越高」 |
| 美学 = 具体名词 + 禁空泛词 + ROI（光影>主体特征>运镜） | 调研二：ai-shortfilm-prompts 强制「摄影机型号+镜头型号」；可灵指南 ROI 排序 |
| 方言编译器 = 模板+约束表+预算+禁忌+few-shot | 调研二 B6 方言包封装清单 |
| 结构化输出作 IR（JSON Schema），再按模型渲染 | 调研一：LangGPT / DSPy signature 共识 |
| 审计失败带 code+位置+修复建议回喂重试 | 调研一：instructor reask 模式 |
| eval = 契约审计 + 具体性自检 + LLM 评委（+可选 CLIP/aesthetic） | 调研二 A3：LAION aesthetic-predictor / Gemini 指标模板 |
| 意图→蓝图用契约级测试而非字节级 | 反思 17：LLM 环节不可字节断言 |
| 可学习方言层（可选进阶） | 调研二：Promptist/TIPO 证明「方言偏好可学习」 |

---

## 4. 总体架构

```
用户意图 (+参考图/视频)
  ↓ [分析] intent 分析器（LLM 子代理）
  │      → 蓝图 IR v0：结构拆解（保留事实、标记缺失维度）
  ↓ [扩展] 美学化扩展引擎（LLM + 风格库 + 词库）
  │      → 蓝图 IR v1：具体名词化 + 禁空泛词 + ROI 补全 + 风格注入 + 负向 + 角色卡锚点
  ↓ [投影] 方言投影器（deterministic，非 LLM）
  │      → anima.slots / h3.shots（复用现有方言输入形状）
  ↓ [编译] 现有 runStage（方言编译 + 契约审计 + budget）→ Envelope(+next_action)
  ↑ [反馈] 审计失败 → 结构化反馈 → 增量修正（确定性预修 → LLM 只修失败字段 → advisory 降级）
```

**架构边界（严格）**：
- **新增**：`pe-framework/blueprint/`（schema+投影器+增量修正）、`pe-framework/enrichment/`（扩展引擎+风格库接口）、`pe-framework/aesthetics/`（词库+具体性自检）、`pe-framework/eval/`（自检+评委）
- **升级**：`pe-framework/dialect/`（方言包规范）、`pe-framework/audit/`（语义分层+CJK 修复）、`render/envelope.ts`（next_action）、`tools/`（路由收敛）
- **不动**：`runStage` 内核、现有方言编译逻辑（`dialect/anima.ts`、`dialect/h3.ts` 的 compile/audit/budget 主体）、golden 测试基线

---

## 5. 创作蓝图 IR（核心新资产）

### 5.1 Schema（v1，字段顺序即优先级）

```ts
interface BlueprintV1 {
  schema_version: 1
  media: 'image' | 'video' | 'mixed'
  core: {
    concept: string          // 一句话主题（必填，用户原意压缩）
    aspect_ratio?: string    // 画面比例（16:9/9:16/1:1/4:3/3:4；复用现有 ASPECT_COMMON）
    characters: Character[]  // 角色卡（可空；支撑跨镜头/跨次一致性）
    scene: Scene             // 场景（环境/时间/光线/氛围）
    style: StyleRef          // 风格引用（基底/主题/情绪/配色）
    emotion: string          // 情绪基调（冷峻/温暖/压抑…）
    composition: string[]    // 构图语言（三分法/对称/负空间/前景引导）
    negative: NegativeConstraint[]  // 负向意图（结构化约束：对象+属性）
    narrative?: string       // 自由叙事文本（保留用户原话）
  }
  media_layer: {
    video?: {
      total_duration_seconds?: number  // 视频总时长（H3 官方契约 4–15s，唯一权威值）
      shots: Shot[]          // 分镜序列（结构对齐影视 shot list 标准列，见 Shot）
      pacing?: string        // 节奏（渐强/平缓/骤停）
      audio?: string         // 全局声景（非 diegetic 音乐基调）
    }
    image?: {
      lighting_detail?: string  // 光照细节（伦勃朗光/黄金时刻/体积光）
      focal_length?: string     // 焦段（24/35/85mm）
      depth_of_field?: string   // 景深
      camera_angle?: string     // 机位角度
    }
  }
}

interface Character {
  id: string
  name?: string
  appearance_anchors: string[]  // 识别锚点（脸型/发型/瞳色/体型/肤色）— 必须"可见、可生成、可比较"
  outfit?: string
  props?: string[]
  distinctive?: string          // 标志物（胎记/伤疤/纹身/特征配饰）
  reference_slots?: string[]    // 参考图槽位（正脸/全身/表情 → <Picture N> 绑定）
  variant?: string              // 变体状态（服装换装/伤势/时段变化）
  continuity_lock?: boolean     // 连续性锁（该角色跨镜头必须严格一致，禁止漂移）
}

interface Scene {
  environment: string           // 环境（具体名词）
  time?: string                 // 时间（黄昏/夜晚/正午）
  lighting?: string             // 光线基调
  atmosphere?: string           // 氛围
}

interface StyleRef {
  base?: string                 // 基底风格：媒介/画风（写实电影/赛璐璐/厚涂）
  theme?: string                // 主题风格：赛博朋克/和风/废土（影响场景+配色）
  palette?: string              // 情绪配色：青橙对比/低饱和/高饱和
}

interface Shot {
  beat: string                  // 情节节拍（这镜在干什么）
  shot_size?: string            // 景别（CU/MCU/MS/FS/WS，对齐影视 shot list 标准）
  camera_angle?: string         // 机位角度（高/低/平/过肩/俯拍）
  camera?: string               // 运镜（dolly/pan/tracking/orbit/crane/handheld）
  action?: string               // 动作细节（具体名词，识别锚点须可生成可比较）
  dialogue?: string             // 对白（可空）
  audio_focus?: string          // 音效焦点
  music?: string                // 音乐情绪
  duration_seconds?: number     // 分镜时长（视频总时长 = Σ shots 或显式 total）
  who?: string[]                // 涉及角色 id（→ <Subject N> 稳定标签，见 §5.2-5）
  remark?: string               // 备注（连续性要求/特效/特殊说明，对齐影视 shot list 备注列）
}

interface NegativeConstraint {
  target: string                // 负向对象（"文字"/"现代元素"/"血腥"）
  attribute?: string            // 属性限定（如 "文字：字幕/水印/LOGO"）
  severity?: 'soft' | 'hard'    // hard=内容安全类（直接过滤/拒绝）；soft=美学类（折进正向或映射 negative）
}
```

### 5.2 关键语义决策

1. **`duration_seconds` 歧义消除**：蓝图里显式双字段——`media_layer.video.total_duration_seconds`（视频总时长，对应 H3 官方契约 4–15s，唯一权威值）与 `shot.duration_seconds`（每镜时长，仅作切分建议）。方言投影器负责转换：`h3.duration_seconds = total`；分镜时间戳按 `total/Σshot` 或用户显式切分计算。persona/schema/工具描述三处同步注明。
2. **角色卡锚点**：`appearance_anchors` 是跨镜头一致性的文字锚（发型/瞳色/服装/标志物），投影到 h3 时进入 `what` 描述首句与 `who`，进入 anima 时映射 `character/appearance/clothing`。
3. **负向意图三档适配**（方言投影器内做，不依赖 LLM；调研三支持矩阵）：
   - **档 1 有 native negative**（SD/SDXL `negative_prompt`、可灵 `negative_prompt`、MJ `--no`）→ 直接映射方言 negative 字段/参数
   - **档 2 无 native**（Flux、H3、即梦）→ **正向改写**（"无字幕"→"纯净画面无文字界面"；"无眼镜"→"素颜"）+ advisory 提示，不堆负向词污染画面
   - **档 3 LLM-encoder 模型**（Z-Image/Anima/Krea2）→ 语义正负短语，**只用符号不用权重**（权重被忽略，NegPiP 实测）
   - 内容安全类（severity='hard'）→ 直接过滤/拒绝（沿用现有 joy-extra 硬约束）
4. **语言策略（澄清定案）**：投影器是 deterministic 纯函数、**不承担翻译**。蓝图语言跟随**目标方言 output_lang**——H3 蓝图用中文、Anima 蓝图用英文 tag；由分析器/扩展器（LLM）按目标方言语言产出蓝图。保真例外：`core.concept`/`core.narrative` 保留用户创作语言原字面（可双语并存），投影时方言编译层按现有 `buildTextZh` 骨架渲染（H3）。
5. **角色引用解析**（调研三 drama-skills 范式）：`Shot.who: string[]` 存**角色 id**；方言投影时按 `Character.reference_slots` / 用户 references 顺序映射为 `<Subject N>` 稳定标签。识别锚点（`appearance_anchors` + `distinctive`）必须**可见、可生成、可比较**——不用空泛质量词；`continuity_lock: true` 的角色跨镜头强制注入锚点并审计（防漂移）。
6. **保真-扩展边界**（设计张力定案）：
   - **不可改写（原字面保留）**：`concept`、`narrative`、用户给出的具体描述词（进入蓝图原样）
   - **可扩展改写**：缺失维度的补全（风格/光影/镜头/构图）、空泛词的具体名词化——但用户原词必须出现在 v1 的某字段（保真守卫 §6 强制）
   - 扩展引擎输出的每个改写点记录在 `observability.expansions[]`（用户可审计"哪里被扩展了"）

### 5.3 Schema 版本化

- `schema_version` 必填；升级策略：v1 只做**字段新增**（向后兼容），v2+ 才允许重命名/删除，且带迁移函数 `migrateBlueprint(v, from)`。
- 历史蓝图可存储（复用现有 `settings` / `custom_profiles` 存储机制），支持「取回旧蓝图改一字段重投影」。

---

## 6. 意图分析器（分析阶段：意图 → 蓝图 v0）

- **复用**：现有 `createSubagentIntentProvider`（DSH one-shot 子代理，继承父路由，60s 超时）与 `parseIntentJson` 模式。
- **新 persona 规则**（替代现有 ANIMA_PERSONA/H3_PERSONA 的直接方言拆解）：
  1. 产出**蓝图 v0**（见 §5 schema），不是方言输入
  2. **保留事实**：用户给的具体描述原字面进入蓝图（concept/narrative/角色锚点），不编造情节
  3. **标记缺失**：蓝图字段可空；分析器显式标记「缺失维度」（如无风格 → style 空 + missing 列表）
  4. **多模态**：references 传入时提取参考物美学特征（Phase 2 完整；Phase 1 至少保留标签稳定）
- **输出形状**：蓝图 v0 JSON + `missing: string[]`（供扩展引擎与用户可见）。
- **澄清环节**（agent 会话内，F 问题定案）：`missing` 维度分两级处理——
  - **关键缺失**（风格/媒介/负向边界，影响产出方向）：可配置 `clarify: 'ask' | 'auto'`；默认 'auto'（交给扩展引擎补全），'ask' 时返回 `clarify_questions` 供 agent 用 `ask_user_question` 追问（对齐 preset AGENTS.md「创意方向未定→停下来问」规则）
  - **次要缺失**（光影/构图/细节）：直接进扩展引擎补全，不打断
- **保真守卫**：投影前对比「用户关键词覆盖」——用户原文里的核心实体必须出现在蓝图某字段（缺失即视为意图丢失，advisory 报警）。这是对「分析意图」的质量下限。

---

## 7. 美学化扩展引擎（扩展阶段：蓝图 v0 → v1）

### 7.1 扩展规则（确定性规则 + LLM 协作）

| 规则 | 类型 | 做法 |
|---|---|---|
| 具体名词化 | LLM | 空泛形容词→可感知名词（「电影感」→「IMAX 胶片机 + Panavision C 系 35mm f4」） |
| 禁空泛词 | 确定性 | 禁词表（cinematic/beautiful/amazing 等）扫描，命中→退回扩展 |
| ROI 补全 | LLM | 按优先级补缺失：光影 > 主体特征 > 运镜 > 环境细节 > 风格 |
| 风格注入 | 确定性+LLM | 用户选风格→风格模板片段注入对应字段 |
| 负向补全 | LLM | 从用户语境推断合理负向（如「无现代元素」）→ `negative[]` |
| 角色卡锚点补全 | LLM | 同一角色跨镜头时补齐锚点字段 |
| 质量自检 | 确定性 | 输出前过「具体性检查」（含可感知名词比例、禁词、字段完整度） |

### 7.2 风格库（分层；Phase 1 最小可用 → Phase 2 内容深化）

- **基底风格**（媒介/画风）：写实电影、游戏 CG、赛璐璐、厚涂、水彩、概念原画…
- **主题风格**（场景+配色耦合）：赛博朋克、和风、废土、暗黑史诗、童话…
- **情绪调色板**：冷峻、温暖、压抑、燃、静谧…
- 每风格 = `{id, name, base?, theme?, palette?, prompt_fragments: {image, video}, applies_to: ModelId[], negative_hints[]}`。
- **Phase 1 最小风格库 v0**（满足用户「按需选择」）：内置 **8 个常用风格**（写实电影/游戏 CG/赛璐璐/厚涂/赛博朋克/和风/废土/暗黑史诗），来源=现有 `expand_cinematic`/`expand_photographer` profile system prompt + 调研二风格参考；用户可在 `prompt_author` 传 `style_id` 或在蓝图 `core.style` 指定。Phase 2 扩充到 50+ 并做内容化治理。
- **conformity 参数**（0–1）：0=完全按模板，1=完全自由（LLM 自由度调节），默认 0.6（Phase 1 就带，Phase 2 完善语义）。
- **来源**：调研二的开源风格库参考（comfyui-llm-prompt-enhancer 50+ 风格、midjourney-prompt-generator）；现有 `expand_cinematic`/`expand_photographer` profile 的 system prompt 可作种子。

### 7.3 电影摄影词库（aesthetics/）

- 镜头：景别/焦段/运镜词表（调研二：可灵运镜词汇表、Veo 运镜库）
- 光线：黄金时刻/伦勃朗光/体积光/色温/三灯布光
- 色彩：色彩分级模板（高光/中间调/阴影 + 青橙对比，ai-boost/awesome-prompts）
- 构图：三分法/对称/负空间/前景引导/画中画
- 形态：词库为**结构化数据**（非 LLM prompt），供扩展引擎引用。

---

## 8. 方言投影器（IR → 方言输入，deterministic）

纯函数，输入蓝图 v1，输出**现有方言输入形状**（slots/shots），因此 runStage 与方言编译零改动。

### 8.1 IR → H3 映射表

| 蓝图字段 | H3 输入 |
|---|---|
| `media_layer.video.total_duration_seconds` | `shots.duration_seconds` |
| `media_layer.video.shots[].beat+action+shot_size+camera` | `shots[].what`（镜头语言合并进描述，保留时间戳结构） |
| `shots[].who` → character 锚点 | `shots[].who`（`<Subject N>` 稳定标签） |
| `shots[].audio_focus` | `shots[].ambient` |
| `shots[].music` / `media_layer.video.audio` | `shots[].music` / `overall_soundscape` |
| `shots[].dialogue` | `shots[].dialogue`（`<d>[语言] 文本</d>`） |
| `core.negative`（NegativeConstraint[]） | 三档适配：档 1 映射 negative 字段；档 2 正向改写进 `what` 末句 + advisory；档 3 语义正负短语 |
| `core.style`+`emotion`+`scene.lighting` | 并入各 shot 的 `what`（按 ROI 排序） |
| references | `shots.references`（原样传递） |

### 8.2 IR → Anima 映射表

| 蓝图字段 | Anima 输入 |
|---|---|
| `characters[].appearance_anchors` | `appearance[]` |
| `characters[].outfit` | `clothing[]` |
| `characters[].reference` | `character[]`（`Subject N from <Picture N>`） |
| `scene.environment` | `scene[]` |
| `scene.lighting` + `media_layer.image.lighting_detail` | `detail_mood[]` |
| `media_layer.image.focal_length/depth_of_field/camera_angle` | `camera[]` |
| `composition[]` | `detail_mood[]` |
| `core.negative`（NegativeConstraint[]） | `exclusions[]`（soft 类映射；hard 类已提前过滤） |
| `core.narrative` | `narrative` |
| `core.style.base/theme` | `detail_mood[]`（风格 tag） |

### 8.3 投影一致性测试

- 每个投影器配**契约级单元测试**：给定蓝图 fixture → 断言输出形状、关键字段存在、负向三态正确。
- **防漂移回归**：同蓝图 → 各方言输出做快照 diff（沿用 golden 机制）。

---

## 9. 方言包规范（DialectContract 升级）

现有 `DialectContract` 扩展为方言包声明：

```ts
interface DialectPackage extends DialectContract {
  capabilities: {
    native_negative: boolean       // 有无独立负向框
    supports_audio: boolean        // 音频/台词语法
    supports_dialogue: boolean
    camera_axes: number            // 运镜轴数
    media_targets: ['image'|'video'|'mixed']
    aspect_ratios: string[]
    duration_range: [number, number]  // 秒
    max_shots_formula?: string     // 如 '1+floor((d-1)/3)'
    max_prompt_chars: number
    budget_quality_cap: number     // 每 stage token 上限
  }
  constraints: {                   // preflight 用的确定性约束表
    validate(input): AuditGate[]   // 现有 contractGatesH3 移入
  }
  aesthetics: {
    forbidden_words: string[]      // 禁词（Flux 禁 tag、可灵忌 fast…）
    few_shot_examples: Array<{input, output}>
    style_hints: string[]
  }
  license: { id, url, territory_restrictions? }
}
```

- **preflight 工具**：`prompt_compile` 增加 `preflight_only` 参数（或新工具），只跑 `constraints.validate` 不调 LLM——agent 先验边界再投 LLM 成本（对应问题 #3）。
- H3 方言包能力：native_negative=false、duration 4–15s、max_shots 公式、max_prompt_chars 7000、quality caps（t2va 1200/i2va 1500/fl2va 1700/l2va 1700/ref2va 2400）——全部从现有 `schema/h3-shots.ts` + `audit/budget.ts` 常量提取，不臆造。
- license：H3 从 `assets/knowledge/minimax-h3-prompt/manifest.json` 提取（MiniMax-H3-Community-License，Applicable Territory 限制）。

---

## 10. 审计语义分层 + CJK 修复

### 10.1 分层原则

- **确定性闸门（critical）**：契约类（parse_request/max_shots/ref_count/field_order/cut_timestamps/char_budget/预算）——机器可判定，必须 fail。
- **语义闸门（advisory）**：启发式类（shot_execution「无新信息」、语义重复）——不可判定，只提醒不阻断。
- 修正回环只对 critical 触发；advisory 进 Envelope advisories（agent 可自行判断）。

### 10.2 CJK 修复（问题 #1 根因）

`semanticShot(text)` 现用 `/ [a-z0-9]+/g` 抽 ASCII，中文返回空串 → 相邻分镜恒等 → 必然误报。修复：

1. **弃用字符启发式**：改为「先按方言文法解析出 shot 结构，再逐单元审计」——shot 文本按分镜边界切分（已存在 `parseShots`），对单元做**分镜间差异判定**。
2. **CJK 感知的差异度量**：中文场景用字符 n-gram 集合相似度（Jaccard），阈值可配；低于阈值 → 判「无新信息」advisory。
3. **回归测试**：`tests/plugin/h3-audit.test.ts` 补「中文多分镜不误报」用例（本次事故在现有测试全绿，这是教训——必须补）。

---

## 11. Envelope 扩展：`next_action`

```ts
interface EnvelopeV2 {
  ok: boolean
  result?: ...
  audit: {...}
  advisories: string[]
  next_action: 'retry_input' | 'auto_repair' | 'manual' | 'advisory_only' | 'ok'
  // 新增：失败时给 agent 可执行的下一步指引
  repair_hints?: Array<{ field: string; fix: string }>  // 如 [{field:'duration_seconds', fix:'改为 15（总时长）'}]
  observability: {...}
}
```

- `retry_input`：入参错误（duration 越界、分镜超限）→ 附 repair_hints
- `auto_repair`：引擎已自动修复（确定性预修成功）→ 附修复记录
- `manual`：LLM 修复也失败（loop_exhausted）→ 建议人工，附失败原因与最后蓝图
- `advisory_only`：ok=true 但带 advisory
- 联动 preset `AGENTS.md` 错误恢复表（catalog_build_failed/audit critical gates 等条目更新为读 next_action）。

---

## 12. 增量修正引擎（替代无状态重来）

三级递进，LLM 调用预算内：

```
Level 1 确定性预修（零 LLM）：
  duration 越界 → 算合法区间建议；分镜超限 → 建议合并/加时长；
  ref 数不匹配 → 报错 hint。规则来自方言包 constraints（纯函数，可测）。
Level 2 LLM 结构化修复（≤1 次）：
  蓝图 v1 + 审计 findings（code+字段+位置+修复建议）→ 只重写失败字段（复用
  continue/engine.ts 的「保留已写、只补缺失」模式）→ 重投影。
Level 3 advisory 降级：
  仍失败 → next_action='manual'，输出最后蓝图 + 失败原因 + 已尝试的修复。
```

- 反馈结构化：`{gates:[{rule, severity, field, position, fix, suggestion}]}`（对应调研一 instructor reask 模式）。
- 修正粒度：**字段级**（蓝图是结构化对象，天然支持），不再是「整份重生成」。

---

## 13. 评估闭环（eval/）

| 层级 | 工具 | 触发 |
|---|---|---|
| 契约审计 | 现有 audit（critical 闸门） | 每次编译 |
| 具体性自检 | 确定性：禁词扫描 + 具体名词比例 + 字段完整度 | 每次扩展后 |
| LLM 评委（可选） | 按 rubric（coherence/fidelity/美学）打分 | 用户要求或 eval 模式 |
| 生成级（可选，Phase 3） | LAION aesthetic-predictor / CLIP-Score（对生成结果） | 接 camera-* 后 |
| 用户 A/B（可选） | 两个版本蓝图并排选优 | 用户要求 |

- 回归集：把本次事故案例（中文 3 镜打斗）作为固定 eval 用例——「分析→扩展→投影→审计」全链必须在 eval 模式下通过。

---

## 14. 工具面收敛

| 工具 | 定位（重构后） |
|---|---|
| `prompt_author` | **唯一全链入口**：意图→蓝图→扩展→投影→编译→Envelope(+next_action) |
| `prompt_compile` | 确定性编译 + preflight（无 LLM） |
| `prompt_audit` | 裸文本审计（保留，detail 加引导） |
| `prompt_expand` / `prompt_reverse` / `minimax_scenario` / `profile_list` | resolver 族保留（扩写/反推/场景，与蓝图无关的独立能力） |
| `catalog_*` | 保留（知识资产管理） |

- intent 子代理瘦身：prompt 去掉技能目录噪音（子代理 trace 显示它曾纠结「要不要调 skill」）——子代理任务纯 JSON 产出，注入最小 system。

---

## 15. LLM 调用预算

| 任务 | 预算 |
|---|---|
| 分析（意图→蓝图 v0） | 1 次子代理 |
| 扩展（v0→v1） | 1 次子代理 |
| 修正 Level 2 | ≤1 次（重投影后仍 fail 才触发） |
| 总 LLM 子代理 | **≤3 次/任务**（超出 → next_action='manual'） |
| 纯规则路径 | preflight/确定性预修/投影/审计全程零 LLM |

- 超时沿用 60s/子代理；`signal` 贯通（现有 `AbortController` 机制复用）。

---

## 16. 测试策略

| 层 | 内容 | 类型 |
|---|---|---|
| 契约级（新增） | 蓝图 schema 校验、投影器映射、负向三态、CJK 差异度量 | 确定性单元测试 |
| 引擎级（新增） | 扩展规则（具体名词化/禁词/ROI 补全）用 fixture 断言 | LLM 注入 mock |
| 回归（保留） | golden fidelity（方言编译逐字节）、parity、tokenizer | 现有 |
| eval（新增） | 事故案例全链 + 中文多分镜 | 集成 |

---

## 17. 阶段演进

### Phase 1 — 意图蓝图核（核心能力 + 修复上次会话全部痛点）

**范围**：
- 蓝图 IR schema v1 + 意图分析器 + 美学化扩展引擎（基础美学规则）
- **蓝图存储/版本化**（复用 settings/custom_profiles 机制；增量修改的前提）
- **最小风格库 v0**（8 个常用风格 + conformity 参数）——满足「按需选择」
- 方言投影器（anima/h3）+ 负向三档适配 + 角色卡（识别锚点/参考槽位/连续性锁）
- CJK 修复 + 语义闸门分层 + Envelope `next_action` + 增量修正（三级）
- 蓝图 schema 含 `aspect_ratio`（复用 ASPECT_COMMON）
- 契约级测试 + 事故案例 eval

**交付标准**：
1. `prompt_author` 全链跑通：「分析→扩展→投影→审计」一次成功
2. 上次会话案例（中文 3 镜打斗）通过审计，无 CJK 误报，duration 语义正确
3. 现有 golden 测试全绿（方言编译零回归）
4. LLM 调用 ≤3 次/任务，失败给 `next_action` 指引
5. 用户可选 8 个风格之一 → 蓝图 `core.style` 生效
6. 可「取回旧蓝图改一字段重投影」（蓝图存储可用）

**验收**：vitest 全绿 + 真会话复跑（用上次同款用户输入）。

### Phase 2 — 风格库与美学深化

**范围**：风格库分层内容化（基底/主题/情绪 + conformity）、电影摄影词库、具体性自检强化、多模态意图提取、LLM 评委评估闭环。

**交付标准**：10+ 风格模板可用；用户选风格→蓝图风格字段生效；参考图美学特征进蓝图。

### Phase 3 — 方言包规范化 + 新模型验证

**范围**：方言包规范成文、preflight 落地、接入第 3 个模型（如 Flux 图像）验证扩展路径、工具面收敛 + LLM 预算落实、许可证声明。

**交付标准**：新模型接入 = 写方言包 + 投影器即可；文档化的接入清单。

---

## 18. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 蓝图 schema v1 设计不当 → 返工 | 只做字段新增式演进；Phase 1 先用最小 schema，Phase 2 再扩 |
| 扩展引擎「过度发挥」偏离用户原意 | 保真守卫（用户关键词覆盖检查）+ 原字面保留（narrative/concept） |
| LLM 成本上升 | 调用预算 ≤3 次；确定性路径零 LLM |
| 投影器 bug 影响现有方言输出 | 投影器输出形状 = 现有输入形状，golden 测试锁死 |
| 风格库内容工作量大 | Phase 2 才做；先用现有 profile system prompt 作种子 |

---

## 19. 参考依据

- 调研一（GitHub 提示词工程框架）：guidance/outlines/xgrammar（约束前置）、DSPy/promptfoo（eval 回归）、instructor（reask 结构化反馈）、LangGPT（结构化 JSON 意图）、h3-prompt-writing/SKILL.md（方言契约文档）、ComfyUI-MiniMax-H3-Guide（编译期校验）
- 调研二（美学 × 多模型适配）：MJ Prompt Basics 七要素、可灵 3.0 八层框架、H3 官方写作指南、Veo 3 官方指南、ai-shortfilm-prompts（摄影机型号强制）、LAION aesthetic-predictor、Promptist/TIPO/NegOpt、PromptBridge
- 调研三（意图 IR 行业参照 × 角色一致性 × 负向工程）：StudioBinder shot list 标准列（镜号/景别/机位/运镜/动作/对白/音效/时长/备注）、screenplay/model sheet、drama-skills（五文档流水线 + REF 参考槽位语法 + 识别锚点/连续性锁）、Jellyfish（角色中心化防漂移）、ArcReel/Toonflow（剧本→分镜→视频）、InstantID/PhotoMaker/IPAdapter/AnimateDiff（角色一致性技术谱系）、NegPiP（LLM-encoder 负向只认符号）、Flux 无原生 negative（flux#188）
- 本地源码：`src/pe-framework/dialect/*`、`src/pe-framework/audit/rules-h3.ts`、`src/pe-framework/pipeline/runStage.ts`、`src/pe-framework/intent/subagent-provider.ts`、`src/pe-framework/continue/engine.ts`、`src/tools/prompt-author.ts`、`src/tools/prompt-compile.ts`、`src/plugin/index.ts`
- 资产：`assets/knowledge/minimax-h3-prompt/manifest.json`（license）、`assets/knowledge/anima-prompt-v1/`（tag 目录）
