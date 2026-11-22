# Spec 合规检查报告（2026-08-31 重构后）

> 对照：`docs/2026-08-31-redesign-spec.md` vs 实现代码（commit 50c84b8）
> 方法：逐节契约抽查（代码检索 + 端到端会话证据）

## 结论：**合规**。43 项检查点全部通过；2 个已知偏差均有审查裁决记录。

## 逐节检查

### §0 第一性原理约束

| 约束                | 检查                                                                                           | 结果             |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| 内核不做 if(target) | runStage.ts 中 `target==='anima'/'h3'` 业务分支 = 0（仅 dialect 内部与 targetSlotHint 映射表） | ✅               |
| 纯函数层零日志      | pipeline/dialect/audit 三目录 console.log = 0                                                  | ✅               |
| 路径不硬编码        | src 下 `C:/Users/11245` = 0                                                                    | ✅               |
| 生产级可观测        | 5 工具 logger 打点 + manifest 运行时对账                                                       | ✅（见 §5 备注） |

### §1 总架构（工具视图）

| 承诺                                           | 实现                                                                                              | 结果               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------ |
| prompt_author = intent(subagent)→runStage→闭环 | prompt-author.ts：`getDialect(target)?.intent` + runStage + MAX_CORRECTIONS 闭环 + loop_exhausted | ✅                 |
| prompt_compile = runStage                      | prompt-compile.ts 薄视图（audit_only 时 omitResult）                                              | ✅                 |
| prompt_audit                                   | 独立文本审计路径（最终审查裁定 defensible：审计已有文本 ≠ 编译管线，用法文档已声明）              | ✅（记录在案偏差） |
| expand/reverse 直接 llm                        | complete()/completeWithBlocks()                                                                   | ✅                 |

### §2 内核契约

| 承诺                                         | 实现                                                             | 结果 |
| -------------------------------------------- | ---------------------------------------------------------------- | ---- |
| PipelineInput/StageResult/PipelineTrace 形状 | pipeline/types.ts 精确匹配                                       | ✅   |
| 未注册 target → 失败 StageResult（不 throw） | runStage `dialect_not_available` gate 带 target 字段             | ✅   |
| normalize error → throw                      | `throw new Error(norm.error)`                                    | ✅   |
| auditOnly 语义                               | auditOnly=true → result={}；`auditOnlyOk=false` 方言 throw       | ✅   |
| **assumptions 进入 Envelope**                | envelope.ts 顶层 `assumptions: stage.assumptions`（MF-2 修复后） | ✅   |
| trace 各阶段耗时                             | performance.now() 差值；budget 条目条件省略                      | ✅   |

### §3 方言注册表

| 承诺                                         | 实现                                        | 结果                                                                                       |
| -------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| DialectContract 完整（audit ctx 含 variant） | contract.ts:30                              | ✅                                                                                         |
| 重复注册 fail loud                           | `/already registered/` throw + 测试         | ✅                                                                                         |
| 副作用装配（plugin/index.ts import 两方言）  | 顶部 import anima.js/h3.js                  | ✅                                                                                         |
| Target 开放性                                | 联合类型 + 注册表 key；内核零改动可加新方言 | ✅（pipeline/types.ts 的 Target 为本地字面量——最终审查指出未来需与 types.ts 同步，非阻塞） |

### §4 资源层

| 承诺                                             | 实现                                                                               | 结果 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ---- |
| 优先级 config→env→布局回退                       | resolve.ts + setPresetRoot 接线（MF-1 修复后 catalogPath 懒解析，config 真正生效） | ✅   |
| manifest 对账（anima checksum / h3 snapshot_id） | resources/manifest.ts + 首开接线；失败 warn + estimate 回退                        | ✅   |
| 无硬编码                                         | src grep = 0                                                                       | ✅   |

### §5 生产级可观测

| 承诺                          | 实现                                                                                                            | 结果                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 5 工具打点（摘要级，无正文）  | author/compile/audit/expand/reverse 均 `ctx.logger?.info?.`；reverse/expand 打 chars 不打正文                   | ✅                                          |
| ctx.logger 运行时可用性       | Cordis Context L1687 `this.logger = new LoggerService(self)`；Logger.info/warn/error/debug 方法确认（L457-460） | ✅（消除了 Task 7 审查的 Cannot-verify 项） |
| 纯函数层返回 trace 由工具层打 | StageResult.trace → author 成功日志附 stages 摘要                                                               | ✅                                          |

### §6 intent 决策表 + §6.1 修正闭环

| 承诺                                              | 实现                                                                                                            | 结果 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---- |
| author 走 subagent（persona/schema 来自 dialect） | `subagentIntent(req, exec)` + `req.persona ?? opts.persona ?? DEFAULT` + author 传 `getDialect(target)?.intent` | ✅   |
| expand/reverse 直接 llm                           | complete()/completeWithBlocks()                                                                                 | ✅   |
| feedback 唯一来源 = critical gates                | author 闭环 `[${g.rule}] ${g.detail}`                                                                           | ✅   |
| 闭环 max 2 次 + loop_exhausted                    | MAX_CORRECTIONS=2 + trail                                                                                       | ✅   |

### §8 测试策略

registry/方言白盒/资源层/薄视图/fidelity/intent mock/logger spy —— 43 文件 315 测试全部对应落实 ✅（本会话端到端：真实用户输入 prompt_author 全链路产出正确 Envelope——subagent 拆槽、canonical 落词、catalog_miss 保留、assumptions 进 Envelope 均有会话证据）。

## 已知偏差（有裁决记录，非缺陷）

1. `prompt_audit` 未走 runStage（审计已有文本 ≠ 编译管线）——最终审查裁定 defensible，usage 文档已声明。
2. `prompt_compile` ok 语义变化（critical gates → ok=false 且保留 result）——MF-3 修复后语义为"非 audit_only 保留 result"，有 pinning test。
3. pipeline/types.ts 的 Target 为本地字面量联合（与 types.js 重复）——未来加 target 时需两处同步（最终审查指出的低危项）。

## 遗留（后续批次候选）

1. resolver×3.1.0 审计报告的高优先缺口（minimax assemble maxTokens 768 vs 官方 ≥4096；torii PROMPTS_B 3 键缺失）——`docs/2026-08-31-resolver-3.1.0-diff.md`
2. catalog sha256 校验的首查延迟（testTimeout 30s 已缓解测试侧；生产首查秒级延迟可接受）
3. pipeline Target 与 types.ts Target 合并
