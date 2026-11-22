# Round 7 计划：全量遗留清零（文档清账 + 四期候选提前 + 健壮性/卫生包）

> 来源：一/二/三期全部 ledger deferred 项 + 三期审计 B/D 项。用户指令：每项一个 task，本会话全部完成。
> 基线：831 passed（HEAD 7323040）。Spec 引用：三期 design + 各期 TASK_TRACKING 遗留登记。

### Task 1: 文档清账包（D1/D2/D3 + usage 参数表）

- D1 `docs/2026-09-09-field-fixes-design.md` F4 节：severity 措辞 important→critical 回写勘误（闭环只认 critical 的理由）
- D2 F4 排查结论入库：新建 `docs/2026-09-09-cjk-leak-investigation.md`（三层排查结论：一期=无 enrich 层；现状=enrich persona 中文旅穿透+critical 兜底；四期方向）——内容依据 TASK_TRACKING 登记与 T3 探针结论重述
- D3 插件 `AGENTS.md` 基线数字 621→831（顺手核对其他过期数字）
- usage 文档：`docs/usage-prompt-engineering.md` prompt_author 参数表补 judge_mode/enrich/outputLang/enrichment 字段（二期终审 M-3）
- 纯文档，验收=内容核对；提交 `docs: Round7 文档清账包 (D1/D2/D3 + usage 参数表)`

### Task 2: F1 grounding 感知去重（P0 语义残余）

- 问题：narrative 去重在 audit 前做覆盖判定，F2 grounding 替换发生在 audit 后 → 替换改变 token 集，短语级残余双 `moon gate` 漏网（三期审计 B1 实证）
- 修复：`anima.ts` compile 流程在 `applyCanonicalSubstitutions` 重跑 audit 之后增加第二轮 narrative 短语去重 pass（复用 dedupTagPhrases，覆盖集=替换后全部非 narrative 段词元）；两轮去重统一封装，幂等
- 测试：一期同款形状 + F2 替换（`beside a moon gate→moon gate`）→ 正文无重复 `moon gate`；散文句不受影响（回归）；幂等
- 提交 `fix(dialect): grounding 感知 narrative 二次去重 (F1 残余)`

### Task 3: 语言层修正包（四期候选①）

- enrich persona（anima/h3）：「source=user 原样保留」改为「语义保留，语言按 outputLang 产出」——中文 user 条目译为英文进 brief（探针 C 缺口关闭）
- `detectLanguage` 假名优先：含假名 → 'ja'（混合日文不再归 zh）；补 ja 分支断言
- 测试：mock provider 断言中文 user 条目在英文 brief 下被翻译（persona 指令级验证）+ detectLanguage 混合假名用例
- 提交 `fix(enrich): persona 中文旅关闭 + detectLanguage 假名优先 (四期候选①)`

### Task 4: critic 复审健壮性包（二期 T3 minors 收口）

- `judgeRevision` firstScore 缺省 → skipped 防御（替换静默 0 分）
- `rebuttalVerdicts.reason` 非空校验（与 finding_id 同严格度）
- `closedFindingIds ∩ unresolved` 冲突 → skipped（invalid_revision_schema）
- revision 轮调用不再传 ruleGates（T3 审查指出的语义冗余；契约明确 revision 不消费 gates）
- `judgeTopLevel`：debate/judgeFeedback 投影与 judge 投影联动（judge 因 rule_critical 不投影时，若 debate/judgeFeedback 同源同为空则不投影——按 T5 复审防御性备注收紧）
- 测试逐项；提交 `fix(eval): critic 复审健壮性收口 (二期 T3 minors)`

### Task 5: 测试与 CLI 卫生包

- loop.ts 同秒覆盖回归测试（预写同名文件→再产→旧文件不覆盖）
- optimize-loop.mjs POSIX 路径分隔符修复（path.join/basename）
- writeReport 随机后缀重试上限（如 5 次）+ 注释
- enrich skipped trace 条目保留补测试（author-f5）
- author-f5 setCatalogPath 隔离改良（beforeEach 重建而非空串恢复）
- 提交 `test(tools,optimize): 卫生包——覆盖回归/跨平台/隔离 (一/二期 deferred)`

### Task 6: 观测与边界小包

- `blueprint_id + enrich=true` → advisory `enrich_ignored_blueprint`（消除静默忽略）
- cjk 闭环行为级 integration 测试：author-loop/e2e 真走一轮 critical 修正（T3 条件锚定→行为锚定）
- judge-assembly catalog 适配器：显式 `target==='anima'` 断言式限制（h3 声明 catalog 时 fail-fast 而非静默查错库）
- 提交 `fix(tools,dialect): 观测边界小包 (blueprint enrich advisory + cjk 行为锚定 + catalog 分流)`

### Task 7: 全量终审 + 登记

- 独立终审（重点：T2 二次去重与 F2 交互、T3 persona 变更对 golden/e2e 的影响、T4/T5/T6 零行为回归）
- TASK_TRACKING Round 7 登记 + 提交

## Self-Review

1. 覆盖：三期审计 B1(T2)/B2(T1-D2)/D1(T1)/D3(T1)/D2(T1)；一二三期全部 deferred minors 逐条归位（已清项不列；仍开放项全部入 T1-T6；纯文档笔误类归 T1）
2. 无占位符；T4 judgeTopLevel 收紧的实现语义（关联条件）授权实施者按测试意图细化并报告说明
3. 顺序：T1 独立；T2/T3/T4/T5/T6 互不依赖可顺序执行；T7 压轴
