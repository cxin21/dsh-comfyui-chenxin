# Round 8 实施计划：narrative 排除 + 软预算 + 空泛词

> Spec：`docs/2026-09-09-round8-narrative-budget-design.md`。基线：854（HEAD aa7ce35）。

### Task 1: F6 narrative 默认排除 + F8 空泛词拦截

**Files:** `src/pe-framework/dialect/anima.ts`（装配排除 + VAGUE_TAGS 词表 + vague_tag gate）、测试；golden 更新列清单
**规格:** narrative 排除（allowNarrative 出口 + advisory）；vague_tag minor 逐词；质量词白名单；回归（allowNarrative=true 时 F1 去重仍生效）

### Task 2: F7 tag 软预算闸门

**Files:** `src/pe-framework/dialect/anima.ts`（tag_budget_exceeded important gate + 阈值常量）；测试（超 tag 数/超字符/达标不触发/闭环 feedback 含 gate）
**规格:** >40 tags 或 >1200 chars → important；与修正闭环联动。**阈值依据调研**（DTG/DART 档位表：20-40 为 short/long 档，60+ 最差档）

### Task 2Q（调研驱动追加）：提示词质量层改写

**Files:** `src/pe-framework/intent/subagent-provider.ts`（ANIMA_PERSONA/SCHEMA 重写）、`src/pe-framework/enrich/personas.ts`（anima persona 补 tag 化准备指引）、`src/pe-framework/dialect/anima.ts`（负向模板补官方四项；narrative 条件纳入取代默认排除——narrative 通过 NL 质量检查（2-4 句英文、非 tag 罗列）则纳入，否则排除+advisory）
**规格（依据调研报告）:**

1. ANIMA_PERSONA 重写为「锚定补全」模式：enrich brief 为锚，tag 块预算 20-40（先主体后场景）、场景槽 ≤3 锚点、多词概念必须转词表内规范 tag（小写空格）、禁空泛词（beautiful/atmosphere 类）、narrative=2-4 句英文 NL 场景块（场景/光影/动作氛围，禁止复述槽位短语）
2. 负向模板：`worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration`（官方）
3. narrative 条件纳入：NL 检查（2-4 句、全英文、句长合理）通过→纳入 positive（NL 场景块）；不通过→排除+advisory（取代 Round8 T1 的默认排除）
4. 测试：persona 指令断言（预算/词表/配额/NL 块）、负向模板、narrative 合格纳入/不合格排除
   **依据来源**：调研报告 §1（档位表/顺序即权重）、§2（官方规范/NL tips）、§3（锚定补全/两段式）、§4（混合方言）

### Task 3: 实战复测 + 生图验证 + 修剪版对照 + 终审 + 登记

- 用户提供实战 prompt 的同款 slots 实测（mock）：narrative 不出现、预算 gate 触发、vague 词被标
- 手工修剪版 prompt 作为附录（对照）
- 独立终审 + TASK_TRACKING Round 8 登记

## Self-Review

覆盖 F6/F7/F8；无占位符；F6 golden 更新授权已注。
