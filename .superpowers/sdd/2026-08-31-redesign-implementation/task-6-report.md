# Task 6 Report: 工具薄视图化（author/compile/audit 走 runStage）

**Status: COMPLETE** · Commit `761120b`（9 files, +150/−217）· build exit 0 · `npx vitest run` 41 files / **301 tests all green** · tests/fidelity **52/52 green**

---

## 1. Read-then-decide 定案（3 点）

### D1 — prompt-author audit_only：**保持完整编译语义（不传 auditOnly）**
原实现 `runDraftStage` 在 audit_only 下也编译并产出 result（author-e2e L52 断言 `raw.result.positive` 含 '1girl'）。据 brief 修订：author 的 audit_only 分支走 runStage **不带 auditOnly**（完整管线，input 来自结构 JSON），result 照常产出。测试验证零 provider 调用 ✅。

### D2 — prompt-compile audit_only：**保持省略 result 语义（runStage auditOnly:true）**
原 `compileH3Envelope`/`compileAnimaEnvelope` 在 auditOnly 时不带 result。视图调 runStage `auditOnly:true`（h3 dialect `auditOnlyOk:true`），再在组装处 `delete env.result`（assembleEnvelope 对 ok=true 会带 `result:{}`，与原"完全缺 result 键"语义不符，故删除）。author/audit 与 compile 语义不同，按 brief 定案分治。

### D3 — prompt-audit：**不强制视图化，仅去重 toRefs**
原 `prompt_audit` 参数为 positive/negative/text + 元信息——审计**已有文本**，与 runStage（编译+审计）是不同功能。保留 `auditContentEnvelope` 原实现，仅将本地 `toRefs` 替换为 h3.ts 导出的共享 `normalizeRefs`。

## 2. Load-bearing notes 处理

1. **h3 键桥接** ✅ `compileH3` 返回 `{text, text_zh}`（buildTextPair 内部解构重命名，非类型 cast）；contract 泛型同步为 `{text, text_zh}`；h3-dialect.test L90 `compiled.textZh → compiled.text_zh`。fidelity 6 个 h3 golden 逐字节投影全绿。
2. **scenario gates** ✅ author 视图层 `applyScenarioGates(stage, {scenarioId, formFields, refsCount})`：sceneToShotsChecked extraGates/advisories 并入、references 非空抑制 `references_unmapped`、**ok 重算**（`gates.every(!critical)`）。refsCount 保持原优先级 shots.references > form_fields.references。author-loop F2（无 refs → critical + advisory）与 full_reference 抑制路径均绿。
3. **budget 到 envelope** ✅ 链路端到端验证：dialect `budget` → runStage `StageResult.budget` → assembleEnvelope `audit.budget`。**发现并修复一处合同偏差**：Task 5 的 dialect budget 返回 `buildH3Budget` 裸投影（textTokens/charCount…），而原 envelope 契约是 `h3BudgetToReport` 形状 `{counter,tokens,max,over}`——已改为 dialect 内 wrap，恢复对外契约。
4. **envelope 收敛** ✅ assembleEnvelope audit 对象 = `{passed, gates, budget?}`。**grep 记录（brief 步骤 3 要求先查）**：全 tests 中无任何 `audit.advisories`/`audit.assumptions` 断言（fidelity golden 的 `assumptions` 在 pythonOutput.result 内、走投影白名单，不受影响；audit-report/anima-compile 断言的是 buildAuditReport/compileAnima 返回值，非 envelope）。runStage.test.ts 原断言不受影响，**新增**一条巩固断言 `Object.keys(s.audit).sort() === ['gates','passed']`。

## 3. 关键实现发现（kernel 修复）

**runStage 忽略 normalize 推断的 stage**：`d.compile/audit/budget` 全部用 `input.stage`（undefined），而 stage 推断（references → ref2va）在 normalizeH3Input 内完成——导致 inferH3Stage 收敛后 ref2va 路径全部退化为 t2va（`refs_on_stage_rejected` critical，author-loop 2 例、compile-h3 2 例失败）。修复：`const stage = normalized.stage ?? input.stage` 并贯通 compile/audit/budget。这是 Task 4/5 的潜伏缺口，Task 6 是第一个真正依赖 normalize 推断的任务。

其他：
- prompt-author/prompt-compile 增加方言模块副作用 import（编排走注册表后必须保证 anima/h3 已装配；否则注册表空 → dialect_not_available）。
- anima variant 未知 → 显式报错保留在视图层（compileAnima 对未知 variant 静默回退 base，runStage 不会报）。
- author `a.stage || undefined` 归一（空串会被 compileH3 `opts.stage ?? 't2va'` 当真值 stage 抛 unknown stage）。

## 4. 断言差异清单（行为等价性记录）

| # | 差异 | 性质 | 依据 |
|---|---|---|---|
| 1 | `ok=false` 时 envelope 不含 `result`（原 author/compile 失败时也带 result；compile 恒 `ok:true`） | Envelope 语义统一到 assembleEnvelope 规范 | 无测试依赖失败态 result；Task 4 定案；本任务 4 处 F1/F2/loop 失败断言全部不需改动即通过 |
| 2 | audit 对象去掉 `assumptions`/`advisories` 键 | Task 4 审查定案 | 无现有断言依赖（见 §2.4 grep 记录） |
| 3 | h3 gate 顺序：原 `[contract, extra, full]` → 现 `[contract, full, extra]`（author）；compile 保持 `[extra, ...]` 前置 | 顺序 delta，成员不变 | 所有测试按 membership 断言 |
| 4 | compile-h3 `inferH3Stage` 直接单测删除 → 改为经工具入口的行为等价断言（ref2va/t2va/full_reference 三路） | 函数收敛进 normalize 单点 | brief 步骤 6 允许迁移断言 |
| 5 | `compileH3Envelope` 函数删除（非保留 re-export）；其 4 处直接调用迁移为 `runTool(execute)`：独立 references 参数改走 `form_fields.references`（normalize 单点消费） | 达成验收 grep 0 matches | brief 验收优先于"保留薄 re-export"选项；无 both-present 用例 |
| 6 | h3 audit budget 形状恢复 `{counter,tokens,max,over}` | 修复 Task 5 偏差，恢复原契约 | §2.3 |

## 5. 验证输出

- `npm run build` → exit 0
- 残留 grep：`Get-ChildItem -Recurse src -Filter *.ts | Select-String -Pattern "function inferH3Stage|function toRefs|function toReferences|renderEnvelope|compileH3Envelope"` → **0 matches**
- `npx vitest run` → **Test Files 41 passed (41), Tests 301 passed (301)**
- `npx vitest run tests/fidelity` → 5 files / **52 passed**（含 h3 六 golden 逐字节 + anima catalog/brief golden）
- prompt_expand/prompt_reverse：零改动。

**Flakiness 备注**：期间两次全量跑各出现 1 例无关失败（`catalog-search`、`anima-brief-golden` ex1）——均为 anima catalog sqlite 在并行 IO 高压下的偶发，单独重跑与末次全量跑均绿；与本任务改动无关（未触碰 catalog 路径），建议后续任务关注 vitest 并行下 catalog 竞争。

## 6. 偏离 brief 之处

1. 修复 runStage stage-推断传播（§3）——brief 未预见，但不修则行为等价性不成立；改动最小（3 行）。
2. `compileH3Envelope` 删除而非保留薄 re-export（brief 给了两个选项，验收 grep 取更严者）。
3. dialect budget wrap `h3BudgetToReport`（brief 只要求"链路完整"，此处按外部契约优先原则恢复原形状）。

## 7. 自审

- 三工具对外 parameters/入口校验/错误文案逐一对照原实现保留（含 `DIALECT_NOT_AVAILABLE`、`未知 variant`、`需要 scenario_id 或 shots 输入`、`Unknown target` 等）。
- 修正闭环（MAX_CORRECTIONS=2、feedback=critical `[rule] detail`、loop_exhausted）留在工具层 ✅；纯函数层零日志 ✅（无 console 引入）。
- 9 文件 diff 复查：无越界改动；types.ts（DialectIO.textZh）为未引用遗留类型，留待 Task 7/8 判断，未动。
