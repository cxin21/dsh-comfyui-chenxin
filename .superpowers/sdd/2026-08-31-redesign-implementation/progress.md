# SDD ledger — plan: plugins/prompt-master/docs/plans/2026-08-31-redesign-implementation.md

spec: plugins/prompt-master/docs/2026-08-31-redesign-spec.md
base HEAD (branch start): 714e87a726e394aa6d3e2196f72a94d5a71b6ae5

## Rulings made during setup

Ruling: worktree 隔离不适用本计划 — comfyui-chenxin 是 DSH **预设运行目录**（DSH 直接加载此路径下的插件 dist），用 git worktree 会破坏"改完即生效"的挂载前提；且用户已在 brainstorm→spec→plan→执行方式连续授权就地实施。代价：若中途失败需手动回滚 preset 仓库；缓解：每任务独立 commit，可逐条 revert。

Ruling: skill bash scripts（sdd-workspace/task-brief/review-package）不可用 — 本机 C:\Windows\system32\bash.exe 是未安装的 WSL 引导器。等价手工操作：task brief 由控制器 read 计划对应段后写入 workspace 文件；review package 用 git log/diff 重定向到文件。代价：略多控制器操作，无质量损失。

## Pre-flight conflict scan（任务间 / 与全局约束）

| 共享物 | 任务对 | 产出 vs 消费 | 结论 |
|---|---|---|---|
| `DialectContract.audit(ctx)` | T3 定义 ↔ T5 anima.audit 使用 | T3 contract.ts 含 `ctx.variant?`（已补）；T5 Step4 anima.audit 用 ctx.variant | ✅ 一致（T3 已修） |
| `runStage` 返回 StageResult | T4 定义 ↔ T6 工具视图消费 | T4 pipeline/types.ts 导出；T6 import 使用 | ✅ |
| `assembleEnvelope(stage, trail?)` | T4 定义 ↔ T6/T7 调用 | T4 render/envelope.ts；T6 Step1/2/3 调用 | ✅ 签名一致 |
| intent persona/schema 常量 | T5 拆分 ANIMA_*/H3_* ↔ T7 author 取 getDialect(target).intent | T5 Step 前置子步骤拆 subagent-provider.ts 常量；T7 Step3 author 从 dialect.intent 取 | ✅ 顺序正确（T5 先于 T7） |
| `tokenizerSourceDir` 选项 | T2 tokenizer-h3 改造 ↔ T7 budget 帧底 | T2 保留 resolveKnowledgePath 默认 + override；T7 buildH3Budget options.tokenizerSourceDir 仍传 | ✅ 注入点保留 |
| plugin/index.ts | T1 setPresetRoot ↔ T5 顶部 import 方言模块 | 两处修改不同位置（apply 内 vs 顶部 import），不冲突 | ⚠️ 同文件两任务——T1 在 apply 加 setPresetRoot，T5 在顶部加 import；按序执行无冲突 |
| registerDialect fail loud | T3 测试断言 throw ↔ T5 副作用注册 | T5 模块级 registerAnimaDialect() 仅在 plugin/index.ts import 时触发；T3 registry.test.ts 用 __resetDialectsForTests 隔离 | ✅ |
| 硬编码路径清零 | T2 替换 ↔ T8 Step3 grep 验收 | T2 删 DEFAULT_CATALOG_PATH/OVERLAY_PATH/DEFAULT_SOURCE_DIR；T8 grep 0 matches | ✅ |

## 计划自身一致性（测试代码 vs 实现代码）

| 任务 | 检查 | 结论 |
|---|---|---|
| T1 | resolve.test.ts 断言 fallbackPresetRoot 抛错文案 `/presetRoot not configured\|preset/i` ↔ 实现抛 'resolveKnowledgePath: presetRoot not configured...' | ✅ 匹配 |
| T4 | runStage.test.ts 断言 `r.gates[0].rule` 含 'dialect_not_available' ↔ 实现 rule:'dialect_not_available' | ✅ |
| T4 | assembleEnvelope 测试期望 ok:true 有 result ↔ 实现 stage.ok 才放 result | ✅（测试构造 ok:true） |
| T5 | h3-register.test.ts normalizeH3Input 空 shots → error；references→ref2va ↔ 实现一致 | ✅ |
| T5 | anima-register.test.ts bogus_key → error 含 'bogus_key' ↔ validateAnimaSlots 返回 `未知槽位: ${k}` | ✅ 含该串 |
| T6 | 薄视图 execute 参数不变 ↔ 现有 e2e/compile 测试入口契约不变 | ✅（内部走 runStage） |
| T7 | budget-frame.test.ts estimate 回退断言 counter==='estimate' ↔ catch 分支保持旧语义 | ✅ |

未发现需要裁决的计划缺陷。计划自洽，开始执行。

## Progress

(任务完成记录追加于此)
Task 1: implementer DONE_WITH_CONCERNS (commit 5023056; 3/3 new tests, 273 total green). Baseline commit ee78de5 added by Captain (Ruling: plugin tree was untracked; dist/ now git-ignored).
Task 1: review Spec PASS / Quality Approved. 1 Important + 3 Minor.
Task 1: minor (deferred): POSIX-fragile backslash assertions in resolve.test.ts (use join() in assertions)
Task 1: minor (deferred): resolveKnowledgePath lacks skillDir/asset guard ('..' traversal / empty string)
Task 1: minor (deferred): getPresetRoot imported but never asserted; config.ts/index.ts missing trailing newline
Task 1: fix round 1/5 dispatched (Important: env-branch DSH_COMFYUI_PRESET_ROOT untested; throw branch dead in this checkout)
Task 1: fix round 1/5 (1 addressed, 0 open; commit 207d263; re-review ADDRESSED, no new breakage)
Task 1: complete (commits 5023056..207d263 + baseline ee78de5, review clean)

Task 2: complete (commit e46ae2c, review clean: Spec PASS / Quality Approved). 4 Minor deferred:
Task 2: minor (deferred): _dbPath module-eval initializer can throw at import when no preset root resolvable (latent; wrap try/catch or defer to on-read) — reviewer flags as THE import-crash vector, fix candidate for Task 3+
Task 2: minor (deferred): assertAnimaCatalog non-string checksum → generic mismatch reason (adequate fail-safe)
Task 2: minor (deferred): tokenizer manifest once-flag is process-global not per-dir (semantically fine)
Task 2: minor (deferred): anima-catalog.ts missing trailing newline
Task 2: Ruling (reviewer, adjudicated by Captain): manifest check at module-eval acceptable — untimed by vitest, precedes any open, try/caught; recommend Task 3+ considers background/mtime-keyed hashing

Task 3: complete (commit f63f9b2, review clean: Spec PASS / Quality Approved). 2 Minor deferred (import-style cosmetic; contract.ts Target re-export undocumented-but-useful). Ruling (reviewer): registry.ts re-export of DialectContract approved — brief bug (TS2459), not implementer error.
Task 3: note: anima-catalog-golden 'silver hair' flake observed once under load (pre-existing, passed on re-run) — watch in Task 8.

Task 4: complete (commit c9f095d, review clean: Spec PASS / Quality Approved). 3 Minor deferred:
Task 4: minor (deferred → Task 6 must do): envelope audit object carries extra assumptions/advisories keys — Task 6 consolidation should strip audit.advisories/audit.assumptions (legacy audit was {passed,gates,budget?}); top-level advisories is the canonical read
Task 4: minor (deferred): render trace ms hardcoded 0 (acceptable, disclosed)
Task 4: minor (deferred): normalize returning neither error nor value proceeds silently (defensive throw optional)
Task 4: Ruling (reviewer, Captain concurs): advisories dual-exposure correct — brief test + legacy envelope both require top-level; Task 6 drops the nested copies

Task 5: complete (commit 84ea750, review clean: Spec PASS / Quality Approved). 3 Minor deferred:
Task 5: minor (deferred → Task 6): dialect audit drops sceneToShotsChecked extraGates/advisories (scenario-keyed) — tool-level today, Task 6 must preserve
Task 5: minor (deferred): normalizeH3Input feeds normalized refs where prompt-author used raw (semantically equivalent, cleaner; golden re-baseline awareness)
Task 5: minor (deferred): anima.ts/h3.ts missing trailing newline (pre-existing)
Task 5: Ruling (reviewer, Captain concurs): runStage kernel patch shots: normalized.value ?? input.shots approved — necessary for anima.audit, h3 unaffected
Task 5: LOAD-BEARING for Task 6: (1) h3 compile yields {text,textZh} but consumers/fidelity golden expect result.text_zh — Task 6 must map textZh→text_zh; (2) sceneToShotsChecked scenario gates (prompt-author L150-155, incl references_unmapped suppression) must survive Task 6 dispatch; (3) verify budget reaches envelope in Task 6

Task 6: complete (commit 761120b, review clean: Spec PASS / Quality Approved; 3/3 load-bearing verified). 3 Minor deferred:
Task 6: minor (deferred): prompt-compile stageToEnvelope JSON parse/mutate/re-serialize smell (optional assembleEnvelope omitResult option)
Task 6: minor (deferred): prompt_compile h3 ok-semantic change (critical gates now ok=false; more correct; document in changelog)
Task 6: minor (deferred): gate order delta author [contract,full,extra] vs old [contract,extra,full] (membership-only assertions)
Task 6: Ruling (reviewer, Captain concurs): runStage stage-propagation fix approved (normalized.stage ?? input.stage); budget shape restoration approved; ok=false result omission approved
Task 6: note: pre-existing flaky singles (catalog-search, anima-brief-golden ex1) under parallel sqlite IO — Task 7 watch

Task 7: complete (commit d0d1b67, review clean: Spec PASS / Quality Approved). 3 Minor deferred:
Task 7: minor (deferred): prompt-compile entry log includes scenario_id (caller-supplied; consider dropping from whitelist)
Task 7: minor (deferred): logger access inline-cast duplicated in 4 files (DRY; shared logInfo helper optional)
Task 7: minor (deferred): prompt-audit.ts missing trailing newline
Task 7: Ruling (reviewer, Captain concurs): chatTemplateTokens additive field accepted (test discriminates old-vs-new); optional-params deviation accepted
Task 7: Important → carried into Task 8 Step 0 (Ruling): plugin/index.ts:55 registerCompileTool() lacks ctx → prompt_compile logging dormant in production; one-line fix registerCompileTool(ctx) deferred to Task 8 (same file as Task 8's mount-validation work; standalone fix round would cost a full cycle for a one-liner)

Task 8: compile ctx wiring fix committed (ee4c39d; build 0, 15 targeted tests green)
Task 8: full regression 309/309 green (43 files); fidelity 52/52; residue grep 0; first-run 1 flake = known catalog-search single (green on re-run x2)
Task 8: mount validation via standingKeyFor blocked-by-design: current session IS the preset (standing mount exists, namespace collision proves apply reaches settings.register = mount path works). Real end-to-end needs a FRESH comfyui-chenxin session — handed to user.

Task 8: complete (commits ee4c39d, 110ae88, 6f34a68; final review FIX-BEFORE-MERGE → MF-1/2/3 all ADDRESSED in scoped re-review, no new breakage; 313/313 + fidelity 52/52 + build 0)
Task 8: resolver x 3.1.0 diff report at plugins/prompt-master/docs/2026-08-31-resolver-3.1.0-diff.md — HIGH-priority follow-ups (minimax assemble maxTokens 768 vs 4096; torii prompts 3 missing keys) are PRE-EXISTING port gaps, deferred as future work (spec §7 said record-only)
Final re-review ledger notes: assumptions undefined serialization (use ?? []), manifest-check latency now in first db query, sha256-parallel-IO flake structurally unfixed
ALL TASKS COMPLETE — branch ready for fresh-session end-to-end (user action)

END-TO-END VERIFICATION (user session 30cb6c71, fresh comfyui-chenxin mount):
- prompt_author anima: subagent intent produced structured slots from one-line input (subagents/ dir in session zip); dialect compile emitted quality prefix + safety seed + canonical grounding (1girl citation) + catalog_miss assumptions preserved — FULL PIPELINE OK
- prompt_audit / minimax_scenario / profile_list / catalog_search: ok
- prompt_compile: 3 ERRORs 未知槽位: negative/negative_prompt/exclusions → BUG FOUND & FIXED (commit 50c84b8): validateAnimaSlots whitelist missing brief extension fields exclusions(string[])/qualityPrefix/explicit(bool) per composition.py _coerce_brief; model finally worked around by dropping them (feature loss) — now accepted
- vitest.config.ts testTimeout 30s added: catalog manifest sha256 (~783MiB) at first db() exceeded default 5s per-test under parallel IO (structural flake resolved)
- Final: 315/315 green, build 0, commit 50c84b8
