# SDD ledger — plan: resolver×3.1.0 parity batch（docs/2026-08-31-resolver-3.1.0-diff.md §12 清单）

spec: docs/2026-08-31-resolver-3.1.0-diff.md（§12 优先级清单即本批 spec）
base HEAD: 91c1196
上游源码（ground truth）: temp/pm-promptmaster-src/unpacked/electron/config/

## Rulings made during setup

Ruling: 延续就地实施/手工 brief/参数化 review-package 脚本。
Ruling: minimax 测试为结构性断言（非逐字节）——assemble 修复需**新增**上游对照断言（关键块包含性检查），并保真移植后重跑全部既有测试确认行为面不回归。
Ruling: 低危项（R1 撞名/C1 typo/E1 labelUi/文案截短）合并为一个收尾任务；R1 的 legacy 映射策略 = 保持 port-only expand profiles 现役 + 注释声明（不改 id 体系——有消费方）。

## Pre-flight conflict scan

| 共享物 | 任务对 | 结论 |
|---|---|---|
| minimax/assemble.ts | T1 独占大改 | ✅ |
| minimax/templates/* | T1(X8 h3-reference 补细则) 与 T1 重叠——合并进 T1 | ✅ |
| torii/prompts.ts + formats.ts | T2 独占 | ✅ |
| profiles/expand-mirror.ts + reverse/{anima3,router}.ts + {descriptive,prose}.ts + length 相关 | T3 多文件但互不重叠 | ✅ |
| profiles/{expand-rules,comfyui,index}.ts + taxonomy | T4 低危收尾 | ✅ |
| minimax-scenario.ts 工具 | T1 可能需透传 maxTokens 变化——执行者核对（resolveMinimaxScenarioExpand 返回 maxTokens 后工具直接用） | ✅ 返回值驱动，工具无需改 |

## Progress

(待追加)

T1: complete (commit 5f83b80, 483 green incl. 27 parity asserts). Review clean Spec PASS/Quality Approved — verbatim port discipline verified by 3 ground-truth spot-checks. 3 Minor deferred:
T1: minor (deferred): outputLang minimaxForm.output_lang fallback is deliberate superset of upstream (documented)
T1: minor (deferred): classifyMediaPath ext sets not verified vs upstream utils/expandMedia.js (low risk)
T1: minor (deferred): enumerateTaggedMedia regex ext extraction vs path.extname (declared deviation, behavior matches)
T1: Rulings (reviewer): X7 scenario-first matches upstream routing; resolveH3FullReferenceExpand is dead code upstream (port keeps reachable fallback — strictly additive); X4 mechanism-only is exact fidelity (upstream catalog line doesn't match its own regex)
Flake note: one full-suite run hit 14 flaky failures under concurrent IO; isolated rerun green (known shared-runner issue, documented in vitest.config)

T2: complete (commit b804932, 498 green incl. 15 parity). Review clean Spec PASS/Quality Approved — reviewer independently re-ran tests 15/15. Rulings: PROMPTS_B is 12 keys (audit miscounted, all backfilled); stale brief path corrected (profiles/torii); official typos verbatim-confirmed (comin/menation/horisontal/includding/overdoo/descritpion). 3 Minor deferred (hoisted guards TS-required; tautological-ish wiring test; port-only key in parity framing)

T3: complete (commit 9c6c951, 508 green incl. 10 parity). Review clean Spec PASS/Quality Approved — V1/A1 ground-truth verified line-by-line (400/10=40 band, 16/80 clamps, buildCaptionLengthBlock restore). 2 Minor deferred (audit-section comment misroute in test header — brief's fault; A1 tier assertion optional)

T4: complete (commit 3cc4e64, 515 green incl. 7 parity). Review clean Spec PASS/Quality Approved — spot-checks vs upstream file:line; R1/E1 rulings became executable double-sided locks. 2 Minor deferred (as any cast; trailing newline)
ALL TASKS COMPLETE. Final whole-branch review next.

FINAL REVIEW: SHIP — zero must-fix. Reviewer independently re-ran full suite 515/515 (60 files, 87 resolver tests, 59 parity asserts). All §12 priorities closed (高 minimax X1-X8 + 高 torii + 中 M1/M2/A1/V1/D1 + 低 R1/C1/E1/guard). All deferred minors kept (none block). Seams coherent: 4096 floor scoped like upstream mediaExpandMin; X7 fallback no double-route; torii backfill no broken consumers; V1 length-block disjoint from T1 user structure. Behavior note (out of scope): minimax-scenario.ts never passes shortText/mediaPaths so five-block user renders empty 创作需求/no-media lock in dry_run — pre-existing tool surface, future tool-side wiring candidate.
BATCH COMPLETE — resolver×3.1.0 parity absorbed.
