# Task 6 Brief: 工具薄视图化（author/compile/audit 走 runStage，删重复）

## 背景
方案 A 第 6 个任务：把 `prompt_author`/`prompt_compile`/`prompt_audit` 三个工具的编排切换到 `runStage` 内核（Task 4/5 已就绪），删除散落的重复函数（`inferH3Stage`/`toRefs`/`toReferences`/`renderEnvelope`/`compileH3Envelope`）。**对外入口契约不变**（参数、返回的 Envelope 语义），内部全走内核。`prompt_expand`/`prompt_reverse` 不动（意图层轻工具，直接 llm）。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 全局约束
- 测试 `npx vitest run <file>`；全量 `npx vitest run`；构建 `npm run build`；git 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`
- **对外契约不变**：三个工具的 parameters/入口校验/返回 Envelope 语义保持（现有测试 author-e2e/compile-anima/compile-h3/prompt-audit/h3-audit/audit-loop 是行为等价性验收）
- fidelity golden（tests/fidelity/**）必须继续全绿
- 修正闭环（MAX_CORRECTIONS=2）逻辑**留在工具层**（它依赖 intentProvider 的 subagent 交互）；feedback 唯一来源 = critical gates 的 `[rule] detail`
- 纯函数层零日志（本任务不加分——Task 7 加）

## 上游任务的 Load-Bearing Notes（必须全部处理）
1. **h3 result 键名桥接**：dialect compile 产出 `{text, textZh}`，但消费者/fidelity golden 期望 `result.text_zh`。在工具视图或 envelope 组装处**映射 `textZh → text_zh`**（推荐：视图层把 compiled 归一为 `{text, text_zh: textZh}` 再进 runStage 的 result？不行——runStage 直接返回 compiled。方案：Task 6 在 h3 dialect 的 compile 返回处不动，改在**视图层**把 `stage.result.textZh` 改写为 `text_zh`？——最干净方案：**改 h3.ts 的 contract compile 返回 `{text, text_zh: textZh}`**（一行，dialect 内部解构重命名），使 runStage 产出的 result 天然匹配 golden。选这个，并同步 contract 泛型与测试。）
2. **scenarioId gates 保留**：`sceneToShotsChecked(scenarioId, formFields)` 的 extraGates/advisories（含 `references_unmapped` 抑制逻辑）原本在 prompt-author.ts L150-155。runStage/dialect 不携带它。处理：**在 prompt_author/prompt_compile 的视图层**（调用 runStage 前后）执行 `sceneToShotsChecked` 并把 extraGates 合并进 stage.gates、extraAdvisories 合并进 stage.advisories（保持现有抑制逻辑：references 非空时抑制 `references_unmapped` gate）。放在视图层是因为它是场景表单语义，不是方言本质。
3. **budget 到 envelope**：验证 h3 的 budget 经 runStage（d.budget）→ StageResult.budget → assembleEnvelope `audit.budget` 链路完整（Task 4 已实现，端到端验证一次即可）。
4. **envelope 收敛（Task 4 遗留）**：现在 envelope 的 `audit` 对象含 `assumptions`/`advisories` 额外键。Task 4 审查定案：**收敛为 `{passed, gates, budget?}`**（legacy 形状），顶层 `advisories` 是唯一读取点。**修改 render/envelope.ts 的 assembleEnvelope**：从 audit 对象中删除这两个键。同步更新 Task 4 的测试断言（runStage.test.ts 的 assembleEnvelope 用例——若它断言了 audit.advisories）。
   ⚠️ 注意：**先确认现有 golden/测试有没有断言 `audit.advisories`**（read tests/plugin/*.test.ts grep 'audit.advisories'）——若有，以"现有断言为准"还是"Task 4 定案为准"？定案优先（Task 4 审查已裁决），相应更新过时断言。

## Files
- Modify: `src/pe-framework/dialect/h3.ts`（compile 返回键 `textZh → text_zh` + contract 泛型 + 该文件测试同步）
- Modify: `src/pe-framework/render/envelope.ts`（audit 对象收敛 `{passed, gates, budget?}`）
- Modify: `src/pe-framework/pipeline/runStage.test.ts`（若 assembleEnvelope 断言受 4 影响）
- Modify: `src/tools/prompt-author.ts`（删 runDraftStage/inferH3Stage/toRefs/renderEnvelope/StageResult；视图化）
- Modify: `src/tools/prompt-compile.ts`（删 inferH3Stage/toReferences/compileH3Envelope/compileAnimaEnvelope 内部拼装；视图化）
- Modify: `src/tools/prompt-audit.ts`（删 toRefs；视图化 auditOnly）
- Test 适配: `tests/plugin/author-e2e.test.ts`、`tests/plugin/author-shell.test.ts`、`tests/plugin/compile-anima.test.ts`、`tests/plugin/compile-h3.test.ts`、`tests/plugin/prompt-audit.test.ts`、`tests/plugin/h3-audit.test.ts`、`tests/audit-loop/author-loop.test.ts`、`tests/plugin/intent.test.ts`（若有引用）
- Test 新增: `tests/pe-framework/pipeline/runStage.test.ts`（assembleEnvelope 断言更新，若受收敛影响）

## Consumes
- `runStage(input: PipelineInput): StageResult`（pipeline/runStage.js）
- `assembleEnvelope(stage: StageResult, trail?: string[]): string`（render/envelope.js）
- `getDialect`（本任务不需要直接用——author 的 intent 仍走 `_intentProvider`（Task 7 才参数化 persona））
- 现有 `sceneToShotsChecked`（schema/scenes.js）
- 现有 `_intentProvider`/`defaultIntent`（prompt-author.ts 内部）

## 视图化实现规格

### prompt-author.ts（最复杂）
```ts
// imports: runStage, assembleEnvelope; 保留 _intentProvider/defaultIntent/resolveRoute
// 删除: runDraftStage, inferH3Stage, toRefs, renderEnvelope, StageResult 接口（改 import StageResult from pipeline/types.js 如需类型）
// normalizeDraftToInput(target, draft): PipelineInput 输入段 —— anima: {slots: draft.slots, variant}; h3: {shots: draft.shots}
// scenarioGates(scenarioId, formFields, references): {gates, advisories} —— 原 L150-155 逻辑（含 references_unmapped 抑制）

async execute(args, exec) {
  // target 校验 + DIALECT 检查: 原来 isDialectReady(target) 检查保留（现在查注册表）
  // audit_only 分支: input 是结构 JSON → parsed；runStage({target, ...(anima?{slots,variant}:{shots,stage,scenarioId,formFields}), auditOnly:true}) → 组装 scenarioGates → assembleEnvelope
  // 正常分支:
  //   let draft = await provider(req(round:0), exec)
  //   let stage = runStage({...normalizeDraftToInput..., stage: a.stage, scenarioId, formFields})
  //   stage = applyScenarioGates(stage, scenarioId, formFields)   // 合并 extraGates/advisories（references 抑制）
  //   闭环 loop: !ok && hasCritical → feedback = critical gates detail → provider(round+1, feedback) → runStage → applyScenarioGates
  //   loop_exhausted → trail
  //   return assembleEnvelope(stage, trail)
}
```
要点：
- runStage 返回的 `stage.result` 是 compiled（anima `{positive,negative}`；h3 `{text, text_zh}`——按 Load-bearing 1 已在 dialect 层改键）。
- `applyScenarioGates` 在 ok 判定后合并：`stage.ok = gates.every(!critical)` 要**重算**（extraGates 可能引入 critical）。
- audit_only 时 result 为 `{}`——**核对现有 audit_only 测试**：现 author-e2e 有没有断言 audit_only 分支的 result？以现有测试语义为准（原实现 runDraftStage 返回 result 含 positive/negative——audit_only 也编译了。**看 Task 4 的 runStage：auditOnly 时 result={}**。语义变化点！——决策：**保持现有行为**——audit_only 参数下视图层调用 runStage 不带 auditOnly（即完整编译+审计），因为原实现 audit_only 也产出编译结果。`runStage(auditOnly:true)` 只给 prompt_audit 用。）**更新本 brief：author 的 audit_only → runStage 不带 auditOnly 标志**（完整管线，input 来自结构 JSON 而非 intent）。prompt_audit 的 auditOnly 语义 = 调用方只关心 gates——但为保持与原 prompt-audit.ts 行为一致（原实现也输出编译结果），**prompt_audit 视图也不带 auditOnly**，auditOnly 内核标志保留但两个工具暂都不用（内核能力，未来用）。
  
### prompt-compile.ts
```ts
// 删除 inferH3Stage/toReferences/compileH3Envelope/compileAnimaEnvelope（若被测试 import——read tests/plugin/compile-*.test.ts 核实它们 import 的是工具 execute 还是这些函数；若直接 import 函数，把断言迁移到 runStage 等价调用或保留薄 re-export 一版）
// 视图: execute → runStage({target, slots/variant | shots/stage/scenario_id/form_fields}) → applyScenarioGates → assembleEnvelope(stage)
// 注意现 compile 的 audit_only 语义（CompileArgs.audit_only）——原 compileH3Envelope auditOnly 时不带 result。**保留该语义**: compile 视图在 args.audit_only 时把 stage.result 置空后再 assemble（或调 runStage 带 auditOnly:true——这里 compile 与 author 不同，compile 本来就是"只要审计"的场景，用 auditOnly:true 合理）。read 现有 compile 测试定案。
```

### prompt-audit.ts
```ts
// 删 toRefs；视图: runStage({target, slots|shots/stage}) → applyScenarioGates(如有 scenario) → assembleEnvelope
// read 现有 prompt-audit.test.ts 定其入口契约（target/positive/negative? 还是 slots/shots?）——原 prompt-audit 的参数形状可能和 author 不同（"给定提示词 + target → 审计报告"）。**以现有参数为准做视图**：若原工具接 positive/negative 文本，则它不能直接走 runStage（runStage 编译而非审计已有文本）——此时 prompt-audit 保持现有 audit 实现不动，只删 toRefs 重复（改为 import 共享版或本地保留）。**read 后定案：若 prompt-audit 是"审计已有文本"（audit_of_text），它与 runStage（编译+审计）是不同功能，不强制视图化——只清理重复函数。**
```

## 步骤

1. **Read 全部相关文件**（3 工具 + 7 测试 + render/envelope + h3.ts compile）——先定案上面三个"read 后定案"点，写进报告。
2. **h3.ts 键名桥接**（textZh → text_zh）+ 泛型/测试同步。
3. **assembleEnvelope 收敛**（audit 对象 `{passed, gates, budget?}`）+ runStage.test.ts 断言同步。
4. **author 视图化**（含 applyScenarioGates；audit_only 保持现语义）。
5. **compile 视图化**（audit_only 语义 read 后定）。
6. **prompt-audit 按定案处理**（视图化或仅清理重复）。
7. 跑受影响测试 → 适配断言（行为等价性：Envelope 语义不变；断言差异逐条记录进报告）。
8. 验证无重复残留：`Select-String -Path src -Pattern "function inferH3Stage|function toRefs|function toReferences|renderEnvelope|compileH3Envelope" -Recurse` → 0 matches（prompt-author.ts 里的 applyScenarioGates 不算）。
9. `npm run build` + 全量 `npx vitest run` 全绿（fidelity 全绿是硬验收）。
10. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "refactor(prompt-master): tools become thin views over runStage (remove duplicate orchestration)"
```

## 验收
- src 下无 inferH3Stage/toRefs/toReferences/renderEnvelope/compileH3Envelope 重复实现（视图层 applyScenarioGates 等新函数除外）
- author/compile/audit 对外契约不变（现有测试适配后全绿）
- fidelity golden 全绿（h3 text_zh 键桥接正确）
- envelope audit 对象 = `{passed, gates, budget?}`（收敛完成）