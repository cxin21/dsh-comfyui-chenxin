# H3 Agentic 短剧导演管线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/specs/2026-09-17-h3-agentic-directing-pipeline-design.md`（v2.3）实现 H3 多镜头短剧导演管线：五槽位 LLM + DirectingIR v2 + 12 机器门 + dialect 对白契约增强 + 工程落盘；anima 管线零触碰。

**Architecture:** 新增 `pe-framework/directing/` 独立编排器（与 compositing 平行）；S1/S2 工程级、S3/S4/S5 镜头级五槽位 LLM（全部经 `llm/subagent-tool-runner.ts`，catalog_search 开放）；DirectingIR 为管线唯一交换格式，h3 方言（现行 `dialect/h3.ts`，除 §6.1 对白发射层增强外零改动）负责分 stage 官方格式编译；机器门 `continuity-check.ts` 零 LLM。

**Tech Stack:** TypeScript (tsc→dist)、vitest、node:sqlite（catalog）、DSH subagents（`SubagentHostCtx`）。

**Spec:** `docs/specs/2026-09-17-h3-agentic-directing-pipeline-design.md`（v2.3）——本计划逐任务标注 spec 章节。

## Global Constraints

- 铁律：`src/**` 改动提交前必须 `npm run build`（dist 不入 git，AGENTS.md）。
- 回归门：每任务提交前 `npx vitest run` 全量绿 + `npx tsc --noEmit` 0 错 + `npx eslint src tests` 0 error。
- **anima 零触碰**：`compositing/**`、`dialect/anima*`、anima 测试文件零改动零失败（每任务回归门隐含）。
- 提交规范：单任务单提交，message 标注 spec 章节（如 `spec §6 G-duration`）。
- 安全边界：`safety/boundaries.ts`/`rating.ts` 零触碰（D-U4 不设防仅指新管线不调 gate，模块保留）。
- 剧本输入 = 已有文本/markdown；工程落盘 = `temp/prompt-master/<project>/`。

## 文件结构总览

```
src/pe-framework/directing/
  ir-schema.ts            # DirectingIR 类型 + 校验（Task 1）
  continuity-check.ts     # 12 机器门（Task 3）
  prompts/script-analyst.ts / beat-director.ts / shot-writer.ts /
          continuity-auditor.ts / repairer.ts   # 五 persona + 装配（Task 4）
  engineering/emit.ts     # storyboard.json/prompts/ledger 落盘（Task 5）
  orchestrate.ts          # 五段编排器（Task 6）
  index.ts                # 导出面（Task 6）
src/tools/prompt-author.ts  # h3 分支路由切换（Task 7）
tests/pe-framework/directing/…   # 每任务配套测试
tests/plugin/h3-directing.e2e.test.ts  # 端到端 mock（Task 7）
```

---

### Task 1: DirectingIR schema 与校验（spec §4）

**Files:** Create `src/pe-framework/directing/ir-schema.ts`；Test `tests/pe-framework/directing/ir-schema.test.ts`

**Interfaces（Produces）:**

- `interface DirectingIR`（§4 jsonc 全形状：meta.strict_prompt_validation/climax_segment/audiovisual_signature/sound_events/world_anchors、characters.four_view_refs、beats[].unit、shots[] 全字段、continuity_ledger）
- `interface ScriptIR`（characters/locations/props/信息切点表，S1 输出契约）
- `PURPOSE_TAGS`（六枚举）、`STAGES`（五枚举）、`DURATION_RANGES`（purpose_tag→[min,max]：dialogue[2,4]/mixed[1.5,3]/action[0.4,1.5]/establish[2,4]/insert[0.5,2]/reaction[1,2]）
- `validateDirectingIr(ir): { ok: boolean; missing: string[] }`、`validateScriptIr(ir): 同形`

- [ ] Step 1 失败测试：GOOD fixture（2 Beat × 2 shot，覆盖 5 stage 枚举与六 purpose_tag）+ 8 个违规用例（缺 creative_intent 四字段之一、shot_intent 数 ≠ shots 数、对白 Beat 无 contains_reaction、purpose_tag 非法、stage 非法、duration 出 tag 区间、props.state_by_beat 非三态、handoff 空通道）——`validateDirectingIr(...).ok` 断言逐一翻转
- [ ] Step 2 跑测试确认 RED（模块不存在）
- [ ] Step 3 最小实现：类型 + 手写校验（沿 blueprint/schema.ts 模式；`PURPOSE_TAGS`/`STAGES`/`DURATION_RANGES` 具名常量导出）
- [ ] Step 4 GREEN + `npx tsc --noEmit`
- [ ] Step 5 `npm run build` + commit `feat(directing): DirectingIR schema and validation (spec §4)`

### Task 2: dialect 对白契约增强（spec §6.1 / D-U7）

**Files:** Modify `src/pe-framework/schema/h3-shots.ts`（dialogue 对象增 voiceover/continues_across_cut/truncated 布尔解析）、`src/pe-framework/dialect/h3.ts`（buildDialogue 签名 + speaker 分配）；Test `tests/pe-framework/dialect/dialogue-contract.test.ts`（新增）+ 既有含对白 golden 更新

**Interfaces:**

- `collectSpeakerIds(shots: H3Shot[]): Map<string, string>`（key = who ?? `__anon_{idx}`，首次出现分配 S1…）
- `buildDialogue(shot: H3Shot, speakerId: string): string`（§6.1 ③ 四种发射形态）

- [ ] Step 1 失败测试（dialogue-contract.test.ts）：
  - speaker 分配：两镜同 who → 同 (S1)；不同 who → S1/S2；无 who → 按出现序独立编号
  - 常规发射：`The speaker (S1) says: <d>[English] text</d>`；who 存在 → `Zhou (S1) says: ...`
  - voiceover：`says in an off-screen voiceover: <d>...</d> while their lips remain completely closed.`
  - continues_across_cut：`<d>...</d> <scenetrans> the dialogue continues across the cut.`
  - truncated（非末镜 → ContractError）：`<d>...</d><cutoff>`
  - `<d>` 入输入仍拒（既有契约回归）
- [ ] Step 2 RED → Step 3 实现（schema 三布尔解析 + dialect 分配/发射；`buildShotLines`/`buildThreeFieldBody`/`buildRef2vaText` 线程 speakerIds——每编译作用域一次分配）
- [ ] Step 4 GREEN：新增测试全绿 + **含对白 golden 按官方契约再生**（`tests/fidelity` h3 golden 对白 fixture 更新，提交注明 D-U7；非对白 golden 逐字节不变断言）+ 全量 vitest
- [ ] Step 5 `npm run build` + commit `feat(dialect): official dialogue contract emission (spec §6.1, D-U7)`

### Task 3: 连续性机检 12 门（spec §6）

**Files:** Create `src/pe-framework/directing/continuity-check.ts`；Test `tests/pe-framework/directing/continuity-check.test.ts`

**Interfaces:**

- `checkDirectingIr(ir: DirectingIr, opts?: { strict?: boolean; scriptText?: string }): CompositingGate[]`（复用 compositing/audit.ts 的 Gate 形状：rule/severity/detail/source='directing/check'）

- [ ] Step 1 失败测试：逐门用例——G-schema（validateDirectingIr 转发）、G-purpose（非法 tag=critical）、G-duration（tag 区间 violation=important；单元 <4s/>15s=critical）、G-intents（数量不等/空 new_information/对白 Beat 无 reaction）、G-refbinding（五 stage×角色矩阵：t2va 有 refs=critical、ref2va 含 composition_picture=critical…）、G-dialogue-official（非末镜 truncated、`<d>` 内含冒号/角色名）、G-prop（state_by_beat 缺 Beat/非三态）、G-handoff（非首 Beat 空通道）、G-shotcard（镜号断/时长累加≠段长/sound 缺/tags>2）、G-sound（>12/跳号）、G-signature（color>6/dna>3/core_theme 无动词）、G-unit（climax 位置/相邻无对比——strict=false 时 warning）
- [ ] Step 2 RED → Step 3 实现（`checkDirectingIr` 内部逐门谓词；strict=true 时 warning 级升 critical——N11 双模）
- [ ] Step 4 GREEN（12 门 × 用例全绿）+ tsc
- [ ] Step 5 `npm run build` + commit `feat(directing): 12 continuity machine gates (spec §6)`

### Task 4: 五槽位 persona 与 prompt 装配（spec §5）

**Files:** Create `src/pe-framework/directing/prompts/{script-analyst,beat-director,shot-writer,continuity-auditor,repairer}.ts`；Test `tests/pe-framework/directing/prompts.test.ts`

**Interfaces（Produces）:**

- 每模块：`XXX_PERSONA`（§5 表格纪律 + leos 权限负面清单 + 统一模板四段）、`buildXxxPrompt(输入): string`（task-text 分区）、`parseXxxOutput(raw): 契约类型`（宽松 JSON 提取 + 契约违规抛错）
- S2 输出 = DirectingIR.beats 的纯 beats 切片；S3 输出 = H3Shot 兼容内容字段（what/who/camera/action/micro/carry/ambient/dialogue）——`dialogue` 禁 `<d>`（schema 复用）；S4 输出 = `{ verdict, findings[] }`（八维 dimension 枚举）；S5 输入含 gateViolations+auditorFindings，输出 = 修复镜切片

- [ ] Step 1 失败测试：五 persona 各 3 用例（persona 含工具协议与负面清单；prompt 分区顺序 `<task_persona>→数据→<rules>→<output_contract>`；parse 契约违规抛错）+ S3 persona 断言镜头脉冲七段式/官方对白契约/运镜三维语法在场
- [ ] Step 2 RED → Step 3 实现（persona 正文按 spec §5 表格逐槽位写全，few-shot 各 ≥1 同构示例）
- [ ] Step 4 GREEN + `npm run build` + commit `feat(directing): five slot personas and prompt assembly (spec §5)`

### Task 5: 工程落盘（spec §4 工程输出物）

**Files:** Create `src/pe-framework/directing/engineering/emit.ts`；Test `tests/pe-framework/directing/engineering-emit.test.ts`

**Interfaces:** `emitEngineering(baseDir: string, ir: DirectingIr): { storyboardPath, promptPaths: string[], ledgerPath }`——`storyboard.json`（DirectingIR 序列化）+ `prompts/<shotId>.txt`（shot.prompt.text）+ `continuity-ledger.json`；幂等重跑覆盖

- [ ] Step 1 失败测试（写入临时目录：三件套存在/内容一致/幂等）→ Step 2 RED → Step 3 实现 → Step 4 GREEN + `npm run build` → Step 5 commit `feat(directing): engineering emit (spec §4)`

### Task 6: directing 编排器（spec §3/§7/§8）

**Files:** Create `src/pe-framework/directing/orchestrate.ts` + `index.ts`；Test `tests/pe-framework/directing/orchestrate.test.ts`

**Interfaces:**

- `orchestrateDirecting(input: { script: string; project?: string; awaitUserApproval?: boolean; rating?: string }, deps: DirectingDeps, opts?: { maxCorrectionsPerShot?: number }): Promise<DirectingOutcome>`
- DirectingDeps：`scriptAnalystRunner?/beatDirectorRunner?/shotWriterRunner?/auditorRunner?/repairerRunner?`（taskText→string）、`verifyShot`（Ir schema 自查即机器门内部）、`emit?`（工程落盘缝，缺省内存态）
- DirectingOutcome：`{ ok, status: 'completed'|'awaiting_approval', quality, storyboard: DirectingIr, gates, advisories, corrections, auditor, trace }`

**语义（§7/§8）**：S1/S2 失败 → fail-fast 错误；S3 逐镜（循环 shots，单镜失败 → prompt:null 继续）；S4 机器门恒跑 ∥ auditor（故障降级）；S5 仅受影响镜 ≤2 轮/镜；耗尽 → 保留产物 + loop_exhausted；await_user_approval → S2 后 status=awaiting_approval 提前返回（resume 入参带已批准 IR 续跑 S3-S5）；部分产出恒合法。

- [ ] Step 1 失败测试（全 mock deps）：happy path（3-Beat golden mock：S1→S2→S3×3→S4×3 pass→completed，corrections=0，quality=passed）/ S3 单镜失败 → null 不阻塞 / 修复循环（auditor needs_revision → repairer → 复审 pass，corrections=1，quality=degraded）/ S4 降级（auditorRunner 抛错 → auditor_skipped）/ await_user_approval（S2 后挂起 + resume 续跑）/ S1 失败 fail-fast
- [ ] Step 2 RED → Step 3 实现（编排器：分镜循环 + 机器门/auditor 双轨 + 修复路由 + fail-open 语义沿 anima D7）
- [ ] Step 4 全绿 + `npm run build` + commit `feat(directing): five-slot orchestration (spec §3/§7/§8)`

### Task 7: prompt-author h3 分支路由切换（spec §3 入口）

**Files:** Modify `src/tools/prompt-author.ts`（h3 分支 → directing 编排器；旧 shots 直译路径移除）；Modify `tests/plugin/h3-directing.e2e.test.ts`（新）+ 既有 h3 e2e 测试重写

**Interfaces:** prompt_author 增 `script?: string`、`project?: string`、`await_user_approval?: boolean` 参数；envelope 顶层 `quality`/`auditor`/`status: awaiting_approval`；`minimax_scenario` 不动

- [ ] Step 1 失败测试（e2e mock：target=h3 + script → 五槽位链路跑通、envelope 键断言；旧 shots 路径调用 → 明确报错提示已移除）
- [ ] Step 2 RED → Step 3 接线（deps 装配：scriptAnalyst/beatDirector 用 text runner、shotWriter/auditor/repairer 用 tool runner、verify=validateDirectingIr、emit 注入；旧 shots 直译代码块删除——`minimax_scenario`/`h3-rating-gate` 模块保留不删）
- [ ] Step 4 全绿（含 anima e2e 回归子集）+ `npm run build` + commit `feat(tools): prompt_author h3 routes to directing pipeline (spec §3)`

### Task 8: 收尾门

- [ ] `npx vitest run` 全量（记录数字回填本文件）+ `npx tsc --noEmit` 0 + `npx eslint src tests` 0 error + `npm run build`
- [ ] anima 零触碰核验：`git diff --stat` 确认 `compositing/**`（Task 6 新文件除外）与 `dialect/anima*` 无改动
- [ ] 活体终验清单移交用户：DSH 重载 dist 后真实 prompt_author(h3, script) 端到端（五子代理链/envelope 键/工程三件套落盘）

- Task 3: 完成，commit 6554165。`directing/continuity-check.ts`：12 机器门（G-schema/purpose/duration/intents/refbinding/dialogue-official/prop/handoff/shotcard/sound/signature/unit）；G-duration 双层（tag 区间=important、Beat 总时长 H3 [4,15]=critical——playbook 打包模型）；G-refbinding 五 stage 角色+数量矩阵；N11 strict 双模。DirectingShot 增 what/dialogue 字段。14 用例全绿（RED→GREEN），tsc 0 / eslint 0 / 158 files / 1375 passed。
- Task 1: 完成，commit 04a29f6。`directing/ir-schema.ts`：DirectingIr/ScriptIr 类型 + validateDirectingIr（9 违规用例全绿）+ PURPOSE_TAGS/STAGES/DURATION_RANGES 常量；unit 可选、ScriptIr.appearance_lock 可缺（校验器报）。12/12 绿，tsc 0，build OK。
- Task 2: 完成，commit cb46992。schema/h3-shots.ts dialogue 对象三布尔 + dialect collectSpeakerIds/buildDialogue 四种发射形态 + aesthetics/check.ts 消费点加固；golden 再生级联（t2va-baker 81→89 tokens、tokenizer golden 76→84 raw、fixture 同步；非对白 golden 逐字节不变）。157 files / 1349 passed。
（后续任务完成即回填）
