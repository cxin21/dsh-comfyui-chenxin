# H3 导演管线 终验修复计划（SDD 终验偏差处置）

> 依据：2026-09-18 终验审计报告（设计文档 ↔ 实现逐条对照，04a29f6..ee23655）。
> 用户裁决：全部未完成项立项修复，按序执行；每项完成须结合设计文档 + 第一性原理分析实现正确性，
> 重新编译并以真实数据测试；每完成一项回填本文档（spec 驱动纪律）。

## 0. 目标定义（完整验收目标）

**G**：H3 智能体导演管线达到 spec v2.3 全条款一致——

1. P0×3 契约断裂修复（工程落盘接线 / speaker ID 跨镜注入 / 两段式确认续跑）；
2. P1×10 语义缺口修复（4 机器门落位、meta/props 产出链、S5 路由精确化、首 Beat handoff、
   reference 绑定、envelope status、版本登记、参数声明面、runEnrich 死调用）；
3. P2×8 文档/谓词滞后修复（描述文案、severity、l2va、core_theme 双语、persona 内容缺口、
   G-sound 子谓词、增量重跑、方言解耦投影）；
4. spec/plan 文档同步回填（含 S5 粒度投影裁决写入 spec §7）；
5. 全量回归门：vitest 全量绿 + tsc 0 + eslint 0 error + build OK + anima 零触碰；
6. 真实数据集成验证：dist 直连多角色剧本全链（落盘三件套 / speaker ID / 版本台账 / 预算计数 /
   参考绑定 / 续跑）；DSH 重载后活体终验清单移交。

**约束**（沿实施计划 Global Constraints）：anima 零触碰；rules-h3/safety 零触碰；
src 改动提交前 build；单任务单提交标注 spec 章节；回归门全量绿。

## 1. 条款清单与执行顺序（依赖序）

| # | 级别 | 条款 | 设计要点（第一性原理决策） | 状态 |
|---|------|------|---------------------------|------|
| R1 | P1-⑤ | 首 Beat handoff 误拦（spec §6 G-handoff 限定非首 Beat） | ir-schema 逐镜循环 handoff 检查加 `bi>0` 条件，删除重复二次扫描；新增「首 Beat 空 handoff 合法」反例测试（修复前 RED） | ✅ |
| R2 | P0-2 | speaker ID 跨镜注入（spec §6.1② characters[].id 直接注入） | dialect 发射层增**可选** `opts.speakerIds` 覆盖（缺省=现行 collectSpeakerIds，golden 逐字节不变——在 §6.1 对白发射层授权面内）；orchestrate 逐镜编译注入 `speakerId=direction.dialogue.speaker_id`（机检已保证 ∈characters）、`label=character.name`（身份短语用角色名，官方格式 `Name (S1) says:`）；备选方案「post-hoc 正则改写编译文本」否决（脆弱、绕过确定性编译单点） | ✅ |
| R3 | P1-⑥ | reference_plan 绑定进编译（spec §4 Δ3/§6 G-refbinding） | orchestrate 编译入参按 reference_plan 构造 references：identity_subject→角色 appearance_lock、location_subject→spatial_landmarks、prop_subject→道具名+态；who 键=R2 的 label（与 shot.who 一致，保 applySubjectLabels 对齐）；图片路径本身属 D-U3 执行面，不伪造 | ✅ |
| R4 | P1-①a | G-dialogue 逐字对账 + 标签内禁冒号/角色名（spec §6 Δ4） | checkDirectingIr 增 `scriptText` 选项（实施计划 Task 3 本就规划）；谓词=对白文本 ∈ script 逐字包含 + 无冒号 + 不含任何 characters[].name；critical | ✅ |
| R5 | P1-①b | G-cameramotion 结构谓词（spec §6 R4） | 可确定性机检的部分=camera 字段含运动语汇（双语词表：机位·运动 结构）+ 非空；「自然英语三维语法」属 S3 persona 纪律面（LLM 轨），机检不装懂语义——记入 spec 投影注记；critical | ✅ |
| R6 | P1-①c | G-cutgrammar 复用落位（spec §6 R4/既有机检） | 编译步骤逐镜接 auditH3Full（rules-h3 现行机制，零修改），findings 并入 gates（source='directing/h3-audit'）——spec「复用」语义兑现；异常捕 Suitable advisory | ✅ |
| R7 | P1-①d/B20 | G-budget tokenizer 精确计数 + token_count 落值 | 编译步骤逐镜 buildH3Budget（官方 tokenizer 现行机制）；over/token_over/char_over→G-budget critical；shot.prompt.token_count=report.text_tokens（修 B20 恒 0） | ✅ |
| R8 | P1-② | meta 四字段 S2 产出链（spec §4 N4/N5/N6「S1/S2 产出」） | S2 输出契约增可选 `meta{climax_segment,sound_events,audiovisual_signature,world_anchors}`，orchestrate 合并进 ir.meta；S2 persona 增产出指令（声音 12-slot 规范名清单来自 deep-analysis A3）；meta 形状机检 | ✅ |
| R9 | P1-③ | 道具三态登记进 S2 契约（spec §5 S2） | S2 输出增可选 `props[{id,name,state_by_beat}]`，orchestrate 覆盖合并（缺省仍 {}）；G-prop 覆盖检查由此在活体路径生效 | ✅ |
| R10 | P1-④ | S5 受影响镜路由精确化 + auditorResult 跨镜泄漏 | auditorResult 移入镜循环内（每镜独立）；修复触发=critical/important gate detail 提及本 shot.id 或本 beat.id，或本镜审计 needs_revision；meta 级 gate 不触发镜修复（S5 只修 prompt 层，蓝图冻结）；S5 粒度投影裁决写入 spec §7（修订记录） | ✅ |
| R11 | P1-⑧ | 版本登记 continuity_ledger（spec §5/§7） | 每次 S3 成功→`prompt_v1`（note=上游 hash8）；每次 S5 成功→`prompt_v{n+1}`（note=所修 gate 规则）；beat_span=shot.id | ✅ |
| R12 | P0-3 | 两段式确认续跑（spec §5/§7） | orchestrate 增 `resumeStoryboard` 输入：validateDirectingIr fail-fast→跳过 S1/S2→S3-S5；工具层增 `resume_storyboard` 参数；无锚定 IR 时拒绝（显式错误） | ✅ |
| R13 | P2-7 | 增量重跑=只重跑 null/违规镜（spec §4/§8） | resume 语义内置增量：prompt.text 非空且 audit.verdict='pass' 且无 gate 引用的镜跳过 LLM（S3/S4），编译/落盘恒全量（确定性零成本）；新鲜请求恒全量 | ✅ |
| R14 | P1-⑦ | envelope status 键（spec §5） | h3TopLevel 恒投影 `status`（completed/awaiting_approval） | ✅ |
| R15 | P0-1 | 工程三件套生产接线（spec §4） | prompt-author 注入 deps.emit：baseDir=`<presetRoot>/temp/prompt-master/<project 规范化>`（project 白名单 `[A-Za-z0-9_-]`，防路径逃逸）；emit 失败 fail-open→advisory `engineering_emit_failed`（沿 blueprint_save_failed 先例）；测试 seam `setDirectingEmitDir` | ✅ |
| R16 | P1-⑨ | 工具参数声明面（spec §3 入口签名） | parameters 增 script/project/await_user_approval/resume_storyboard；描述对齐 spec 章节 | ✅ |
| R17 | P1-⑩ | runEnrich 死调用移除 + generation 落库 | 删除 h3-fresh runEnrich 分支（directing 不消费 brief；blueprint_id+h3 本就不走）；h3 完成态接 recordGenerationSafe；显式 outputLang+h3→advisory `output_lang_ignored_directing`（参数被忽略必须可观测纪律） | ✅ |
| R18 | P2-1 | 工具描述/参数描述滞后（D-U4 + 旧 shots 口径） | description 重写为 directing 入口口径；rating 描述删除 safe-only 拒收声明（与实装一致） | ✅ |
| R19 | P2-2 | G-shotcard 时间连续 severity→critical（spec「全 critical 除非注明」） | continuity-check :203 important→critical；测试同步 | ✅ |
| R20 | P2-3 | l2va >1 Picture 未拦（spec l2va=Picture 1 末帧） | 增 l2va picCount>1 critical | ✅ |
| R21 | P2-4 | core_theme 可拍性双语化 | ASCII 词 + CJK 字符/2 折算词数 ≥3（中文三词主谓宾≈6 字）；测试 EN/ZH 双例 | ✅ |
| R22 | P2-5 | persona 内容缺口（spec §5） | S2 增四种生镜形态（deep-analysis A2：关系燃烧/动力对抗/九态视觉谱/精准改造）；S3 增反字幕约束、FACS AU A-C 日常/D 峰值、生镜校验 17 项声明位；S5 症状表扩至可考 8 行（余 14 行源在 leos 原典，注记）；硬纪律迁 `<rules>` 段（统一模板四段合规），prompts.test 断言改对装配产物 | ✅ |
| R23 | P2-6 | G-sound 子谓词（spec N4 顺序固定禁跳号、每项 time/event） | 按 deep-analysis A3 的 12 规范槽名做序匹配（N/A 允许、序号单调、禁重复），≤12 | ✅ |
| R24 | P2-8 | 方言解耦投影（spec §3 registry 注册面） | 新增 `directing/compile.ts` 单一 seam（现委托 compileH3）；完整 registry 包待第二方言时落位——Speculative Generality 防御，裁决记入 spec §3 | ✅ |
| R25 | P2-附加 | script 文件路径形态（spec §3「剧本文本\|文件路径」） | 存在性判定+readFileSync（≤1MB）；文本优先 | ✅ |
| R26 | 文档 | spec/plan 同步 | spec §3（例外/投影注记）、§5（续跑参数/N12/版本登记）、§6（四门落位/core_theme/l2va）、§6.1（speakerIds 注入机制）、§7（S5 粒度修订记录）、§8（增量重跑）；本计划回填完成记录 | ✅ |
| R27 | 验收 | 全量回归 + 真实数据集成 | vitest/tsc/eslint/build + anima 子集；dist 直连集成脚本：双角色剧本→三件套落盘/speaker ID/台账/预算/绑定/续跑/挂起；DSH 重载活体清单移交 | ✅ |

## 2. 验证流程（每项）

1. 失败测试先行（可 RED 者）；2. 最小实现；3. 该项针对性测试绿；4. 阶段里程碑跑全量
（vitest+tsc+eslint+build）；5. dist 直连真实数据集成（终项）；6. 文档回填。

## 3. 完成记录（执行中回填）

### 2026-10-13 批次：R1-R27 全量收口（✅ 27/27）

**验收门（全部实测通过）**：

- `npx vitest run` 全量：165 files / **1462 passed / 1 skipped / 0 failed**（skip = catalog-build.test.ts:392 `describe.skipIf(PM_RUN_REAL!=='1')` 既有 opt-in）；tsc --noEmit **0 错**；eslint 触碰文件 **0 error**；`npm run build` exit 0（dist 同步）。
- `node scripts/h3-dist-integration.mjs`（R27 dist 直连集成，双角色剧本 + 确定性 runner 桩）**8/8**：① 挂起态 status=awaiting_approval + S3 不跑 + 三件套落盘；② 续跑跳 S1/S2（必抛桩未触）；③ speaker ID 注入 `'御姐 (S1) says:'`（R2 官方格式）；④ 台账 `shot_prompt_version @ hash8`（R11）；⑤ 每镜 token_count>0（R7）；⑥ ref2va 引用绑定（R3）；⑦ 三件套落盘（R15）；⑧ 增量重写违规镜 writer=1 + 健康镜原样（R13）。

**分区取证**：

- **R1-R17**：前序批次落位 + 本批修复编排器作用域断裂（tsc 24 错→0：S1/S2 产物提升函数域、resume 走 ledger 拷贝、R8 meta 合并加 !resume 守卫）与 R13 增量路由（prompt!=null 跳编译、preGates 整 IR 重算、门点名词边界匹配）。
- **R18-R25**：逐条 grep/测试取证 ✅——R18 description directing 口径（prompt-author.ts:1028）；R19 时间连续 critical；R20 i2va picCount>1 拦截；R21 core_theme CJK/2 折算；R22 生镜四形态 + persona 纪律面（prompts.ts:96）；R23 G-sound 12-slot 顺序匹配；R24 `directing/compile.ts` seam（Parameters<> 投影，registry 待第二方言）；R25 路径探测 ≤1MB。
- **R26**：spec §11「实施对齐修订记录」（7 条：script 可选化 / resume hash 对账 / 词边界 / 取消语义 / R24 裁决 / G-cameramotion 投影注记 / parseTime 加固）+ 本节回填。
- **R27**：全量门 + dist 集成脚本落库；**DSH 重载活体终验清单移交用户**（本计划 §0.6 尾项，需真实 Agent 会话）。

**对抗审查收口（并行双审查员）**：

- B 路（工程/回归）：0×P0 / 0×P1 / 8×P2 **全部处理**——P2-1 测试库隔离（vitest setupFiles → tests/setup-global.ts，tracked feedback.sqlite 不再被污染）；P2-2/P2-3 变异杀手里程碑补齐（severity critical 断言 + ASCII 冒号）；P2-4 resume 三坑（编译覆盖/hash 对账/includes 误伤）；P2-5 取消穿透（CallerCancelledError rethrow，取消≠fail-open）；P2-6 afterEach 复位；P2-7 `.codegraph/` 入 ignore；P2-8 两项确认注记入 spec §11。
- A 路（directing 语义）：回报未达（子代理静默退出），不影响本批验收门；后续回报如成立新发现，另开条目处置。
- 附带修复：`styles/registry.ts` 缓存按解析目录键控——根除「测试通过与否取决于 worker 文件分组」的顺序脆弱性；同目录「写入后重启才可见」钉死语义不变（spec §13 测试仍绿）。
