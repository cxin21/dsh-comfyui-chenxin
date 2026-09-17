# Task 3Q Report (Round 8): 美学与设计感升级——艺术指导卡片内置

- 状态：**DONE**
- Commit：`73caaf0` `feat(enrich): 艺术指导卡片内置——美学与设计感升级 (Round8 T3Q)`（8 files, +392/-7）
- 基线：实现前 HEAD 实为 `0d131c3`（brief 写 2e1c844，其上另有 1f45be7 docs、0d131c3 subagent timeout 两笔提交，非本任务产物）

## 测试摘要

- `npx vitest run tests/pe-framework/enrich/ tests/plugin/author-enrich.e2e.test.ts` → 3+1 文件、56 tests 全 PASS
- `npx vitest run` 全量 → **104 files / 900 passed | 1 skipped / 0 failed**（brief 基线 880 + 本次新增 20 = 900，自洽）
- `npx tsc --noEmit` OK；`npm run build` 已执行（dist 本机同步；dist 在 preset 层 gitignore，不入提交）

## 落地内容（对照 brief A-D）

### A. 设计卡片库 `src/pe-framework/enrich/art-direction.ts`（新增）

- `ArtDirectionCard { id; name(中文设计意图名); tags(3-5 个英文组合拳) }`
- 5 类 36 张：`PERSPECTIVE_CARDS`(8) / `COMPOSITION_CARDS`(8) / `LIGHTING_CARDS`(8) / `COLOR_CARDS`(6) / `MOTION_CARDS`(6)，内容按 brief 逐条落地（「烛光/灯火」命名微调为「烛光灯火」避免 name 内斜杠）
- `ALL_ART_DIRECTION` 五类总表；`isKnownCardId(field, id)` 按类目寻址校验；`buildArtDirectionMenu()` 渲染 id+name+tags 选择清单

### B. anima persona「艺术指导课程」（`personas.ts`，+7 行）

按 brief 五条逐字落地（插入在「输出」指令之前）：先从四类设计卡选组合拳 → 所选 tag 写入 composition/lighting/color（source=enriched）并回填 artDirection → 动作场景必含动势卡 → 服装五件套（材质颜色+剪裁+纹样+动态+轮廓，含 hanfu 示例）→ 设计决策服务情绪叙事。关键词「艺术指导」「设计决策」「五件套」均有 persona 断言（engine.test）。h3 persona 不动。

### C. schema 扩展与校验（`brief.ts` + `engine.ts`）

- `EnrichedBrief` 新增可选 `artDirection?: { perspective?/composition?/lighting?/color?/motion?: string }`（新导出 `ArtDirectionSelection` 类型）
- `validateBrief`：字段缺省 → 完全兼容（输出 brief 无该键）；出现即逐字段校验——非串/未知 id/跨类目 id → `ok:false reason='invalid_art_direction'`；未知子键丢弃（与顶层多余键被丢弃的既有口径一致）；`{}` 视为未选择，不产出空 artDirection
- `runEnrich` 降级映射：`invalid_art_direction` 与 `brief_too_large` 同款——专属 reason 保留，不归并进 `enrich_invalid_schema`，整体 skipped（永不静默修补）
- `buildSchema(target)`：anima 的 schema 增加 artDirection 形状（各字段标注「卡片 id（可省略）」）；h3 schema 不含
- `buildUser`：anima user 段追加 `buildArtDirectionMenu()` 卡片清单供选卡；h3 user 段不变

### D. 测试（TDD，先红后绿，全程未派生 subagent）

1. `tests/pe-framework/enrich/art-direction.test.ts`（新增，5）：5 类 36 张 / id 全局唯一 / name 中文 tags 3-5 / `isKnownCardId` 类目寻址（跨类 id 拒绝）/ menu 含全部 36 卡
2. `brief.test.ts`（+8）：缺省兼容 / 全五类合法 id 保留 / 子集保留 / 未知 id → invalid_art_direction / 跨类目 id → 同 / 非串与 null → 同 / 非对象 → 同 / 未知子键丢弃 + `{}` 不产出空键
3. `engine.test.ts`（+4）：anima persona 关键词、h3 persona 负断言 / anima user 菜单+schema artDirection、h3 负断言（范围钉死）/ 合法 artDirection 透传 / 未知 id → skipped invalid_art_direction
4. `author-enrich.e2e.test.ts`（+3）：含 artDirection 的 mock brief → `envelope.enrichment.brief.artDirection` 原样透传且出稿流程不回归 / 旧形状 brief（无 artDirection）照常通过（向后兼容硬约束）/ 未知 id → `enrichment={skipped,reason:'invalid_art_direction'}` + advisory `enrich_skipped` + intent 吃原文照常出稿

## 决策与偏差（均已在代码注释标注 Round8 T3Q）

1. **卡片清单注入五类而非四类**：brief C 写「user 段附上四类卡片清单」，但 artDirection schema 含 motion 子字段且 persona 第 3 条要求动作场景必选动势卡——只给四类清单时 LLM 拿不到合法 motion id，机制无法自洽，故注入全部五类（`ALL_ART_DIRECTION` 唯一数据源不变）。
2. **卡片 id 为本次定义**：brief 未规定 id 体系，按语义定义 36 个全局唯一蛇形 id（low_angle / diagonal_dynamics / rim_backlight / flowing_dress…），有结构测试钉住唯一性与形状。
3. **校验按类目寻址**：`artDirection.lighting='rule_of_thirds'`（构图卡填进光影）也判 invalid_art_direction，比「id 须在 ALL_ART_DIRECTION 中」的字面口径更严格；因 id 全局唯一，不影响合法选择。
4. **范围钉死 anima**：persona/schema/user 三处的卡片内容仅 anima 生效（有 h3 负断言）；validateBrief 的校验对两 target 生效（schema 层，h3 LLM 不输出该字段即无影响）。
5. **artDirection 不进 briefToIntentText**：卡片 tag 由 LLM 按 persona 写入七维度（组合拳真正生效面），artDirection 本身是设计决策的可追溯元数据；brief 未要求改 intent 投影，未动。
6. **e2e 多加第三条降级用例**：brief D4 列两条（透传+兼容），补一条 unknown-id 降级 e2e 钉住接线层 advisory 行为，不与 brief 冲突。

## Concerns

- 工作区存在他人 WIP 脏文件（`src/pe-framework/profiles/storage-v2.ts`、`src/plugin/index.ts` 的 register-or-reuse 改动），已确认未混入本次提交；本任务对其无依赖。
- 校验严格口径（null/跨类目 → 整体 skipped）在生产 LLM 偶发输出不规范 artDirection 时会让该次 enrich 整体降级（advisory 可观测、出稿不中断）；若实战发现误杀率高，可放宽为「非法字段丢弃 + advisory」，属后续小改。
- 卡片 tag 组合拳的实际美学效果需实战出稿验证（本任务只保证机制与可追溯性）；36 张卡是首版经验集，词表可持续微调。
