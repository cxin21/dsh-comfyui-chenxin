# 设计 spec：风格预设库 v2 + 美学分析系统 + NSFW 三档

- 日期：2026-09-12
- 状态：待用户评审
- 调研依据：`docs/research/2026-09-12-style-preset-aesthetics-benchmark.md`（NewBie-LLM-Formatter 深挖 + Fooocus / sdxl_prompt_styler / InvokeAI / LAION / ImageReward 对照 + Anima catalog 实测）
- 影响 range：`src/pe-framework/{styles,safety,aesthetics,enrich,eval,dialect,blueprint}`、`src/tools/`、`assets/style-presets/`

---

## 1. 背景与问题

用户判定插件「美学有待提高」。实测确认四个缺口：

1. **风格库薄弱**：MINIMAL_STYLES 仅 11 条；`assets/style-presets/` 44 个 nb* 预设（源自 NewBie-LLM-Formatter）无任何代码引用（死数据）；`negative_hints` 字段未接线；nb 数据的 `artist_max` 未消费。
2. **NSFW 只是布尔开关**：`AnimaSlots.explicit` 关断 = 不注入 `safe` 种子，无分层、无策略、无边界闸门。而 Anima catalog 实测 `rating_explicit` / `rating_sensitive` 为 canonical 可用标签——模型侧分级有扎实词表基础。
3. **美学无确定性层**：美学判断全部压在 LLM 评委（D10 三维）身上，audit 层零美学 gates，无艺术指导卡推荐（36 卡只能靠用户显式指定或 enrich LLM 自选）。
4. **流程有旁路**：`blueprint_id` 整体跳过意图分析（增量修改易漂移）、`audit_only` 在 prompt_author 上形成 LLM 旁路。

## 2. 已拍板决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | NSFW 机制 | 三档 rating 分级（safe / sensitive / explicit），grounded 在 catalog canonical 标签；硬闸门拒绝未成年性化与非自愿内容 |
| D2 | 美学分析范围 | prompt 侧为主（确定性 gates + 卡推荐，零 GPU）；输出侧评分（CLIP/偏好 RM）只预留接口不做 |
| D3 | 风格库 | 统一 v2 schema，44 nb + 11 builtin 全部迁移接线，新增预设填全分类；negative_hints / artist_max 全部生效 |
| D4 | NSFW 提示词路线 | 不采纳 NewBie 的 LLM 破限（Anima 是本地模型），走模型侧 rating 标签分层 |
| D5 | LLM 参与强度 | 不强制扩 LLM 步骤；现有 LLM 编排保持 ①→②→③，新系统全部以确定性节点插入缝隙 |
| D6 | 蓝图意图分析 | **恒跑无旁路**：`blueprint_id` 重定义为「带旧蓝图锚定的增量意图分析」；prompt_author 移除 `audit_only`（纯审计归 prompt_audit 工具）；intent 失败 fail-fast 可重试，不静默降级 |
| D7 | 成本逃生门 | `enrich=false` / `judge_mode=off` 保留为显式逃生门；默认永远是完整流程 |

## 3. 架构总览

```
src/pe-framework/
├── styles/                    # 新增
│   ├── schema.ts              # StylePresetV2 类型 + validateStylePreset（确定性校验器）
│   ├── registry.ts            # 目录式加载 assets/style-presets/*.json + 去重 + 索引 + 查询
│   └── apply.ts               # applyStyleV2（自 enrichment/style.ts 迁移；旧导出保留兼容 shim）
├── safety/                    # 新增
│   ├── rating.ts              # Rating 类型、升级词表、variant×rating 策略表
│   └── boundaries.ts          # 硬边界闸门（词表交叉判定，确定性，不可被 LLM 说服）
├── aesthetics/                # 扩展（已有 lexicon/check）
│   ├── audit.ts               # 新：4 条确定性美学 gates（advisory 级，repair hint 指向卡 id）
│   └── recommend.ts           # 新：艺术指导卡推荐器（规则推导，输出作为 enrich 先验）
└── assets/style-presets/*.json  # 数据真源：v2 schema（55 条迁移 + 27 条新增 = 82 条）
```

改动模块：`dialect/anima.ts`（rating 槽 + 策略表消费）、`blueprint/schema.ts`（core.rating）、`enrich/{brief,engine}.ts`（rating 字段 + 先验注入）、`enrich/personas.ts`、`blueprint/analyzer.ts` 与 `intent/subagent-provider.ts`（persona + 增量意图）、`eval/critic.ts` 与 `eval/rubrics/anima.ts`（boundary 评级中立）、`continue/engine.ts` 注入点、`tools/prompt-author.ts`（输入/envelope）、`tools/style-list.ts`（新）。

## 4. 风格预设库 v2

### 4.1 Schema（对齐 sdxl_prompt_styler 三原则 + NewBie 模式分档）

```ts
type StyleCategory =
  | 'photography' | 'anime' | 'illustration' | 'cg_3d' | 'oriental'
  | 'dark_supernatural' | 'scifi_fantasy' | 'retro' | 'graphic' | 'glamour_intimate'
type Rating = 'safe' | 'sensitive' | 'explicit'

interface StylePresetV2 {
  id: string                    // 全局唯一；迁移 nb 保留原 id（含 CJK）
  name: string                  // 中文显示名
  category: StyleCategory       // 必填，十类之一
  rating: Rating                // 该预设最高适用档；nsfw 预设一律 applies_to: ['anima']
  base?: string                 // 画风基底
  theme?: string                // 主题
  palette?: string              // 情绪配色
  fragments: { image: string; video: string }   // 必填；danbooru 英文短语，逗号分短语（conformity 按短语比例注入）
  negative_hints: string[]      // 必填 ≥1；软负向，接线进 negative（与策略负向、exclusions 去重合并）
  artist_hints: string[]        // 画师候选（裸名，catalog 验证存在；可为空，explicit 预设允许为空）
  artist_max: number            // 画师注入截断（默认 3；消费 nb 数据字段）
  applies_to: ('anima' | 'h3' | 'sd')[]   // 模式分档（对齐 NewBie [Anima]/[Both]）
  art_direction_hints?: Partial<Record<'perspective'|'composition'|'lighting'|'color'|'motion', string>>
                                // 可选：该风格建议的艺术指导卡（推荐器的附加先验信号）
  source: string                // 'builtin-migrated' | 'newbie-migrated' | 'hand-authored'
}
```

约束：`validateStylePreset` 确定性校验（枚举/必填/fragments 双通道非空/applies_to 非空）；`rating='sensitive'|'explicit'` 时 `applies_to` 必须恰为 `['anima']`；fragments 的光影词必须过 LIGHTING_BAN（复用 art-direction-ban 测试的不变式）；artist_hints 全部过 catalog 存在性测试（沿用 tests/pe-framework/enrichment/style.test.ts 模式）。

### 4.2 registry 行为

- 启动/首次访问时扫描 `assets/style-presets/*.json` 全量加载，逐条 validate，非法文件报错（fail-fast，不静默丢弃）。
- id 冲突 → 加后缀 `-2` 消解 + advisory `style_preset_id_conflict`（学 sdxl_prompt_styler）。
- 内存索引：by id / by category / by rating / by applies_to；按会话 rating 过滤（`preset.rating ≤ session.rating` 才可见可注入；序 safe<sensitive<explicit）。
- `MINIMAL_STYLES` 常量改为从 registry 派生的兼容导出（标记 deprecated，Phase 内删除直接引用）。

### 4.3 applyStyleV2 接线（修复三个死数据问题）

- **negative_hints 生效**：`core.negative`（soft 级）并入策略负向与 exclusions，大小写不敏感去重；硬负向（hard severity）仍由调用方预过滤（现状语义不变）。
- **artist_max 生效**：`artist_hints.slice(0, artist_max)` 后写入 `core.style.artist_hints`。
- **conformity 三档语义不变**：=0 全量注入 / (0,1) 按短语比例 / ≥1 仅引用——golden 测试锁定。
- **art_direction_hints 生效**：作为推荐器附加信号（§6.3）。
- h3 通道：只消费 `fragments.video`（h3 方言无 negative 通道，negative_hints 对 h3 忽略——advisory 标注）。

### 4.4 完整预置清单（82 条 = 55 迁移 + 27 新增）

十类分类学与归属。**迁移 55 条**（内容不重写，按 §10 映射规则转换 schema）：

| 类别 | 迁移来源 |
|---|---|
| photography（1） | cinematic_real |
| anime（25） | cel_shading + nb01/02/08/09/10/11/13/16/21/23/25/27/28/34/36/38/39/40/53/56/57/58/64/65 |
| illustration（17） | thick_paint, watercolor, concept_art, fairy_tale + nb03/04/06/07/12/14/17/18/24/47/48/51/52 |
| cg_3d（2） | game_cg + nb15, nb19 |
| oriental（2） | wafuu + nb05 |
| dark_supernatural（1） | dark_epic |
| scifi_fantasy（2） | cyberpunk, wasteland |
| retro（1） | nb26 |
| graphic（3） | nb20, nb35, nb43 |

（归属在迁移时逐条确认，允许个别 nb 按 style_tags 微调 category，但不改内容语义。）

**新增 27 条**（M2 数据里程碑；画师候选在 authoring 时经 catalog_search 逐一验证，验证失败则留空）：

| id | 名称 | category | rating | 锚点 tag 方向 | 负向方向 |
|---|---|---|---|---|---|
| film_photography | 胶片摄影 | photography | safe | film grain, kodak portra tones, halation, 35mm | digital clarity, oversharpened |
| studio_portrait | 棚拍人像 | photography | safe | seamless backdrop, softbox key, catchlight（光源物件写法） | cluttered background |
| documentary_photo | 纪实抓拍 | photography | safe | candid moment, available light source object, photojournalism | staged pose |
| fashion_editorial | 时尚大片 | photography | safe | editorial pose, haute couture, glossy magazine layout | casual snapshot |
| night_street | 夜景街拍 | photography | safe | neon signage reflections, wet asphalt, handheld framing | daylight |
| sports_action | 体育动感 | photography | safe | motion blur limbs, panning shot, sweat droplets | static pose |
| wildlife_nature | 生态自然 | photography | safe | telephoto compression, natural habitat, golden hour ambience | studio backdrop |
| unreal_render | UE 渲染感 | cg_3d | safe | lumen global illumination, nanite detail, cinematic engine render | flat shading |
| figure_model | 手办质感 | cg_3d | safe | pvc figure, glossy coat, display base | 2d lineart |
| claymation_clay | 黏土定格 | cg_3d | safe | clay texture, fingerprint marks, stop motion feel | smooth render |
| ink_wash | 水墨写意 | oriental | safe | ink wash painting, brush splashes, negative space rice paper | heavy saturation |
| hanfu_xianxia | 古风仙侠 | oriental | safe | flowing hanfu, ribbon sleeves, immortal mist peaks | modern clothing |
| gothic_vampire | 哥特暗夜 | dark_supernatural | safe | gothic architecture, candlelit chandelier object, pale skin, victorian lace | bright daylight |
| eldritch_horror | 克苏鲁诡秘 | dark_supernatural | safe | non-euclidean geometry, tentacular silhouettes, abyssal palette | cheerful tones |
| showa_retro | 昭和复古 | retro | safe | showa era cityscape, retro anime color dot tone | modern digital look |
| vintage_photo | 老照片 | retro | safe | sepia tone, faded edges, analog damage | hdr clarity |
| poster_constructivist | 构成海报 | graphic | safe | constructivist poster, bold geometric blocks, propaganda print style | photorealism |
| boudoir | 私房写真 | glamour_intimate | sensitive | boudoir posing, silk sheets, intimate interior | explicit nudity |
| lingerie_fashion | 内衣时尚 | glamour_intimate | sensitive | lingerie set, fashion catalogue posing | explicit nudity |
| beach_swimwear | 泳装盛夏 | glamour_intimate | sensitive | one-piece swimsuit, beach sunlight, sunscreen sheen | explicit nudity |
| pinup_retro | 经典海报女郎 | glamour_intimate | sensitive | retro pin-up pose, victory rolls, winking gesture | explicit nudity |
| glamour_portrait | 魅惑人像 | glamour_intimate | sensitive | smoky eyes, red lips, off-shoulder dress, sultry gaze | explicit nudity |
| after_dark | 夜店魅影 | glamour_intimate | sensitive | club lighting object, cocktail glass, party dress | explicit nudity |
| artistic_nude | 人体艺术 | glamour_intimate | explicit | artistic nude, classical sculpture pose, draped fabric | minors traits, grotesque |
| explicit_solo | 成人独角 | glamour_intimate | explicit | solo female, adult body type, explicit pose vocabulary（词表在实现期按 catalog 验证填全） | minors traits |
| explicit_couple | 成人双人 | glamour_intimate | explicit | heterosexual couple, consensual adult intimacy vocabulary | minors traits |
| explicit_fantasy | 奇幻情欲 | glamour_intimate | explicit | fantasy race adult (elf etc.), explicit vocabulary | minors traits |

NSFW 新增 10 条（sensitive 6 + explicit 4）+ 非 NSFW 新增 17 条 = 27。显式档预设 `artist_hints` 允许为空，质量由 tag 组合承担。类别总账：photography 8 / anime 25 / illustration 17 / cg_3d 6 / oriental 4 / dark_supernatural 3 / scifi_fantasy 2 / retro 3 / graphic 4 / glamour_intimate 10 = **82**。

## 5. NSFW 三档分级

### 5.1 类型与入口

- `prompt_author` 新增输入 `rating?: Rating`（默认 `'safe'`）→ 蓝图 `core.rating`（schema 校验枚举）→ `AnimaSlots.rating`。
- 兼容：`AnimaSlots.explicit?: boolean` 保留映射——`true→'explicit'`；`rating` 与 `explicit` 同给时 `rating` 优先 + advisory。

### 5.2 定档（预检，确定性）

1. 显式 `rating` 输入优先。
2. 关键词升级（不静默，advisory `rating_escalated:<tier>`）：explicit 词表 = 现有 `EXPLICIT_SAFETY_MARKERS`；sensitive 词表 = swimsuit / bikini / lingerie / underwear / cleavage / seductive / 泳装 / 内衣 / 性感 等。双命中取高。

### 5.3 策略表（variant × rating，数据非提示词）

| rating | safetySeed（正向） | 负向追加 |
|---|---|---|
| safe | `['safe']`（现状） | — |
| sensitive | `['rating_sensitive']` | explicit 阻断：nude, nudity, genitals, rating_explicit |
| explicit | `['rating_explicit']` | 未成年人硬排除：child, loli, shota, toddler, kid, preteen |

- 质量锚点**不降档**：三档都保留 masterpiece / best quality / score_7（Pony 系共识：NSFW 也要质量词）。
- base/aesthetic/turbo 三个 variant 各自套用上表（aesthetic/turbo 维持其现有轻量负向基底，rating 行为一致追加）。

### 5.4 硬边界闸门（boundaries.ts，任何档位、任何 LLM 配置下都执行）

| 闸门 | 触发 | 行为 |
|---|---|---|
| `minor_content_conflict` | rating ≥ sensitive 且语料命中未成年特征词（loli/shota/child/toddler/kid/preteen/幼女/萝莉/正太/小学生/儿童/婴儿…；**不含** flat_chest 等成人身材特征词） | 硬拒绝，blocker error envelope，fail-fast |
| `nonconsensual_content_rejected` | 语料命中非自愿/性暴力词（rape/forced/non-consensual/强奸…） | 任何 rating 硬拒绝 |
| `bestiality_content_rejected` | 语料命中兽奸类词 | 任何 rating 硬拒绝 |

- 执行位置两道：**预检**（LLM① 之前，违规请求 0 token 拒绝）+ **终检**（装配后审计，兜底 LLM 扩写引入的升级词）。
- safe 档含儿童特征词**正常放行**（画家庭/儿童插画合法）——闸门是「档位×特征」交叉判定，不是一刀切词黑名单。测试必须覆盖这一正反例。
- 词表为确定性数据（可测试、可复现、不可被 LLM 说服）；裁决不由 LLM 参与。

### 5.5 H3 限制

H3（MiniMax 官方内容政策）只支持 safe：`target=h3` 且 rating ≠ safe → argument error（可操作错误信息），不做降级猜测。NSFW 预设 `applies_to=['anima']` 由 schema 校验强制。

## 6. 美学分析系统（prompt 侧，零 GPU）

### 6.1 确定性美学 gates（aesthetics/audit.ts，advisory 级，本期 anima 方言）

| gate id | 判定 | repair hint |
|---|---|---|
| `aesthetic_composition_missing` | 成稿 positive 无任一构图锚点（lexicon.composition ∪ composition 卡 tags） | 推荐 composition 卡 id 列表 |
| `aesthetic_lighting_missing` | 无光方向/造型表达（光源物件+明暗+色调写法；LIGHTING_BAN 兼容检查复用） | lighting 卡 |
| `aesthetic_palette_missing` | 无色彩方向词（调色/主色/色板） | color 卡 |
| `aesthetic_focal_missing` | 无焦点表达（景别/景深/主体强调） | perspective 卡 |

- 输出并入现有 `inspectAnima` AuditGate 列表（advisory，不阻塞出稿）；envelope 的 `aesthetics.gates` 可见。
- h3 不加确定性美学 gates（其美学覆盖由评委 atmosphere-coupling / camera-motivation 等维度承担），spec 明示此为有意分工。

### 6.2 卡推荐器（aesthetics/recommend.ts）

- 输入：蓝图 brief 维度缺失分析 + 触发的美学 gates + 预设 `art_direction_hints`（若适用）。
- 规则（每类至多 1 张，对齐现有约束）：video/动作意图 → motion 优先；lighting gate 触发 → lighting 卡；composition gate → composition 卡；face/情绪特写 → close_up 类。
- 输出 `{field, cardId, reason}[]`，注入 enrich user 段【推荐先验】块——LLM 仍做最终设计决策（保持「LLM 设计、规则兜底」哲学），不硬注入。

### 6.3 评委不动

ANIMA_RUBRIC 的 composition / lighting-color / aesthetic-vocabulary 三维（D10）已就位，权重与指令不改。避免与确定性层重复建设：gates 管「有没有」，评委管「好不好」。

## 7. LLM 提示词改动面（5 处，段落级）

| # | 文件 | 改动 |
|---|---|---|
| P1 | `blueprint/analyzer.ts` BLUEPRINT_PERSONA + `intent/subagent-provider.ts` BLUEPRINT_SUBAGENT_SYSTEM | +「内容分级识别」段：识别 rating 档、敏感词命中升档并显式写 core.rating（不静默不清洗）；BLUEPRINT_SCHEMA 加 core.rating |
| P2 | `enrich/personas.ts` buildEnrichPersona(anima) | +【内容分级】块（explicit=按 danbooru 成人 tag 词表直接扩写、禁委婉语；sensitive=性感不露骨；声明评级由管线强制）；+【推荐先验】块（推荐器输出） |
| P3 | `eval/critic.ts` buildPersona / buildRevisionPersona + `eval/rubrics/anima.ts` boundary | +评级中立条款：产物声明 rating 档时，该档合法词汇不得作为 finding（防止 explicit 档产生修复层无法执行的安全死信——与 negative-template 口径修订同类问题） |
| P4 | `continue/engine.ts` 注入点模板 | +「当前 rating=档位：修订不得降档、不得清洗或委婉化已声明内容、不得触碰硬边界负向」 |
| P5 | `optimize/mutate.ts` MUTATION_PERSONA | +变异候选不得触碰 rating 语义与硬边界规则（人审闸门不变） |

不改：H3_PERSONA / rubrics-h3（h3 仅 safe）、rubric 维度与权重、DEFAULT_PERSONA（可选跟一句）。

降级语义：enrich 在 explicit 档被用户 LLM 拒绝 → 现有故障语义回退 user brief 直拆 + advisory `enrich_refused_at_rating:explicit`；评委故障不阻塞（现状）。spec 附 route 选型建议（参照 NewBie 实证：grok-4.1-fast / deepseek-v3.2 对成人向扩写较稳），不强制换路由。

**R1 预留**：分步路由 `llm.routes.{enrich,judge}` 本期不做（违反 R1「零配置跟随会话」三环语义），仅记录。

## 8. 流程编排 v2（D6/D7 落地）

```
[意图 + rating 输入]
  → ◆预检：rating 解析/升级定档 + 硬边界闸门（违规 0 token 拒绝）
  → LLM① 意图分析（恒跑；blueprint_id 时带旧蓝图锚定做增量意图分析，最小 diff 产出新蓝图；失败 fail-fast 可重试）
  → ◆validateBlueprint（core.rating 校验）
  → ◆卡推荐器（先验）
  → LLM② enrich（可显式关闭）
  → ◆applyStyleV2（预设注入：fragments/负向/画师截断/卡提示）
  → ◆方言编译（POLICIES 按 variant×rating 出锚点/rating 标签/负向组合）
  → ◆审计：现有 gates + 美学 gates + 硬边界终检
  → LLM③ 评委（可显式关闭）→ needs_revision → 确定性修槽 → 重编译重审计 → LLM③ 复评（≤2 轮）
  → 出稿 envelope（+ rating / aesthetics / style 摘要）
```

- `blueprint_id` 语义变更：从「跳过 intent」到「增量意图分析」——成本从 ≈2 次升至 ≈3 次 LLM 调用（用户已接受），换来防整图重解释漂移（NewBie 最小化修订同款教训）。
- `audit_only` 从 prompt_author 移除；纯审计统一走 `prompt_audit` 工具（已存在，零 LLM，形状相同）。`preflight_only`（compile 工具）保留，与生成流程无关。
- 默认编排 = 完整流程（LLM①②③ 全开）；逃生门仅显式指定生效。

## 9. 工具面与 envelope

- **prompt_author**：+`rating` 输入；−`audit_only`；envelope 顶层新增（全部非阻塞）：
  - `rating: { resolved, escalatedFrom?, source: 'input'|'keyword' }`
  - `aesthetics: { gates: [...], recommendedCards: [{field, cardId, reason}] }`
  - `style: { id, name, category, injectedFragmentPhrases, artists, negativeAdded }`
- **style_list（新工具）**：`{ category?, rating?, applies_to?, query? }` → 预设摘要列表（id/name/category/rating/画师数/负向数/source）。只读零 LLM。
- **prompt_audit**：承接原 audit_only 用法（结构化输入直接审计），补 rating 输入。

## 10. 数据迁移（一次性，脚本 + golden 测试锁定）

nb*.json → v2 映射：`artists→artist_hints`（截断由 artist_max 控制）、`artist_max` 直传、`style_tags→base/theme`（style_tags 全部取值的映射表以常量形式落在迁移脚本中并被测试覆盖，不允许临场自由发挥；如 anime_style→anime 基底、realistic_shading→theme 修饰）、`rating` 直传（全部 safe）、`name` 直传、`id` 不变、`source: 'newbie-migrated'`；`fragments` 与 `negative_hints` 由 style_tags + 名称语义在迁移时 authoring（每条 2-4 短语，过 LIGHTING_BAN 与 catalog 验证）；补 `applies_to: ['anima','h3','sd']`（NSFW 迁移源不存在，无需特判）。

MINIMAL_STYLES 11 条 → JSON（source: 'builtin-migrated'），TS 侧保留 deprecated 兼容导出。

## 11. 测试与验收

- registry：82 条全量加载 / 非法文件 fail-fast / id 去重 advisory / rating 过滤 / applies_to 查询。
- applyStyleV2：negative 合并去重、artist_max 截断、conformity golden 不变、h3 通道忽略 negative（advisory）。
- 策略表：3 variant × 3 rating 锚点/种子/负向全组合断言。
- 边界闸门：minor×sensitive 拒绝、minor×safe 放行（正反例）、nonconsensual 任何档拒绝、bestiality 拒绝、升级词 advisory。
- 美学 gates：四类缺失各产出 advisory + 正确卡提示；LIGHTING_BAN 交互（卡 tags 不触发禁词 gate）。
- 推荐器：动作意图 → motion；缺光 → lighting；face 特写 → close_up；每类 ≤1。
- persona 断言：5 个提示词面包含新块；blueprint_id 走增量意图 persona；prompt_author schema 无 audit_only。
- 迁移完整性：55 条 id 唯一、artist_hints catalog 存在、nb rating=safe 保持。
- 基线：`npx vitest run` 831 passed 不回退；`npx tsc --noEmit` 干净；**src 改动必须 `npm run build` 同步 dist**（插件铁律，提交前执行）。

## 12. 里程碑

- **M1（机制全量）**：§4.1-4.3 schema/registry/apply、§5 三档+边界、§6 gates+推荐器、§7 五处提示词、§8 编排变更、§9 工具面、§10 迁移 55 条、§11 测试。交付后预设库即完整可用（55 条）。
- **M2（数据填全）**：§4.4 新增 27 条 authoring（含 NSFW 11 条）+ catalog 验证 + 存在性测试。纯数据里程碑，零机制改动。
- 后续（不在本 spec）：输出侧评分闭环（CLIP/偏好 RM 接 camera-* 产物与 prompt_feedback）、`llm.routes` 分步路由、feedback 反存预设。

## 13. 显式不做（YAGNI）

- LLM 破限框架（NewBie 路线，D4 否决）
- 输出侧 GPU 评分（D2 限 prompt 侧）
- 预设管理写工具（style_save 等——style_list 只读先行，反存走 feedback 二期）
- 风格预设的 token 预算 gate（现有 budget 审计已覆盖）
- expand/reverse 内置 profile 的 rating 变体（用户自定义 profile 范畴）
