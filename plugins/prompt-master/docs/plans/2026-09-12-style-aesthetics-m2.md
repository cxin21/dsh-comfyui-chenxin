# M2 实施计划：数据填全 + 遗留机制收尾（style-aesthetics-nsfw）

**日期**：2026-09-12　**前置**：M1 已收官（t33 终审 pass，基线 1051 passed / 1 skipped / 0 failed）
**spec**：`plugins/prompt-master/docs/specs/2026-09-12-style-aesthetics-nsfw-design.md`（§4.4 新增 27 条表、§5、§12 M2 里程碑）
**执行**：同一团队（impl-1 / impl-2 / reviewer）subagent-driven，captain 裁决与终审。

## Global Constraints

1. 铁律沿用 M1：改 src 必 `npm run build`（dist 不入 git）；提交单意图 + spec 章节标注；基线 1051 不得回退；不碰 skills/** 与 camera 资产；命令在 `plugins/prompt-master/` 下执行。
2. **spec 勘误（captain 裁定）**：§12「NSFW 11 条」为笔误，以 §4.4 表为准 **10 条**（sensitive 6 + explicit 4）；27 = 17 safe + 10 NSFW。
3. **新增预设 authoring 规则**（全部落进 m2-authoring.test.ts 质量门）：
   - v2 schema 全字段：id/name/base/theme/palette/fragments{image,video 各 2-4 短语}/negative_hints ≥1/artist_hints/artist_max(≤3)/category/rating/applies_to/source='hand-authored'；
   - `rating='sensitive'|'explicit'` ⇒ `applies_to` 恰为 `['anima']`（validateStylePreset 强制）；
   - fragments 过 VAGUE_WORDS（cinematic/beautiful/大气/电影感）与 LIGHTING_BAN；
   - **artist_hints 逐一经 catalog_search 验证存在**（裸名），验证失败留空数组（explicit 档允许空）；NSFW 档 artist_hints 一律留空（避免画师风格与分级内容强绑定的伦理噪声）——比 spec「允许为空」更收紧，captain 裁定；
   - 锚点 tag 方向与负向方向以 spec §4.4 表为种子，authoring 时扩为具体名词短语（禁抽象词）；
   - **硬边界红线**：任何预设任何字段不得含 MINOR_MARKERS 词（census 断言自动覆盖——t38 的空集断言扫描全部预设）；explicit 档 fragments 用 catalog 已验证的成人向直白词（禁委婉语），但不得出现非自愿/兽类语义。
4. **评审纪律**：每任务一个 review 任务（kind=review，verdict 门控下游）；reviewer 发现问题 → needs_revision → captain 派修复 → 重审。**派发纪律（M1 教训）**：评审任务一律 captain 在被评审任务 terminal 后 reassign 派发，绝不让其提前进池。
5. M2 遗留清单（终审单列项）全部入本计划：kidmo 两级匹配（T1）、declaredRating 接线（T2）、迁移工具入库（T3）、h3 negative_hints advisory（并入 T2 任务面）、cap 活体验证（T10 自然达成）、style_id 描述 55→82（T10）。

## Tasks

### T1 边界词表两级匹配（机制，TDD）
- **Files**：`src/pe-framework/safety/boundaries.ts`、`tests/pe-framework/safety/boundaries.test.ts`、`tests/pe-framework/dialect/anima-rating.test.ts`（回归同步）
- **内容**：checkBoundaries 匹配升级——ASCII marker 用 `\b<marker>\b` 大小写不敏感词边界；CJK marker 保持 substring includes；MINOR_MARKERS 增补复合变体 `lolita`/`lolicon`/`shotacon`（词边界下 bare `lolita` 仍命中、`lolita_fashion` 因 `_` 不构成边界而**放行**——这是本裁定的政策语义：时装合法、裸词风险，写入测试注释）。kidmo@sensitive 场景回归：含 kidmo 语料不再误报 minor_content_conflict。
- **verify**：`npx vitest run tests/pe-framework/safety tests/pe-framework/dialect` + 全量
- **Commit**：`feat(safety): two-tier marker matching (ASCII word-boundary / CJK substring) + compound variants (spec §5.4, M2 item)`

### T2 declaredRating 编排器接线 + h3 negative_hints advisory（机制，TDD）
- **Files**：`src/tools/prompt-author.ts`、`src/pe-framework/eval/critic.ts` 或 continue 调用点（以实际 grep 为准）、`src/pe-framework/dialect/h3.ts`（advisory 一处）、对应测试
- **内容**：①judge/continue 通道透传 declaredRating=resolved.rating（T13 四接线点从 prompt_author 流可达——评级中立条款生效）；②h3 侧 negative_hints：applyStyleV2 对 target=h3 时 negative_hints 不丢弃，出 advisory `style_negative_hints_h3_ignored:<id>`（spec §4.3 备注；仍不注入 h3 negative——仅可观测）。
- **verify**：`npx vitest run tests/tools tests/pe-framework/eval tests/pe-framework/dialect` + 全量
- **Commit**：`feat(author): declaredRating wired into judge/continue + h3 negative_hints advisory (spec §7 P3, M2 item)`

### T3 迁移工具入库（housekeeping）
- **Files**：`migrate-nb-v2.mjs` → `scripts/migrate-nb-v2.mjs`（移动 + 头注释：用途/幂等性/LIGHTING_BAN 全词表扫描说明）
- **Commit**：`chore: commit nb migration tooling with provenance header (M2 item)`

### T4 预设批 A：photography 7 条（数据）
film_photography / studio_portrait / documentary_photo / fashion_editorial / night_street / sports_action / wildlife_nature（锚点方向见 spec §4.4 表 118-124 行）
### T5 预设批 B：cg_3d 3 + oriental 2（数据）
unreal_render / figure_model / claymation_clay / ink_wash / hanfu_xianxia
### T6 预设批 C：dark 2 + retro 2 + graphic 1（数据）
gothic_vampire / eldritch_horror / showa_retro / vintage_photo / poster_constructivist
### T7 预设批 D：glamour sensitive 6（数据，NSFW）
boudoir / lingerie_fashion / beach_swimwear / pinup_retro / glamour_portrait / after_dark——性感不露骨；negative 一律 explicit nudity 阻断方向
### T8 预设批 E：glamour explicit 4（数据，NSFW）
artistic_nude / explicit_solo / explicit_couple / explicit_fantasy——fragments 词表经 catalog 验证填全（rating_explicit 系 canonical 可用）；artist_hints 留空；硬边界红线自查
- **T4-T8 共同验收**：27 条分批全过 m2-authoring.test.ts（validateStylePreset 逐条 + VAGUE/LIGHTING_BAN 零命中 + applies_to 规则 + MINOR census 空集 + id 唯一 + stylePresetCount 递增至 82）；style_list 活体 cap 语义用例（sensitive/explicit 数据在库后各档过滤数断言）随 T8 收口；每批单意图提交 `feat(styles): author <batch> presets (spec §4.4)`
- **T4-T8 评审重点**：fragments 抽查 ≥5 条/批的语义质量（锚点方向执行度）、catalog 验证留痕、NSFW 批红线自查

### T9 m2-authoring 质量门测试（先于 T4 落地，随 T4-T8 逐批收紧）
- **Files**：`tests/pe-framework/styles/m2-authoring.test.ts`（总账与共享规则）+ 各批独立测试文件 `m2-authoring.a~e.test.ts`（避免同文件并发竞写）
- **内容**：①m2-authoring.test.ts——27 条清单驱动存在性骨架（T4 开工前 RED：0/27）+ 共享规则断言（MINOR census 空集扫描全部 82、VAGUE/LIGHTING_BAN 全库零命中、applies_to 规则）②每批交付自己的 `m2-authoring.<x>.test.ts`（批内逐条 validateStylePreset + 锚点方向执行度抽查断言）③T8 收口时总账断言 stylePresetCount()===82 + 类别总账（photography 8/anime 25/illustration 17/cg_3d 6/oriental 4/dark_supernatural 3/scifi_fantasy 2/retro 3/graphic 4/glamour_intimate 10）+ style_list 活体 cap 用例
- **Commit**：骨架随 T4 首批合并（RED→GREEN）；各批测试文件随批提交

### T10 全量验证 + 文档终态（收口）
- **内容**：全量 vitest 0 failed；tsc/build；dist 冒烟 stylePresetCount()===82；style_id 描述 55→82；cookbook 55→82 两处；style_list cap 活体断言已在 T8；catalog 变更无需（预设为数据）
- **Commit**：`docs: M2 closeout - preset library 82 (spec §4.4)`

## 依赖图

```
T1(边界匹配) ─┐
T2(接线)  ────┤（三者无相互依赖，可并行）
T3(工具入库) ─┘
T9(质量门骨架) ──→ {T4 ∥ T5} → {T6 ∥ T7} → T8 → T10
（T4-T6 走安全/数据成员均可；T7 NSFW 批单成员独立完成；T8 explicit 批同上）
每任务一个 review（T1R/T2R/…/T10R），T10R 后 captain 终审
```

## 执行注记

- 预设批两成员并行：{T4,T5} 与 {T6,T7} 两波，批间测试文件独立（m2-authoring.a~e.test.ts）零竞写；共享文件 m2-authoring.test.ts 的骨架断言只在 T9/批次收口时由 captain 指定单成员追加。
- NSFW 批（T7/T8）由单成员独立完成（impl-2），不并行拆分——内容敏感度需要单一作者一致性。
- M1 教训固化：评审任务 captain 时机派发；计划缺陷按「测试为验收标准」裁决并记偏差；repo 唯一（preset 根=git 根）。
