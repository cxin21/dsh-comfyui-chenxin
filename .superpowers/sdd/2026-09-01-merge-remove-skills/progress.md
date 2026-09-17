# SDD ledger — plan: merge skill capabilities into prompt-master, then remove skills

spec: 用户决策（四阶段）— 1) catalog build 吸收 2) resolveKnowledgePath 双位置 + 资产迁 assets/knowledge/ 3) 删技能 4) 验证
base HEAD: 3cc4e64
上游源码（ground truth）: skills/anima-prompt-v1/（删除前先完成移植）

## Rulings made during setup

Ruling: 用户决策（强制）——prompt-master 完整合并两个技能能力（含维护面）后彻底删除技能目录 + venv 包。
Ruling: 资产新位置 = `<preset>/assets/knowledge/<skill>/`（用户选定）。
Ruling: catalog build 是唯一未吸收能力（anima-prompt-v1 10 action 中 9 个已吸收；minimax-h3-prompt 只有 author 已吸收）。tokenizer 已由 tokenizer-h3.js + golden 吸收。
Ruling: 四阶段先后执行（S1 build → S2 路径+迁移 → S3 删除 → S4 验证）。S2/S3 之间有强依赖（先断路径旧位置再删目录）。

## Pre-flight constraints

- **golden 不可挂**：catalog/tokenizer 相关 429 测试若锁定 `skills/<skillDir>/knowledge/` 绝对路径——执行者必须先摸清（搜索 resolveKnowledgePath 调用处 + 测试 fixture 是否硬编码），S2 的双位置探测必须让全部测试绿
- catalog build 的 TS 移植：node:sqlite 可写模式（DatabaseSync 不带 readOnly）+ FTS5 构建 + manifest 更新——与既有 readOnly catalog 句柄并行时注意 db() 缓存失效（build 后 G4 自动刷新）
- registry 工具数会再 +1（catalog_build）

## Progress

(待追加)
S1: complete (commits 6f86d8c + fix 276fe14, 533 green). Review clean + I1(EPERM/EBUSY scope)/M1(paths)/M2(win32 case)/M3(seam test) all fixed.
S2: complete (commit e89d459, 539 green). Review clean Spec PASS/Approved - migration 10/10 sha256 verified, dual-path resolve.ts only, golden invariant holds.
S2: IMPORTANT Stage-3 prerequisite (carry): assets/knowledge 7 small metadata files UNTRACKED - must track before deleting skills/.
S2: minor (deferred): relations.ts:68 doc comment dual-path wording; report line-count imprecision; trailing newline

S3: complete (commits 9720db3 prereq + 72ab56d main + 742d82d closeout, 539 green). Review pending. Verified: skills/ = 3 camera; venv anima/minimax purged; assets/knowledge full copies; loader.js/cordis/AGENTS/scripts rerouted.
S3 closeout (Captain): camera-* SKILL.md 10 dead refs rerouted to prompt_author (target=anima|h3); README 9 refs updated (assets path, structure diagram, routing table, temp layout); catalog-build.test.ts:352 real-asset path → assets/knowledge. 539/539 green.

S4: Captain verification — loader.js syntax OK, 3 remaining refs all legitimate (camera-video H3 blurb + 2 prose notes); cordis/AGENTS clean; registry 10 tools incl. catalog_build; git clean (confirm.py pre-existing camera-image change untouched). FULL MERGE + REMOVAL COMPLETE. End-to-end needs NEW SESSION (loader/cordis changes take effect next session).
