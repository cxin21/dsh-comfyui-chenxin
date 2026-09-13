# M5 实施计划：默认路径蓝图形态迁移（style-aesthetics 续 II）

**日期**：2026-09-13　**前置**：P0 修复（2b4c245）+ M5 候选文档（1992ad1）+ 真实会话验尸结论
**来源**：用户裁定「最小修复 + 蓝图迁移立项」→ 本里程碑实施立项一；立项二（版本戳）另排队不在本计划
**执行**：设计稿 wave 前置——T1 设计稿过审后，T2+ 实现任务契约允许按设计稿修订（走 M4 式计划修订流）。

## 迁移定性（为什么做）

spec §8 字面流「意图分析→蓝图→validateBlueprint(core.rating)→投影→编译」在标准 anima 路径未落地：现行默认 = ANIMA_PERSONA slots 直译（`{slots}` 无蓝图），core.rating 注入与 enrichBlueprint 扩展层、修复轮蓝图锚定均只在 blueprint_id 增量入口可达。真实会话两轮实证的档位/锚定问题根源在此。

## Tasks

### T1 蓝图形态迁移设计稿（docs，零实现）
- **Files**：`docs/specs/2026-09-13-blueprint-form-migration-design.md`（新建）
- **内容契约**（评审标准 = 能否据此直接写实现任务）：①路由切换点定夺：subagent-provider `isBlueprint`（L101）对 target='anima' 的开启机制——dialect registry intent 形态标志 vs 硬切，取舍留痕②BLUEPRINT_SCHEMA/parseBlueprintJson/validateBlueprint 的方言参数化现状核验（anima 蓝图 schema 是否需要适配层）③投影链现状：projectToAnima core.rating→slots.rating（2b4c245 已修 ✓）+ 其余投影缺口清点④兼容双态：slots 直译路径保留形态、回滚策略⑤golden 对照方案：抽样输入集与等价性判据（slots 主干字段 diff 容差、NSFW 档端到端断言）⑥e2e 重放清单与全量重放计划⑦风险清单：token 画像变化/子代理超时（300s 基线）/失败模式/与 style_list 82 预设的 art_direction_hints 交互。
- **Commit**: `docs(spec): blueprint-form migration design draft (M5 T1)`

### T1R 设计稿评审
- 验收：六要素齐且可执行；路由取舍有据；golden 判据可机检；「能否据此写实现任务」= pass 线。

### T2 provider 路由切换 + 编排接线（实现，契约以 T1 设计稿为准）
- 预登记范围：subagent-provider 蓝图分支对 anima 开放、dialect registry 接线、prompt-author 默认路径产出 `{blueprint}`（L905 注入天然生效）、**修复轮 core.rating 重注入**（impl-2 备案缺口#2，L949-957 实证残留）、envelope 蓝图痕迹（trace/observability）。
- T1R 过后按设计稿补全 in-scope 与验收（计划修订流）。

### T3 deepMerge 硬化（实现，小）
- enrichBlueprint 扩展层对 core 安全字段（rating）的信任边界（缺口#3）——LLM patch 不得覆写 core.rating；专测钉死。

### T4 golden 对照 + NSFW 端到端 + 全量重放（实现）
- 按 T1 设计稿方案执行：抽样等价性、explicit 档端到端（种子/负向/一致性）、全量重放零回退。

### T5 M5 收口（docs-only）
- 全量隔离验证 + tsc/build + dist 冒烟 + AGENTS.md/cookbook 终态核对 + 工具计数/预设数不变声明。

## 依赖图

```
T1(设计稿) → T1R → T2(路由切换+接线) → T2R
                  → T3(deepMerge 硬化) → T3R     （T2/T3 可并行，均依赖 T1R）
T2+T3 过审 → T4(golden+重放) → T4R → T5(收口) → T5R → M5-FINAL
```

## 执行注记
- 11 任务（T1-T5 + 5 评审 + FINAL——T1R/T2R/T3R/T4R/T5R + FINAL = 6 评审，共 11）。体量：设计稿 wave 轻，实现 wave 中。
- 教训继承：in-scope 强制列入「写入必经」的 normalize/白名单/校验相邻层（P0 第 3 次教训）；全量回归不与重 CPU 并行（t2 验证纪律）；提交前插件目录 tsc。
- 立项二（版本戳）、SD 方言设计稿、strict patchAnima（缺口#1）不在本计划，留台账。
