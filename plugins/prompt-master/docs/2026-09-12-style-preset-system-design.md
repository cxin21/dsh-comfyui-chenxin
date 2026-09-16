# 风格预设系统设计（style presets + theme packs + 内容分级门控）

> 状态：设计稿，待批准后实施。
> 目标：把 NewBie 的「画师栈+风格词汇栈」与 SD-Anima-Prompt-Studio 的「主题组合包+分级门控」
> 两种被验证的模式，落成 prompt_author 的一等参数，支持 safe → explicit 全分级。

## 1. 目标与原则

1. 一键美学：`style_preset` 一个参数得到完整美学方向（画师栈 + 风格词汇 + narrative 风格句）。
2. 证据纪律：包内每个 artist/tag 必须 catalog exact 验证通过才能入库（同画师白名单纪律，杜绝编造）。
3. 数据可扩展：预设/主题包是数据文件（目录 + JSON schema），用户可自行增改，不进代码。
4. 分级门控：内容分级（safe/sensitive/nsfw/explicit）是一等属性，配置开关 + 参数双层门控。
5. 最小惊讶：未传新参数时行为与现状逐字节一致。

## 2. 资产模型

```
plugins/prompt-master/
  assets/
    style_presets/          # 风格预设（每文件一个包）
      nocturne_wuxia.json
      rain_neon.json
      ...
    theme_packs/
      petal_storm.json
      battle_worn.json
      ...
```

### 2.1 风格预设 schema（style_presets/*.json）

```jsonc
{
  "id": "nocturne_wuxia", // 必填，唯一
  "name": "月夜武侠", // 必填，展示名
  "rating": "safe", // 必填：safe | sensitive | nsfw | explicit（本包最高分级）
  "artists": ["wlop", "ask (askzy)", "konya karasue"], // 每个必须 catalog canonical 验证
  "artist_max": 3, // 注入 artist 槽时的最大取用数（缺省 3）
  "style_tags": ["cel shading", "limited palette", "high contrast", "film grain"],
  // 风格词汇栈：注入 enrich style 维度的候选词表
  "narrative_style": "Cool moonlit palette with crimson accents; sharp blade highlights.",
  // 可选：narrative 风格基调句（注入 enrich persona 尾注）
  "theme_pack_ids": ["petal_storm"], // 可选：联动主题包
  "notes": "月夜冷调武侠；配合 er_sde 45 步",
}
```

### 2.2 主题包 schema（theme_packs/*.json）

```jsonc
{
  "id": "battle_worn",
  "name": "战损",
  "rating": "safe",
  "slot": "any", // 注入目标槽偏好：any(按语义) | clothing | detail_mood | scene
  "tags": ["torn clothes", "battle scars", "dust", "smoke"], // 全部 catalog exact 验证
  "narrative_hint": "torn fabric and drifting dust catch the low light", // 可选：NL 补句素材
  "conflicts": ["pristine"], // 可选：与其他包/标签的互斥声明
}
```

## 3. 分级模型与门控

### 3.1 分级（对齐 danbooru rating 体系与 Anima 模型原生 rating tag）

| 级别      | 含义                              | 管线行为                               |
| --------- | --------------------------------- | -------------------------------------- |
| safe      | 全龄                              | 注入 `safe` 种子（现状不变）           |
| sensitive | 性感/暗示（泳装/湿身/体检级暴露） | 不注 safe，改注 `sensitive` rating tag |
| nsfw      | 成人向裸露/性暗示                 | 不注 safe，改注 `nsfw`；需配置开关     |
| explicit  | 显式                              | 不注 safe，改注 `explicit`；需配置开关 |

### 3.2 门控矩阵（fail-closed）

| 条件                                                               | 行为                                              |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| 配置 `nsfw_enabled: false`（缺省）+ 请求 rating ∈ {nsfw, explicit} | 报错 `rating_blocked`（可操作错误，不是静默降级） |
| 预设 rating 高于请求 rating                                        | 拒绝该预设（报错列出可选预设）                    |
| 预设 rating ≤ 请求 rating                                          | 允许                                              |
| 未传 rating                                                        | 缺省 safe（现状不变）                             |

配置项：`registerAuthorTool(ctx, config)` 的 config 增 `nsfw_enabled: boolean`（agent.cordis.yml 可设）。
真实出稿时安全种子逻辑对齐现有 `isExplicitRequest(slots)`：rating ≥ nsfw 时不再注 safe 种子、
改注对应 rating tag 进 camera 槽后段（rating tag 是模型原生控制，Animagine 4.0 官方文档 §Rating Tags）。

## 4. prompt_author 参数接线

```jsonc
{
  "target": "anima",
  "input": "古风美女舞剑：...",
  "style_preset": "nocturne_wuxia",   // 新增，可选
  "rating": "safe",                   // 新增，可选（缺省 safe）
  "theme_packs": ["petal_storm"],     // 新增，可选（数组，可多包）
  "art_direction": { ... }            // 既有参数不变
}
```

优先级与冲突规则：

- `style_preset.artists` 追加进 artist 白名单（仅本次调用有效），intent 的 3a 清单块同步扩展标注「预设画师」
- `style_preset.style_tags` + `theme_packs[*].tags` 注入 enrich user 段「预设风格/主题词汇（原样采用，已验证）」块，
  与 catalogCandidates 同通道但独立标注
- `narrative_style` 注入 enrich persona 尾注（一行）
- `theme_packs[*].tags` 在 compile 期同样走 P2' 证据流（miss → drop，不豁免）
- 忽略路径补 advisory（如 `style_preset_ignored_h3`），沿用 art_direction 的可观测模式

## 5. 校验与安全

1. **加载期**：JSON schema 校验（id 唯一、rating 枚举、artists/tags 非空字符串数组）。
2. **验证期**：包内每个 artist/tag 调 searchCatalog，非 canonical/alias → 拒绝入库（启动/加载时报错并列出未验证项）。
3. **请求期**：id 不存在 → `invalid_request`；rating 门控 → `rating_blocked`。
4. **测试**：每个预置包一条快照测试（包内 tag 全部 catalog 命中）；门控矩阵 4 条。

## 6. NSFW 支持细节

- 架构完全支持 nsfw/explicit 分级：预设文件、theme pack、rating 参数、门控、rating tag 注入全部设计到位。
- **explicit 层的词表 = 用户策展内容**：数据文件格式自解释，用户按 danbooru canonical 纪律自行
  策展并逐 tag 验证入库；交付的预置包覆盖 safe/sensitive 两级（月夜武侠/雨夜霓虹/薄暮战损/花雨和风/
  泳装夏日(sensitive)/湿身雨夜(sensitive)）。
- 门控缺省关闭 nsfw/explicit，需在 agent.cordis.yml 显式 `nsfw_enabled: true`——
  双层确认（配置 + 请求参数）后才生效，符合 fail-closed。

## 7. 预置内容草案（交付时含 safe/sensitive 各包的完整验证记录）

| id             | rating    | 画师栈（候选，入库前逐个验证）   | 风格词汇                                                | 主题包联动  |
| -------------- | --------- | -------------------------------- | ------------------------------------------------------- | ----------- |
| nocturne_wuxia | safe      | wlop, ask (askzy), konya karasue | cel shading, limited palette, high contrast, film grain | petal_storm |
| rain_neon      | safe      | guweiz, mika pikazo, miv4t       | vibrant colors, high contrast, crisp                    | rain_city   |
| dusk_battle    | safe      | rella, ciloranko, quasarcake     | dramatic shadow, muted colors, thick outline            | battle_worn |
| hanami_spring  | safe      | kantoku, mika pikazo, rella      | soft pastel tones, clean line art, airy                 | petal_storm |
| summer_swim    | sensitive | (验证后定)                       | wet skin, water reflection, summer aesthetic            | —           |
| wet_rain_night | sensitive | (验证后定)                       | wet clothes, clinging fabric, neon signs                | rain_city   |

## 8. 实施分解（每阶段 commit + 测试）

- **阶段 A（分级骨架）**：assets 目录 + schema + 加载器 + `rating` 参数 + 安全种子/rating tag 策略 +
  `nsfw_enabled` 配置 + 门控测试 4 条
- **阶段 B（风格注入）**：`style_preset` 参数 + artist 白名单临时扩展 + enrich 注入块 +
  `theme_packs` 参数 + 编译期 P2' 联动 + 测试
- **阶段 C（内容）**：6 个预置风格包 + 3 个主题包（逐 tag catalog 验证记录）+ 快照测试
- 回归：全量 vitest ≥ 969 基线；`judge_mode:off + enrich:false` 与现状逐字节一致（最高约束）

## 9. 与既有机制的关系

- art_direction（设计决策五卡）与 style_preset（美学方向包）正交：可同时传，先 style_preset 定调、
  art_direction 微调
- P2' 证据流对包内 tag 一视同仁（miss → drop），包内 tag 因经过预验证，drop 率趋近零
- 蓝图 LLM 不受影响（blueprint_id 路径不消费 style_preset；增量改稿的美学延续由蓝图自身承载）
