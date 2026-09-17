# Stage 1 Report — `catalog_build` tool（builder.py 移植）

**Date:** 2026-09-01（merge-remove-skills 第 1/4 阶段)
**Scope:** anima-prompt-v1 `catalog build` 唯一未吸收能力 → prompt-master 纯库 + 工具对
**Working dir:** `plugins/prompt-master`

## 交付件

| 文件 | 角色 |
|---|---|
| `src/pe-framework/anima-knowledge/catalog-build.ts` | 纯库：`buildCatalog` / `sha256File`（流式 1MB）/ `verifyManifest` / `classifyCategory`（新增内联移植） |
| `src/tools/catalog-build.ts` | 工具 `catalog_build`：Envelope `{ok, stats?, errors?}`；默认路径全走 `resolveKnowledgePath`（Stage 2 改 `assets/knowledge/` 零改动） |
| `src/plugin/index.ts` | 注册 `registerCatalogBuildTool`（第 10 个工具） |
| `tests/pe-framework/anima-knowledge/catalog-build.test.ts` | 纯库测试（11 用例，1 opt-in skip） |
| `tests/plugin/catalog-build.test.ts` | 工具测试（5 用例） |
| `tests/plugin/registry.test.ts` | 注册表断言 9→10 工具（**必需偏差**，见下） |

## Porting notes（builder.py → TS）

- **主链忠实移植**：source 存在性 / output≠source / `mkdir -p` / `with_suffix(".sqlite.tmp")` 临时文件 /
  schema（storage.py 逐条，FTS5 `tokenize='unicode61'`）/ `{"tags","aliases"} ⊆ source_tables` 分支检测 /
  归并分组（清洗 canonical → normalizeTag 分组 → 主记录 = 最高 usage → 最短 canonical → tag_id 字符串比较）/
  别名重映射到主 record / canonical 撞归一化丢弃 / `catalog_fts` 行序 `ORDER BY normalized_value, name_id` /
  `VACUUM` / `os.replace` / stats 三计数 / manifest 重写。
- **normalize**：复用 `anima-catalog.normalizeTag`（与 facets.normalize 语义一致：trim/lower/`_`→space/collapse）——未复制。
- **classify_category**：检索确认无既有 TS 移植 → 按 facets.py 内联移植（`_CATEGORY_MARKERS` 14 组逐条、
  特判映射、`(?:^| )marker(?:$| )` 匹配、默认 general）。**修正**：`full_body` 在真实 facets 顺序下由
  `appearance('body')` 先命中（非 composition）——测试期望按 Python 顺序校准。
- **provenance JSON** 键序 `raw_record_id` 先于 `source_id`（对齐 Python `sort_keys=True`）；manifest 键序
  `content_filters → output → source`（c<o<s）。
- **零日志**：库内无任何 console；工具层仅 `action=build records=… names=…` 摘要（error 分支带 code）。

## VACUUM 判定

**可行，无需跳过。** Node 24.14.0 上 `DatabaseSync.exec('VACUUM')` 实测通过（临时库验证 + 真实 204MB build 全程）。
两点移植注意：
1. Python sqlite3 对 INSERT 开隐式事务、`commit()` 后 VACUUM 在事务外；node:sqlite **无隐式事务** →
   TS 侧显式 `BEGIN`/`COMMIT`（还原单事务语义 + 原子性），COMMIT 后再 `exec('VACUUM')`。
2. VACUUM 是优化非正确性——若未来 node:sqlite 变不相容，跳过它不影响 build 结果（已在文档注释记录）。

## 关键偏差：Windows `os.replace` → EPERM → copyFileSync 回退

实测（本机 Windows）：node:sqlite 只读句柄**不带 FILE_SHARE_DELETE**，`renameSync(tmp, output)` 在
目标被缓存 catalog 句柄占用时抛 **EPERM**（`copyFileSync` 与 `openSync('w')` 均成功 → 句柄共享 WRITE 不共享 DELETE）。
由于 G4 常开缓存句柄，真实就地重建必然命中该情形 → 库实现：
`renameSync` 失败 → 回退 `copyFileSync` 原地重写。安全性论证：
- build 全同步（无 await），事件循环内不可能有查询交错 → 进程内读者看不到半成品；
- 替换后 mtime 变化 → G4 在下次 `db()` 时 close+reopen，陈旧句柄不参与新查询；
- 跨进程读者残余风险与"重建一个活的 DB"本质相同（文档化，非新增面）。

（POSIX 无此问题，rename 直接成功；回退只发生在 Windows 目标被占用时。）

## Fixture 策略（CI 确定性优先）

vitest 全局 `testTimeout=30s`，真实 204MB 全量 build ≈ 76s → 不可能进 CI。方案：
- **fixture-first**：tiny `tags.sqlite`（真实 schema 形状：6 tag 含空 canonical/脏下划线/脏重复 + 3 alias）
  → 确定性断言 `{records:4, names:6, ftsRows:6}`、FTS5 MATCH、归并去重（bodysuit_+bodysuit→record 3）、
  别名重映射（waving→5、long hair→4）、撞 canonical 别名丢弃（alias 计数 2）。
- **legacy copy 分支**：full-schema tag-catalog 形状源 → 1+1+1；列不齐 → 故意抛错。
- **错误分支**：source 缺失 / output==source 抛错且无 temp 残留。
- **manifest**：build+manifestPath → 重写且 `verifyManifest` true；篡改 checksum → false。
- **真实资产 smoke（opt-in）**：`PM_RUN_REAL=1 npx vitest run …`（默认 `describe.skipIf` 跳过）；
  单测 `{ timeout: 300_000 }` 覆盖 30s 上限。实测 **76.3s**：records>1M、names>1M、fts parity、
  build 后 `searchCatalog('1girl')` 命中。

## G4 交互测试证据（build → searchCatalog 自动读新文件）

`tests/pe-framework/anima-knowledge/catalog-build.test.ts` `G4 交互` 用例（确定性 fixture）：
1. build v1 → `setCatalogPath(output)` → `searchCatalog('waving')` 命中（gen=1）。
2. 追加 tag 后 rebuild 同 output —— **build 本身不触碰缓存句柄**（断言 build 后 `dbGeneration` 仍为 1）。
3. mtime bump（模拟真实重建的新 inode/NTFS 高精时间戳，去同毫秒 flake）→ 再次 `searchCatalog('nekomimi')`
   命中新行、`dbGeneration=2`（G4 close+reopen 生效）。
真实 smoke 同为证：全量 rebuild 后 `searchCatalog('1girl')` 命中，说明替换后无需手动重开。
现有 G4 测试（`anima-catalog-refresh.test.ts`）与新实现并存全绿——无回归。

## 测试与构建验证

```
npx vitest run  → 62 files, 530 passed, 1 skipped（opt-in 真实 smoke）   （基线 515 + 新增 15）
npm run build   → tsc 无错误（tests 一并 type-check）
```

## Commit

```
git add plugins/prompt-master/src/plugin/index.ts \
        plugins/prompt-master/src/pe-framework/anima-knowledge/catalog-build.ts \
        plugins/prompt-master/src/tools/catalog-build.ts \
        plugins/prompt-master/tests/pe-framework/anima-knowledge/catalog-build.test.ts \
        plugins/prompt-master/tests/plugin/catalog-build.test.ts \
        plugins/prompt-master/tests/plugin/registry.test.ts
git commit -m "feat(prompt-master): catalog_build tool (tags.sqlite rebuild with FTS5 + manifest, port of builder.py)"
```

## Deviations（相对本阶段任务书）

1. **`tests/plugin/registry.test.ts` 一并提交**：注册新工具后登记表断言 9→10 工具；不提交则 HEAD 全量测试红。
2. **`os.replace` → rename+copyFileSync 回退**（Windows 无 FILE_SHARE_DELETE，详见上）。
3. **工具 manifest 默认策略**：仅当 output 与默认 knowledge catalog 一致时更新 manifest；
   自定义 output 不写真实 manifest（防止污染资产清单）。库层面 `manifestPath` 仍为显式参数（忠实 builder.py）。
4. **显式 `BEGIN`/`COMMIT`**：node:sqlite 无 Python 隐式事务，用显式事务还原"单事务 + 事务外 VACUUM"语义。
5. **真实 smoke 运行提示**：`--pool=forks` 下 >60s 同步单测会触发 vitest 3.2.7 内部 birpc
   `Timeout calling "onTaskUpdate"`（DEFAULT_TIMEOUT=60s，断言全过但 run 计 1 error）；
   **默认 threads pool 干净**（实测 11/11）。CI 走 fixture，不受影响。
6. **工具参数面**：按任务书仅 `{source?, output?}`；`manifest` 不进参数 schema（由 in-place 判定隐式联动）。

## Review Fixes（review 轮：1 Important + 3 Minor）

提交 `276fe14`「fix(prompt-master): catalog_build rename fallback scoped to EPERM/EBUSY, path docs, win32 case compare, fallback test」。

- **I1（Important）rename 回退收窄**：`buildCatalog` 的 rename catch 不再对任意错误回退 `copyFileSync` 原地重写。
  现在检查 `(e as NodeJS.ErrnoException).code`，仅 `EPERM`/`EBUSY`（Windows 共享冲突）回退，其余（如 ACL 拒绝的
  EACCES）直接上抛；同步更新文件头与 catch 处注释。
- **M1（Minor）工具描述去路径**：`src/tools/catalog-build.ts` 参数描述不再内嵌 `skills/anima-prompt-v1/knowledge/...`
  具体路径，改为「resolveKnowledgePath default，见根路径注入」——Stage 2 迁至 `assets/knowledge/` 时不失效。
- **M2（Minor）win32 manifest 默认判定大小写不敏感**：就地重建判定在 `process.platform === 'win32'` 时对
  `pathResolve(...)` 结果做 `.toLowerCase()` 比较（NTFS 默认不区分大小写），并加注释。
- **M3（Minor）fallback 路径自动化测试**：仓库既有注释（anima-catalog-refresh.test.ts）已记录 `vi.mock('node:fs')`
  会波及 fixture 构建、过于脆弱，故按 finding 允许的第二方案给 `buildCatalog` 增加可测试缝隙
  `renameFn?`（默认 `node:fs renameSync`，向后兼容）。新增用例：
  - `it.each(['EPERM','EBUSY'])` → 注入抛错后走 copyFileSync 回退，断言输出为可读 sqlite、行数正确（records/names）、
    无 `.tmp` 残留；
  - EACCES → 断言直接上抛（不回退、不落盘 output）。

### 验证

```
npx vitest run   → 62 files, 533 passed, 1 skipped（opt-in 真实 smoke）；（基线 530 + 新增 3）
npm run build    → tsc 无错误（BUILD_EXIT=0）
```