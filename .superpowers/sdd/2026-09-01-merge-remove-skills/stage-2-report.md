# Stage 2 Report — 知识资产迁移 + resolveKnowledgePath 双路径

**Date:** 2026-09-01（merge-remove-skills 第 2/4 阶段）
**Scope:** anima-prompt-v1 + minimax-h3-prompt knowledge 资产 `skills/<skill>/knowledge/` → `<preset>/assets/knowledge/<skill>/`；`resolveKnowledgePath` 双路径（新位置优先，旧位置回退）
**Working dir:** `plugins/prompt-master`
**Status:** ✅ DONE（suite 全绿、build 通过、已提交）

## 交付件

| 文件 | 角色 |
|---|---|
| `plugins/prompt-master/src/pe-framework/resources/resolve.ts` | 唯一源码改动：dual-path 解析 |
| `plugins/prompt-master/tests/pe-framework/resources/resolve-knowledge-path.test.ts` | 新增：假根优先级测试（6 用例） |
| `plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts` | 更新：期望路径从 `skills/…` 改为 `assets/knowledge/…`（新布局默认） |
| `plugins/prompt-master/tests/plugin/catalog-build.test.ts` | 更新：假 preset fixture 从 `skills/…` 迁到 `assets/knowledge/…`（2 用例） |
| `.gitignore`（preset 根） | 新增 assets/knowledge 三个大文件忽略项（复用 skills/ 既有 pattern） |
| `<preset>/assets/knowledge/anima-prompt-v1/` + `…/minimax-h3-prompt/` | 迁移目标（10 个文件，3 大 7 小）——**不入 git** |

## resolve.ts 双路径逻辑

```ts
const newPath = join(root, 'assets', 'knowledge', opts.skillDir, opts.asset)
if (existsSync(newPath)) return newPath
const oldPath = join(root, 'skills', opts.skillDir, 'knowledge', opts.asset)
if (existsSync(oldPath)) return oldPath
return newPath   // 都不存在 → 新路径（调用方错误处理兜底，assertAnimaCatalog/assertH3Tokenizer 均 try/catch）
```

- 返回类型保持 `string`（已存在的解析结果；都不存在时返回新路径，缺口由调用方兜底）。
- **所有调用方无需改动**：grep 复核 11 处 `resolveKnowledgePath` 调用点（relations.ts:71、catalog-build.ts:12/15/18、tokenizer-h3.ts:19、anima-catalog.ts:34、manifest.ts:15/18/28/29）全部使用 `{skillDir, asset}` 签名；src 内其余 `skills/` 出现均为注释。`references/` 只在注释中出现（budget.ts 预算表为 TS 内联移植，**无运行时文件读取**）→ 未迁移 references/。

## 迁移验证证据（copy，非 move；skills/ 原件保留至 Stage 3）

1. **大小逐字节比对（10/10 OK）**：

| 文件 | src 字节 | dst 字节 |
|---|---|---|
| anima tag-catalog.sqlite | 820,846,592 | 820,846,592 |
| anima tags.sqlite | 213,778,432 | 213,778,432 |
| anima manifest.json | 307 | 307 |
| anima README.md | 5,289 | 5,289 |
| h3 tokenizer.json | 7,032,403 | 7,032,403 |
| h3 tokenizer_config.json | 11,003 | 11,003 |
| h3 chat_template.json | 5,499 | 5,499 |
| h3 manifest.json | 1,184 | 1,184 |
| h3 LICENSE | 17,604 | 17,604 |
| h3 NOTICE | 121 | 121 |

2. **sha256 抽查（5/5 一致，src==dst 前 16 位）**：
   - `tag-catalog.sqlite` C5FD14B8F8C73C30 ✓
   - `tags.sqlite` 4401B7E78340ACB4 ✓
   - `tokenizer.json` A5D85B6DCC535E6B ✓
   - `manifest.json`(anima) 51ECAEFD44B42B4E ✓
   - `chat_template.json` 5C72A170D2A4A1A3 ✓

3. **skills/ 原件未删除**——Stage 3 再删。此时双路径在新旧位置同时命中，过渡期两种布局均可用。

## 测试与构建验证（golden 不变量保持绿）

```
npx vitest run  → 63 files, 539 passed, 1 skipped（opt-in 真实 smoke）；（基线 533 + 新增 6）
npm run build   → tsc 无错误（BUILD_EXIT=0，tests 一并 type-check）
```

- **golden 命中确认**：real-catalog browse/verify 测试（读真实 tag-catalog.sqlite）在新迁移位置下全部通过 → 解析优先选择了 `assets/knowledge/`，行为与 Stage 1 完全一致。
- **预迁移语义验证**：合并前先跑 resolve 单测（13/13 绿）再迁移；迁移后全量绿。新增的 real-checkout 用例（不注入假根）设计为「迁移前解析旧、迁移后解析新，始终落在存在文件上」，双态可跑。

## 更新的既有测试逐项判定

| 测试 | 判定 | 理由 |
|---|---|---|
| `resolve.test.ts` 5 处断言（L13/18/36/49/66/68/76） | **更新** | 断言的是 resolver 默认输出；假根 `C:/fake-preset` 两处都不存在 → 新默认 = `assets/knowledge/…`。属"应跟踪新布局"的测试 |
| `catalog-build.test.ts` L62/112 两处 fixture+断言 | **更新** | 模拟生产 preset 默认布局，fixture 与断言路径同迁到 `assets/knowledge/anima-prompt-v1/`；否则「显式 output == 默认 → 更新 manifest」的在就地语义比较会因新旧路径不一致而失配（manifest=null）|
| `manifest.test.ts` L16/29 | **保留（旧布局 fixture）** | 假根只在旧位置放 fixture → 走回退分支解析 → 恰好是旧-fallback 的隐式回归测试，且 suite 全绿 |
| `browse-verify.test.ts` L90、库层 `catalog-build.test.ts` L307/308/352 | **保留** | 显式 path 直传（不经 resolver）或旧布局 fixture；不受影响，全绿 |

## Commit

```
e89d459 feat(prompt-master): dual-path resolveKnowledgePath (assets/knowledge preferred, skills fallback) + asset migration
（5 files changed, 110 insertions(+), 13 deletions(-)；.gitignore + resolve.ts + resolve-knowledge-path.test.ts + resolve.test.ts + catalog-build.test.ts）
```

## Deviations（相对本阶段任务书）

1. **commit 增加了 3 个文件**（resolve.test.ts / catalog-build.test.ts / .gitignore）：任务书只列了 resolve.ts + 新测试，但这三处是迁移的**必要条件**——不更新 resolve.test.ts / catalog-build.test.ts，全量 suite 红（533 基线断言在旧布局上）；不更新 .gitignore，782MB+204MB+6.7MB 资产会进 git。
2. **assets/ 小元数据文件（manifest.json/README.md/LICENSE/NOTICE/chat_template.json/tokenizer_config.json）未提交**：按"assets 不入 git"执行，仅 gitignore 三个大文件（复用 skills/ pattern）。与 skills/ 位置的小文件（历史上被 track）不一致——skills/ 原件仍在 git 历史中，Stage 3 删除 skills/ 后如需保留元数据副本可再决定是否 track assets/ 小文件（本阶段不扩 scope）。
3. **references/ 未迁移**：核实 `references/` 在 src 中仅注释提及（budget.ts:2 等），budget.ts 的预算表是 TS 内联移植（`STAGE_QUALITY_CAPS` 硬编码），无运行时读取 → 无迁移需求。

## Concerns / 遗留

1. **过渡期行为差异（已知、可接受）**：在"只有旧位置有资产、且目标产物尚未生成"的假根场景下，`output/manifest` 这类消耗品解析会落到新路径（因新路径优先且旧路径不存在该产物）——生产环境迁移后新位置已存在全部资产，不受影响；仅测试构造场景需随布局迁移（已处理）。
2. **tokenizer.json 仅 6.7MB**：manifest 校验的 snapshot_id 语义（h3-qwen3-vl）不变；若大模型供应商刷新快照，只需替换 assets 下文件（与 skills/ 时代一致）。
3. **Stage 3 删除 skills/ 前**，双路径同时存在——磁盘占用翻倍（约 1GB）；删除后自动只剩新路径，无需再改代码。

## 验证命令回放

```powershell
# 迁移
New-Item -ItemType Directory -Force <preset>/assets/knowledge/anima-prompt-v1
New-Item -ItemType Directory -Force <preset>/assets/knowledge/minimax-h3-prompt
Copy-Item <preset>/skills/anima-prompt-v1/knowledge/* <preset>/assets/knowledge/anima-prompt-v1/ -Force -Recurse
Copy-Item <preset>/skills/minimax-h3-prompt/knowledge/* <preset>/assets/knowledge/minimax-h3-prompt/ -Force -Recurse
# 校验
Compare sizes / Get-FileHash（见上表）
# 套件
npx vitest run   → 539 passed + 1 skipped
npm run build    → BUILD_EXIT=0
```