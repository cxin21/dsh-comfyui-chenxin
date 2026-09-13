# 默认路径蓝图形态迁移设计稿（M5 T1）

**日期**：2026-09-13　**状态**：草案（待 T1R 评审）
**读者**：T2/T3/T4 实现者与评审——本文验收线 = 「能否据此直接写 T2/T3/T4 实现契约」
**关联**：`docs/plans/2026-09-13-style-aesthetics-m5.md`（计划）、`docs/plans/2026-09-13-style-aesthetics-m5-candidates.md`（立项）、`docs/2026-09-07-blueprint-ir-design.md`（蓝图 IR spec，下称 spec §N）、P0 修复 2b4c245
**范围**：docs-only，零实现。所有行号以本文撰写时工作树为准（HEAD 36e80c8）。

---

## 0. 结论摘要（决策表）

| # | 决策 | 定案 | 一句话理由 |
|---|---|---|---|
| D1 | 路由切换点 | **dialect registry `intent.form` 形态标志**（否决硬切） | 数据驱动、单读取点、自带回滚面；h3 后续迁移翻自己的标志即可 |
| D2 | anima 蓝图 schema | **新增 ANIMA 蓝图 persona/schema 模板**（image 形态）+ parse 层 `expectedMedia` 守卫；`validateBlueprint` 本体零改动 | BLUEPRINT_SCHEMA 是 video 硬编码模板；validateBlueprint 对 image 已弹性（§2.2 核验） |
| D3 | IR 适配 | **media_layer.image 增补 4 个可选字段**（count_gender/pose_action/expression/scene_anchors），spec §5.3 允许 v1 字段新增 | projectToAnima 现状无人数/动作/表情来源——主干槽位塌陷（§2.3） |
| D4 | 扩展层取舍 | **runEnrich 退出 anima 默认路径，enrichBlueprint 顶上**（blueprint_id 路径形态 = 迁移后默认形态） | spec §4/§8 字面流无 brief 层；蓝图 core 字段结构上覆盖七维 brief；LLM 调用数首轮持平 |
| D5 | 修复轮 | **三合一**：`anchorBlueprint` 增量锚定 + provider 返回后统一 core.rating 重注入 + validate 失败单次反馈重试 | 现状修复轮在生产是死路（§1 V3）；rating 重注入是 plan 备案缺口#2 |
| D6 | deepMerge | **T3：patch 对 `core.rating` 单字段信任边界**（strip + 覆写阻断 advisory + 专测） | 计划 T3 预登记；实施面收敛在 enrichment/engine.ts |
| D7 | art_direction | **显式卡 = 确定性注入蓝图字段**（不信任 LLM）；推荐卡 = 【推荐先验】进 enrichBlueprint user 段 | 现消费面 runEnrich 退出默认路径后必须迁移消费点（§2.7 风险 R4） |
| D8 | 兼容双态 | **旧 slots 路径整体保留在 env/registry 双开关之后**，M5 不删 | 回滚面 = 翻开关；旧路径继续被既有测试钉死 |

---

## 1. 现状验尸（本文已逐条核实的代码事实）

captain 钉死的四条全部复核属实，行号更新如下；另补五条设计相关的新验尸结论（V3–V7）。

| # | 事实 | 证据 |
|---|---|---|
| V1 | 标准 anima 路径 = ANIMA_PERSONA slots 直译：`parseIntentJson` 对 target='anima' 返回 `{slots}`（无蓝图） | intent/subagent-provider.ts L236-237；ANIMA_PERSONA L274；registry 侧 `intent: {persona: ANIMA_PERSONA, schema: ANIMA_SCHEMA}`（dialect/anima.ts L931） |
| V2 | 蓝图形态仅增量入口可达：`isBlueprint`（L101）只认 `req.target === 'blueprint'`；而 'blueprint' 不是 TARGETS 成员，生产装配（plugin/index.ts L55 → createDefaultIntentProvider → subagent-provider）永不产生该 target——**该分支现状仅测试可达**（slim-system.test L36、subagent-provider.test L179-199） | subagent-provider.ts L101-103、L224-225；plugin/index.ts L55 |
| V3 | core.rating 确定性注入挂 `if (draft.blueprint)` | prompt-author.ts L905；slots 路径 P0 补写 L911（2b4c245） |
| V4 | 投影映射 core.rating→slots.rating 已修 ✓ | blueprint/project.ts L163-166（P0 注释）；消费端 compileAnima L334 resolveEffectiveRating（slots.rating 最高优先，safety/rating.ts L68-69） |

**新增验尸结论（设计输入，此前未钉死）**：

| # | 事实 | 设计含义 |
|---|---|---|
| V5 | **蓝图分支的修复轮在生产是死路**：修复轮 provider 调用携带 `intentBase`（target='anima'/'h3'）→ subagent provider 按 V1 返回 `{slots}/{shots}` → L950 `if (!d2.blueprint) break` 必然首轮即断，闭环退化为 Level 3。测试里修复轮能走通只因 mock provider 无视 target 直接返回蓝图 | D5 三合一不是局部补丁——蓝图分支的修复闭环要真正活起来，必须与路由切换同批落地（T2） |
| V6 | **修复轮蓝图无锚定**：L949 provider 调用只带 feedback 文本，不带旧蓝图——即便 V5 修好，修复轮也是整图重解释（违反 spec §12「只重写失败字段」与 blueprint_id 路径的 INCREMENTAL_ANCHOR 纪律） | D5 的 anchorBlueprint 设计依据 |
| V7 | **repo.save 生产零调用**：blueprint_id 的读取面存在（prompt-author L897-899），但 src 中无任何 `repo.save` 调用方——生产没有蓝图写入面，blueprint_id 增量入口实际无料可载 | D9（§2.4）：默认路径成功出口 fail-open 落库，顺手补齐写入面并充当 envelope 蓝图痕迹载体 |
| V8 | 扩展层对 image 蓝图的兼容现状良好：applyStyle 已有 image 分支（fragments.image → media_layer.image.lighting_detail；negative_hints 在 media!=='video' 时并入，styles/apply.ts L40-48、L62-68）；checkShotDensity 对无 video.shots 的蓝图直通 pass（aesthetics/check.ts L198-203）；checkConcreteness/checkFidelity/checkFieldCompleteness media 无关 | anima 蓝图可直接复用 enrichBlueprint 全链；唯一 video 残留 = buildExpansionPersona 规则 3（video shot 五维硬性，enrichment/engine.ts L78-84）对 image 蓝图空转——需按 media 分支微调（划入 T2） |
| V9 | 既有 e2e 用 target='h3' 作蓝图分支测试载体（author-blueprint.e2e 全文件、orchestration 测试④） | 迁移后这些载体语义不变（h3 未迁移）；新增 anima 载体用例归 T4 |
| V10 | validateBlueprint 只校验 video 分支（schema.ts L145-169）：image 分支零校验；未知字段（含 media_layer.image 任意新字段）静默放行 | D2 的「validateBlueprint 本体零改动」依据；expectedMedia 守卫放 parse 层而非校验器 |

---

## 2. 六要素设计

### 2.1 要素①：路由切换点定夺（D1）

**候选方案**：

- **方案 A（采纳）：dialect registry intent 形态标志**。`DialectContract.intent` 扩展为：
  ```ts
  intent?: {
    persona: string
    schema: string
    /** M5：意图形态。缺省 'slots'（全部既有方言零改动）；anima 注册为 'blueprint' */
    form?: 'slots' | 'blueprint'
    /** form='blueprint' 时的子代理 persona/schema；缺省回落 BLUEPRINT_SUBAGENT_SYSTEM / BLUEPRINT_SCHEMA */
    blueprintPersona?: string
    blueprintSchema?: string
    /** 期望蓝图 media；parse 层守卫用（anima='image'） */
    blueprintExpectedMedia?: 'image' | 'video' | 'mixed'
  }
  ```
  读取点**唯一**：prompt-author 构造 `intentBase` 处（现 L869）。读取结果以平铺字段随 `AuthorIntentRequest` 下行（新增 `blueprintMode?: boolean`、`blueprintExpectedMedia?: string`；persona/schema 复用既有字段承载蓝图 persona/schema）。subagent-provider 的 `isBlueprint` 改为 `req.target === 'blueprint' || req.blueprintMode === true`（原有 target='blueprint' 分支原样保留，测试 seam 不破）。
- **方案 B（否决）：硬切**——`isBlueprint = req.target === 'blueprint' || req.target === 'anima'`。否决理由：无回滚面（回滚=改代码发版）；schema 仍是 video 硬编码（D2 无处安放）；h3 迁移时二次改码； persona/schema 注入链（registry intent cfg）被旁路，方言化机制（Task 7）形同虚设。
- **方案 C（否决）：subagent-provider 自查 registry**。理由：出现两个读取点（prompt-author 还需知道 form 才能决定跳过 runEnrich，见 D4），漂移风险；registry 模块级单例让 provider 单测被装配顺序绑架。

**定夺理由（方案 A）**：切换语义是「方言声明自己意图层形态」——与 Task 7 方言化同构；单读取点保证「路由决策」「runEnrich 跳过」「expectedMedia 守卫」三处消费同一事实源；回滚是数据改动不是逻辑改动。

**运行时 kill-switch（回滚面 R2，与 D8 合读）**：读取点叠加环境变量覆盖：
`PM_AUTHOR_INTENT_FORM = 'slots' | 'blueprint'`，env 缺省不干预；显式设置时覆盖 registry 标志并出 advisory `intent_form_override:<value>`。env 值非法 → 抛错（fail-fast，防拼错静默走默认）。

### 2.2 要素②：方言参数化现状核验 + anima 蓝图 schema 适配需求清点（D2）

**现状核验表**：

| 组件 | 现状 | anima 适配判定 |
|---|---|---|
| `BLUEPRINT_SCHEMA`（analyzer.ts L33） | **video 硬编码模板**：`"media": "video"` + media_layer.video/shots 示例 + 输出规则提及 references 提取 | **需 anima 变体**。直接复用会让 anima LLM 高概率产出 video 形蓝图：validate 通过（media 枚举含 video）但 projectToAnima 拿不到 media_layer.image → camera/detail_mood 全空 + applyStyle 注入 video 分支丢失（V8 反例面） |
| `BLUEPRINT_PERSONA`（analyzer.ts L20） | media 中性，但规则 5 为 video 专属（total_duration 语义） | **需 anima 变体**（image 规则块），与 ANIMA_BLUEPRINT_SCHEMA 配套 |
| `BLUEPRINT_SUBAGENT_SYSTEM`（subagent-provider.ts L15） | 最小 system（分级感知块），media 无关 | **原样复用**作 anima 蓝图 persona 基座（Task 12 Step 3b 瘦身原则继续生效） |
| `parseBlueprintJson`（analyzer.ts L98） | target 无关：stripFences → parse → validateBlueprint → computeMissing | **原样复用 + 可选第二参** `opts?: { expectedMedia?: BlueprintMedia }`：media 不符 → throw（错误文案 `blueprint media mismatch: expected <x> got <y>`，可机检可反馈） |
| `validateBlueprint`（schema.ts L109） | media 枚举含 'image'；core.rating/aspect_ratio 枚举校验；**仅 video 分支有结构校验**；未知字段静默放行 | **本体零改动**。image 分支不做强校验（蓝图字段可空是 spec §6 明文）；expectedMedia 守卫放 parse 层，校验器保持纯形状校验 |
| `computeMissing`（analyzer.ts L83） | style/media/negative/lighting/composition，media 无关 | 原样复用 |
| `INCREMENTAL_ANCHOR`（analyzer.ts L158） | `<old_blueprint>` 锚定模板，media 无关 | 原样复用（D5 修复轮锚定即复用它） |

**ANIMA 蓝图 persona/schema 设计（实现粒度，T2 直接取用）**：

- `ANIMA_BLUEPRINT_SCHEMA`（新常量，建议落 blueprint/analyzer.ts，与 BLUEPRINT_SCHEMA 同居）：image 形态模板——`"media": "image"`、core 与现模板同构（concept/aspect_ratio/characters/scene/style/emotion/composition/negative/narrative，**不含 rating**——安全数据确定性注入，spec §5.1 偏差记录延续）、media_layer.image 含 §2.3 D3 的增补字段。输出规则段 = 现模板同款三行（裸 JSON / 无 fence / ref 标签稳定）+ 新增两条 image 专属指令：
  1. 景别 discipline：`media_layer.image.camera_angle` 只允许 anima 景别词（full body / cowboy shot / upper body / close-up）+ 至多 1 个视角词；focal_length/depth_of_field 不确定规范写法时留空（camera 是结构槽，miss 永不删——脏词会全文穿透，见 dialect/anima.ts L52-56 注释）。
  2. 角色锚点 discipline：无参考图时 characters[].reference_slots 留空（character 槽不产出），识别信息全部进 appearance_anchors/outfit。
- `ANIMA_BLUEPRINT_PERSONA`（新常量）= `BLUEPRINT_SUBAGENT_SYSTEM` + image 蓝图规则块，规则块内容从 BLUEPRINT_PERSONA 裁剪：保留「产出蓝图不是方言输入 / 保留事实原字面 / 标记缺失（字段留空）/ 多模态提取进核心字段 / ref 标签稳定」，删除规则 5（video total_duration），新增：人数锚写 media_layer.image.count_gender（如 ["1girl"]/["1girl","1boy"]，用户未暗示人数时单人数）、动作峰值帧单一瞬间写 pose_action、表情 ≤2 写 expression、场景锚点 ≤3 写 scene_anchors（其余场景细节进 narrative 的四类信息纪律——景别占比/光源物件与曝光/空间纵深/色彩主次——沿用 ANIMA_PERSONA 的 narrative 职责表，避免双重加权）。
- **不新增** schema_version、不动 core 形状、不动 validateBlueprint。

### 2.3 要素③：投影链缺口清点（D3）

基准：spec §8.2 IR→Anima 映射表 + projectToAnima 现状（project.ts L122-169）vs AnimaSlots 全槽（dialect/anima.ts L23-43）+ ANIMA_PERSONA 槽位语义表。

**已修 ✓（不在本次范围）**：core.rating → slots.rating（P0 2b4c245，L163-166）；hard negative 投影期 throw（L124-125）；soft negative → exclusions；artist_hints → artist（B8）。

**缺口清单（本次要修的全部）**：

| 级 | 缺口 | 现状 | 定案 |
|---|---|---|---|
| P0 | `count_gender` 无来源 | 蓝图无人数字段，投影不产出 | IR 增补 `media_layer.image.count_gender?: string[]` + 投影直映射 |
| P0 | `pose_action` 无来源 | 同上（video shots.action 是 video 侧字段，投影不到 anima） | IR 增补 `media_layer.image.pose_action?: string[]` + 直映射 |
| P0 | `expression` 无来源 | 同上 | IR 增补 `media_layer.image.expression?: string[]` + 直映射 |
| P0 | `scene` 单锚点塌陷 | 仅 `[scene.environment]` 单 tag；slots 语义 = ≤3 高影响锚点 | IR 增补 `media_layer.image.scene_anchors?: string[]`；投影 `scene = [environment?] + scene_anchors`（保序去重） |
| P1（决策留痕，不做） | `style.palette` / `emotion` / `scene.time` / `characters.props/distinctive/variant` / `aspect_ratio` 不映射 | spec §8.2 本就无这些行；anima 侧色彩主次/情绪由 narrative 职责表承载（persona 纪律），aspect_ratio 不属提示词表面（camera-anima 请求面参数） | persona 引导（palette/emotion 写进 narrative 色彩/情绪句），投影保持不映射——**在 projectToAnima 头注释留痕「deliberate non-mapping」清单**，防后人当 bug 修 |
| P1（质量风险，观察项） | focal_length/depth_of_field → camera 槽可能产出非 danbooru 形文本 | 现有映射保留 | persona 景别 discipline（§2.2）前置预防 + golden L1 容差覆盖；不改投影（结构槽 miss 不删，脏词风险靠产出纪律压） |

**投影扩展的硬边界**（教训继承：写入必经的相邻层）：projectToAnima 产出**只允许既有 AnimaSlots 白名单键**（dialect/anima.ts L884 ANIMA_SLOT_KEYS + narrative/exclusions/subject/qualityPrefix/explicit/rating）——本次 4 个新 IR 字段全部映射进既有槽，**validateAnimaSlots 零改动**；若实现中萌生「给 slots 加新槽」的念头即越界，须回 T1R 重新评审。

### 2.4 编排接线设计（T2 主战场；D4/D5/D7/D9）

**迁移后 anima 默认执行流**（变化点加粗）：

```
预检（resolveRating/checkBoundaries/h3 gate）→ recommendArtDirection（不动）
→ 【跳过 runEnrich】（D4；条件 = target==='anima' && form==='blueprint'，与 blueprint_id 路径同款）
→ catalog 候选召回：源文本 = 原始 input（runEnrich 跳过后 intentInput 恒为 input；与 blueprint_id 路径现状一致）
→ intent 子代理：blueprintMode（D1）→ BLUEPRINT_SUBAGENT_SYSTEM+ANIMA 蓝图 persona/schema
   → parseBlueprintJson(text, {expectedMedia:'image'}) → {blueprint, missing}
→ 【validate/media 失败 → 单次反馈重试】（D5c：错误文案作 feedback 重调 provider 一次，计 1 次 correction，
   advisory blueprint_repair_retry；再失败 → 原 throw 透传，fail-closed）
→ core.rating 注入 = 统一 helper `injectCoreRating(draft, resolved)`（首轮+修复轮共用，D5b）
→ 【art_direction 显式卡确定性注入】applyArtDirectionCards(bp, a.art_direction)（D7）
→ enrichBlueprint(ctx, route, bp, {styleId, conformity, missing, recommendations?})（D7 推荐先验）
→ preflightRepair（video-only 现状保持；anima 蓝图直通）→ projectToAnima（D3 扩展后）
→ runStage（投影产物是 slots——compile/audit/judge/budget 全链零感知，golden 逐字节锁死）
→ 修复轮（≤2）：feedback（critical gates + judgeFeedback）→ provider({…intentBase, round, feedback,
   anchorBlueprint: 当前 bp})（D5a）→ d2.blueprint → injectCoreRating → enrichBlueprint → preflightRepair
   → runStage；`if (!d2.blueprint) break` 保留（fail-open→Level 3）
→ 成功出口：repo.save(generation_id, 最终 bp)（D9，fail-open：settings 缺失/写失败 → advisory
   blueprint_save_failed，不阻塞出稿）+ envelope 蓝图痕迹
```

**D4 取舍留痕（runEnrich vs enrichBlueprint）**：采纳「swap」——anima blueprint 形态下 runEnrich 整块跳过（条件与 blueprint_id 同款，`enrich_ignored_blueprint` advisory 语义同步适用于默认路径）。理由：① spec §4/§8 字面流「意图分析→蓝图→validateBlueprint→投影→编译」无 brief 层，蓝图 core 字段（concept/scene/style/composition/emotion/narrative）结构上覆盖七维 brief，双开是重复语义层；② LLM 调用数首轮持平（runEnrich 1 次 ↔ enrichBlueprint 1 次），修复轮每轮 +1（诚实代价，见 §2.7 R1）；③ 与 blueprint_id 路径统一 = 立项一的收益④原文。否决「stack」（runEnrich 供 brief → 蓝图分析）理由：+1 次 LLM/生成、intent 输入膨胀、且 brief 的 artDirection/推荐先验消费面仍需二次迁移，等于把 D7 做两遍。**回滚面见 §2.5：env 切回 slots 即整体还原今日行为（含 runEnrich）**。

**D7 art_direction / style_list 82 预设交互**：
- 显式 `art_direction` 卡（调用方硬要求）：新增纯函数 `applyArtDirectionCards(bp, spec)`（建议落 pe-framework/enrichment/art-direction-apply.ts，卡片数据复用 enrich/art-direction.ts 五类卡组）——确定性映射：perspective → media_layer.image.camera_angle 追加卡 tags；composition → core.composition 追加；lighting → core.scene.lighting 追加（卡组已过 LIGHTING_BAN，A7 不变式沿用 + 测试锁定）；color → core.style.palette 追加；motion → media_layer.image.pose_action 追加。每卡出 advisory `art_direction_applied:<field>:<id>`。语义强于现状（现状走 enrich brief 是 LLM 软约束）。
- 推荐卡（presetHints → recommendArtDirection 输出）：透传 enrichBlueprint 新可选参 `recommendations`，扩展 persona user 段增【推荐先验】块（与 enrich/engine.ts L74-78 同文案同风格）；LLM 仍终决——与现语义逐字对齐。
- style_id/conformity：零改动（applyStyle image 分支现成，V8）；`styleSummaryOf` 读 media_layer.image.lighting_detail（prompt-author L690-695），image 蓝图天然被覆盖——**前提是 expectedMedia 守卫保证了 media==='image'**。
- 参数校验/忽略面：`validateArtDirectionSpec` 仍在预检 fail-fast；`art_direction_ignored_*` advisory 矩阵修订为——h3 目标不变；anima+enrich=false → ignored；**anima+blueprint 形态不再 ignored**（新消费面生效）；judge_mode/enrich 参数在 blueprint 形态下的忽略 advisory（`enrich_ignored_blueprint`）扩展到默认路径。

**envelope 契约增量（验收草案「envelope 契约零变化」的精确化）**：顶层骨架（ok/audit/advisories/next_action/repair_hints/generation_id/judge*/rating/aesthetics/style/observability）零变化；增量面收敛为四项并在 T5 收口时同步 AGENTS.md：① `observability.blueprint = { form: 'blueprint', media, missing_count, expansions_count, repairs_count, anchor_rounds }`（验收草案的「blueprint 痕迹」载体）；② trace stages 增 `blueprint_enrich` 子条目（现 blueprint 分支无 enrich 计时，traceExtra L912 只push intent）；③ `enrichment` 顶层字段在 anima 默认路径**消失**（与 blueprint_id 路径现状一致——该路径今天就不产出 enrichment，非新破坏）；④ generations.enrich 列记 0（语义 = brief enrich；blueprint 形态下 brief 不存在）。

**defaultIntent parity**（prompt-author L141-168，无 subagent 时的回退 intent）：同样按 `req.blueprintMode` 切换——system = ANIMA 蓝图 persona、user 结构不变、解析走 parseBlueprintJson(+expectedMedia)。它是生产降级面（真实装配走 subagent，V2），不迁移则降级面行为分裂。

**D9 蓝图落库**：成功出口 `repo.save(generation_id, bp)`（ctx.settings 缺失时静默跳过——与 recordGenerationSafe 同款 try/catch 纪律）。收益：blueprint_id 增量入口从此有料（V7）、修复轮锚定有跨调用基线、envelope 有 `blueprint_id` 可供 agent 直接续链（envelope 顶层 `blueprint_id: generation_id`，仅落库成功时出现）。

### 2.5 要素④：兼容双态 + 回滚策略具体化（D8）

**双态保留形态**：M5 不删除任何旧路径代码。L1009 起的 slots/shots 直传分支、runEnrich 块、mergeRepairSlots、slots.rating P0 写入全部原样保留，被开关门控：

| 层 | 开关 | 语义 |
|---|---|---|
| 静态（默认态） | registry `intent.form`（anima='blueprint'） | 部署即新路径；回滚 = revert 该单行注册（commit 面极小） |
| 动态（运行时） | `PM_AUTHOR_INTENT_FORM=slots` | 不发版回滚：读取点覆盖（§2.1），advisory 可观测 |
| 代码路径 | `draft.blueprint` 有无 | 双态最终分流点天然存在（AuthorDraft 双形状），蓝图形态缺省失败时**不做**自动降级到 slots（fail-closed 保 spec §8 对齐；静默降级=重蹈 8e31ff2a 静默降档覆辙） |

**回滚触发判据（T4 重放后生效，量化）**：真实会话重放中出现任一 → 翻 env 开关并立案：① explicit 档产物种子与 envelope rating.resolved 不一致（P0 修复回归）；② golden L1 主干判据在非 whitelist 案例失败；③ intent 子代理 300s 超时率 > 迁移前基线 2 倍；④ catalog_miss advisory 均值 > 迁移前 2 倍（召回源退化的代理指标）；⑤ loop_exhausted 率上升（修复闭环劣化）。

### 2.6 要素⑤：golden 对照方案（可机检）

**抽样集**（T4 落地为 `tests/fixtures/blueprint-migration/cases.json`，12 案例定版）：

| id | 覆盖面 | args 要点 |
|---|---|---|
| c01 | 单人 safe 基础（锚定补全下限） | judge off |
| c02 | 多人物分离 | judge off |
| c03 | 场景主导（无人物） | judge off |
| c04 | 画师暗示（artist 槽 + catalog grounding） | judge off |
| c05 | style_id 预设 + conformity=0（全量注入） | style_id, judge off |
| c06 | style_id 预设 + conformity=1（仅引用） | style_id, judge off |
| c07 | **explicit 显式声明**（§2.6 端到端断言主载体） | rating:'explicit', judge off |
| c08 | sensitive 关键词升档（bikini 载体） | judge off |
| c09 | <Picture N> 引用语义（角色锚定） | judge off |
| c10 | CJK 长叙事 brief | judge off |
| c11 | art_direction 显式双卡（lighting+motion） | art_direction, judge off |
| c12 | soft 负向意图（「无现代元素」） | judge off |

**机检判据（四层，全部落 vitest 断言）**——对照对象 = 旧路径产物（mock provider 返回 recorded slots 转录，逐案例存 fixture）vs 新路径产物（mock provider 返回同案例蓝图 JSON + 空 patch，走 projectToAnima）：

- **L1 slots 主干等价**：主干 = SLOT_ORDER ∪ {narrative, exclusions, rating}。
  - 身份槽 count_gender/character/artist：**集合严格相等**；
  - 内容槽 appearance/clothing/pose_action/expression/scene/detail_mood：Jaccard ≥ 0.6，且案例 fixture 允许声明 `allowed_missing`/`allowed_extra` whitelist（如 c05 的风格短语注入差异）；
  - narrative：双方存在性一致 + 非空 + 通过 compileAnima 既有 narrative 质量门（或 fixture 声明豁免理由）；
  - rating：**逐字节相等**。
- **L2 explicit 档端到端断言**（c07）：positive 含 `rating_explicit` 种子且不含 `rating_sensitive`；negative 含 RATING_NEGATIVE_ADDITIONS.explicit 全组六词（child/loli/shota/toddler/kid/preteen）；`rating.resolved==='explicit'` 且 source='input'；assumptions 含 `rating_active:explicit`。
- **L3 envelope 骨架断言**：双路径顶层键集差异 ⊆ {enrichment, observability.blueprint}（§2.4 契约增量白名单）；新路径 critical gate 家族集合 ⊆ 旧路径（无新增 critical 家族）。
- **L4 编译层逐字节回归**：对 recorded slots 基线直接 compileAnima 的产物，迁移前后逐字节一致（fidelity golden 套件既有职能，迁移不得触碰方言层——本判据是「未越界」的照妖镜）。

**重放执行形态**：全部判定用 mock provider（stubCtx/textStream 既有 harness，参考 prompt-author-orchestration.test.ts 的 P0 用例形态）——确定性、CI 可跑、不依赖真网；真实 LLM 重放归 §2.7 e2e 清单。

### 2.7 要素⑥：e2e 重放清单 + 风险清单

**e2e 重放清单（T4 执行，T5 收口复核）**：
1. 全量 `npx vitest run`（记录基线数字：M4 收口 133 files / 1123 passed / 1 skipped；数字漂移以实测为准）；
2. `npx tsc --noEmit` + `npm run build`（**src 改动必 build，铁律**）+ dist 冒烟（node 加载 `dist/src/plugin/index.js`，registry 工具计数与名单核对）；
3. 既有蓝图 e2e 载体回归：author-blueprint.e2e 全文件（h3 载体）、orchestration 测试④（h3+blueprint_id 载体）、orchestration「anima blueprint path」用例（L428-442，anima+blueprint_id 生产可达形态）、blueprint/rating-intent——全部零改动通过；orchestration 测试⑤（anima slots 默认路径）在开关默认态下的语义变化由其断言面自查（recommendedCards/style/rating 仍在）；
4. 真实会话重放：§2.6 抽样集 12 案例经真实 DSH 会话跑 anima 默认路径（LLM 真跑，judge_mode 按案例）——断言面收窄为 L2（explicit 档）+ envelope 痕迹 + 回滚判据指标采集（token/耗时/超时/advisory 计数），不做 L1 逐案例强断言（真 LLM 非确定性，容差判据只用于 mock 层）；
5. blueprint_id 链路回归：默认路径落库（D9）→ 取 envelope.blueprint_id 作 blueprint_id 输入 → 增量锚定 + 修复轮全通；
6. h3 全链回归（未迁移面零变化）：intent persona/schema、shots 直译、budget、judge；
7. prompt_compile / prompt_audit 工具面回归（slots 直译入口不变，prompt_compile anima slots 通道不受影响）。

**风险清单**：

| # | 风险 | 画像/基线 | 缓解与观测 |
|---|---|---|---|
| R1 | token 画像变化 | intent 输入：ANIMA_PERSONA 3075 字符 + schema ~1KB → 蓝图 persona ~0.2KB 基座 + image 规则块 + schema ~1.5KB（**输入净减**）；intent 输出：slots JSON ~0.5–1.2KB → 蓝图 JSON ~1–2KB（**输出净增**）；首轮调用数 3→3 持平（runEnrich↔enrichBlueprint 互换）；修复轮每轮 +1 LLM（enrichBlueprint） | T4 重放实测 intent taskText 字节数 + 输出字节数（logger 行留痕），偏差 >30% 立案；修复轮成本已被 judgeRepair=false 开关罩住（既有语义） |
| R2 | 子代理超时（300s 基线） | DEFAULT_SUBAGENT_TIMEOUT_MS=300_000（L55）；蓝图输出更长 → 超时概率上移 | 超时已是 fail-closed（AbortController）；观测：重放采集超时次数；PM_SUBAGENT_TIMEOUT_MS 逃生口不动；不主动调基线 |
| R3 | 失败模式变化 | slots 路径 normalizeSlots 永不抛（宽容面）；蓝图路径 validate/media 失败即 throw（严苛面） | D5c 单次反馈重试兜住瞬态 schema 违例；再失败 fail-closed + 错误文案含校验明细（agent 可修输入重试）；**不做** slots 静默降级（§2.5） |
| R4 | art_direction_hints 交互回归 | 现消费面 runEnrich 退出默认路径；预设 art_direction_hints → recommendArtDirection → 【推荐先验】链路若断，82 预设的动势/光影推荐静默失效 | D7 双通道迁移（显式卡确定性注入 + 推荐先验进 enrichBlueprint）；c11 案例 + `art_direction_applied` advisory 断言；推荐先验块文案与 enrich/engine 逐字同源 |
| R5 | catalog 召回源退化 | 召回源从 enrich brief（英文扩写）退回原始 input——中文输入的英文 tag 召回可能缩水（B7 效果回归） | 观测：`catalog_recall_injected:N` 计数对比（回滚判据④）；若恶化，T4 后续可把蓝图 concept 并入召回源文本（本设计不预先实施，留观察项） |
| R6 | 修复轮路由回归（V5 复发） | 若 provider 蓝图分支对 anima 未开全，修复轮静默退化为 Level 3 | T2 专测钉死：mock provider 记录 req.blueprintMode，修复轮断言收到 anchorBlueprint 且返回蓝图后闭环推进（ Vitest RED→GREEN） |
| R7 | deepMerge 覆写 core.rating（缺口#3） | enrich patch `{set:{core:{rating:…}}}` 理论可覆写声明档位 | D6/T3：patch 应用前 strip patch.core.rating + 覆写企图出 advisory `enrich_rating_overwrite_blocked`；专测：v0 explicit + 恶意 patch → v1 仍 explicit |
| R8 | 蓝图 media 漂移 | LLM 返回 video 形蓝图 → 投影空槽 + style 注入错分支 | D2 expectedMedia 守卫（parse 层 fail）+ D5c 反馈重试；错误文案机检 |

---

## 3. T2/T3/T4 实现契约映射（本设计稿的交付验收）

**T2 provider 路由切换 + 编排接线**（建议 in-scope：`intent/subagent-provider.ts`、`blueprint/analyzer.ts`、`blueprint/schema.ts`（仅加型）、`blueprint/project.ts`、`blueprint/repo.ts`（零改动预期）、`dialect/contract.ts`、`dialect/anima.ts`、`tools/prompt-author.ts`、`enrichment/engine.ts`（persona media 分支 + recommendations 参）、新增 `enrichment/art-direction-apply.ts`、对应 tests）：
- D1 registry form 标志 + env kill-switch + advisory；D2 ANIMA 蓝图 persona/schema + parseBlueprintJson expectedMedia；D3 投影 4 字段 + deliberate non-mapping 注释；D4 runEnrich swap + catalog 召回源 + envelope 增量四项 + defaultIntent parity；D5 三合一（anchorBlueprint/统一 rating 注入/validate 单次重试）；D7 双通道；D9 落库。验收 = §2.6 L1–L4 mock 层全绿 + V5/R6 专测 + build/tsc。
- 相邻层纪律：validateAnimaSlots/ANIMA_SLOT_KEYS/registry.test 工具名单零改动。

**T3 deepMerge 硬化**（in-scope：`enrichment/engine.ts` + 专测）：R7 全文。独立可并行，不依赖 T2。

**T4 golden 对照 + NSFW 端到端 + 全量重放**（in-scope：`tests/fixtures/blueprint-migration/*`、golden 测试、重放记录 docs）：§2.6 四层判据 + §2.7 清单 1–7 + R1/R5 指标实测留痕。explicit 档端到端以 c07 为准（种子/负向组/一致性三断言全要）。

## 4. 不做 / 台账（防蔓延）

- h3 蓝图迁移（registry form 机制已为其预留，另立里程碑）；
- strict patchAnima 档位回落（缺口#1）——维持台账，不在 M5；
- 旧 slots 路径删除——M5 不删（D8），删除提案留台账待双态稳定一个里程碑后评审；
- BlueprintV1 v2 / schema 迁移函数、SD 方言、prompt_audit 顶层 rating 输入——既有台账不动。

## 5. 留给 T1R 的开放问题（已裁决，2026-09-13 T1R + captain）

1. D4 修复轮成本 → **Q1 采纳 T1R 意见：维持全量扩展**（与 blueprint_id 路径现状一致；judgeRepair=false 已有逃生口）；
2. D9 落库键 → **Q2 采纳：generation_id 够用**；
3. 常量落点 → **Q3 采纳：ANIMA 蓝图 persona/schema 落 blueprint/analyzer.ts**（与 BLUEPRINT_* 同居）。

**F1（T1R finding，captain 定夺）**：D7 显式卡形状契约钉死为——perspective 卡 → `camera_angle` 追加**每卡至多 1 个 anima 安全景别词**（full body/cowboy shot/upper body/close-up 白名单内，非白名单词丢弃 + advisory）；lighting 卡 → `core.scene.lighting` 追加，卡间显式分隔符；**color 卡改走推荐先验通道**（进 enrichBlueprint user 段【推荐先验】，LLM 终决写 narrative 色彩句）——否决确定性写 `core.style.palette`（P1 non-mapping 字段零表面效果 = 假注入）；motion 卡 → `pose_action` 追加照旧。四类均有专测。

**F2（T1R finding）**：envelope L3 白名单补条件性顶层键 `blueprint_id`（D9 仅落库成功时出现）——T4 契约断言面。
