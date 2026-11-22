# 角色化节点工作流（2026-11-23）

## 出发点

用户对「14 个工具为什么不出稿」的追问落到一个更根本的问题：提示词生成流水线
**本来就是一条工作流**——流程一样，只是**每个节点的角色不同**。

既有代码里每个角色确实已经各自拥有 persona / schema / parser：

| 角色 | prompt 构造器 | 解析器 |
|---|---|---|
| intent | `buildIntentTaskText`（core） | `parseIntentDraft` |
| enrich | `buildEnrichPrompt` | `parseEnrichOutput` |
| writer | `buildWriterPrompt` | `parseWriterOutput` |
| auditor | `buildAuditorPrompt` | `parseAuditorVerdict` |
| repairer | `buildRepairPrompt` | `parseRepairOutput` |
| script-analyst | `buildScriptAnalystPrompt` | `parseScriptIrOutput` |
| beat-director | `buildBeatDirectorPrompt` | — |
| shot-writer | `buildShotWriterPrompt` | — |
| continuity-auditor | `buildContinuityAuditorPrompt` | — |
| critic | `buildCriticTaskText` | — |

缺的**不是角色**，而是三样东西：

1. **角色的声明式身份**——节点 id / role / 执行器策略 / 重试次数散落在各分支；
2. **执行器抽象**——「调一次 LLM」在 direct 与 teammate 两种形态之间没有共同接口；
3. **可观测的执行纪律**——谁跑了、用哪种执行器、失败怎么办、重试几次，没有单一事实源。

## 设计

```
WorkflowEngine
├─ resolveRunner(spec)   按节点策略解析执行器（direct / subagent / subagent-v2）
├─ runRole(spec, text)   角色节点：taskText → assistant 文本
├─ run(spec, fn)         通用节点体
└─ snapshot()             逐节点 trace
```

**引擎不吞控制流**：修复轮、审计门、预算台账仍归编排器（`orchestrateCompositing` /
`orchestrateDirecting`）——**流程的形状是业务语义**，引擎只管**节点的执行纪律**。

### 节点契约

```ts
interface WorkflowNodeSpec {
  id: string;          // 节点 id（同一工作流内唯一）
  role: string;        // 角色名（persona 语义）
  executor?: 'auto' | 'direct' | 'subagent' | 'subagent-v2';
  maxAttempts?: number;   // 失败重试次数（不含首次）
  labelPrefix?: string;   // 团队执行器用于 teammate 命名
}
```

### 失败分类与重试

| code | 触发 | 重试 |
|---|---|---|
| `transport_unavailable` | ctx.llm.stream 与 ctx.subagents 均不可用 | 否（重试无意义） |
| `llm_failed` | runner 抛错 | 按 `maxAttempts` |
| `cancelled` | signal 已中止 / 取消类错误 | **否**（取消不重试） |

### trace

每个节点留一条：`{ id, role, executor, ok, ms, attempts, error? }`，
经 `observability.workflow` 进入 envelope——**一次调用后能看到每个角色是谁、
用什么执行器跑的、失败了没**。

## 团队形态（teammate 执行器）

host 0.2.2-rc.5 的 `ctx.subagents.startActivation(spec)` 让「每个节点一个 teammate」
成为可能：自己的角色 prompt、自己的 `outputSchema` 契约、自己的 `agentOptions`
模型路由，结果按 `delivery: 'caller'` 回给插件。

```bash
PM_TRANSPORT=team   # 角色节点走 teammate
PM_TRANSPORT=direct # 默认：进程内直连
```

### 新旧 seam 对照（迁移必读）

| | 旧 `start(provider, req)` | 新 `startActivation(spec)` |
|---|---|---|
| parent | 宽松 | **必须是 host 认得的 live Agent 实例**（否则 UNAUTHORIZED） |
| 工具白名单 | `toolFilter: { allow: [...] }` | **spec 里没有**——子代理工具集由它自己的 composition 决定 |
| 结构化产出 | 无 | `outputSchema`（provider 需 `capabilities.outputSchema`）→ `result.structured` |
| 模型/推理覆盖 | 无 | `agentOptions`（provider/model/reasoning-effort/output-token） |

**能力边界**：新 seam 的角色节点**更强**（有契约、有独立模型），但「按调用限制子代理
可用工具」这一项**没了**。因此：

- 需要 catalog 证据时，改为在 prompt 里注入**确定性检索结果**（`verifyTag` / `search`
  直查），而不是让模型去调工具；
- teammate 可能继承父 agent 的工具面（含 `prompt_author`）→ 形成自指回路。
  旧 seam 靠 `toolFilter: {allow: []}` 做架构级隔离，新 seam 没有 → 只能靠
  **不发起**来断环。

### 守卫的判据：调用者身份，而不是「有没有工作流在跑」

朴素的「工作流执行期间 = 禁止再入」会**误伤合法并发**：同一会话里两个互不相关的
顶层 `prompt_author` 调用，第一个还在跑节点时，第二个会被当成嵌套调用拒掉。

正确判据是**调用者身份**（`workflow/guard.ts`）：

| 调用者 | 判定 | 结果 |
|---|---|---|
| teammate（agent ≠ 工作流发起者） | 自指回路 | 拒绝（`nested_workflow_refused`） |
| 同一会话的另一个顶层调用（同一 agent） | 合法并发 | 放行 |
| 另一个会话（另一个 ctx） | 不在同一 scope | 放行 |
| 拿不到调用者身份 | 无法判定 | 放行（不误伤） |

scope 按 ctx 记 `{ ownerAgentId, depth }`（WeakMap，不泄漏）；`prompt_author` 入口
`beginWorkflowScope(ctx, callerAgentId)` / `finally` `endWorkflowScope(ctx)`。

## 落地

- `src/pe-framework/workflow/types.ts` — 节点契约与 trace 类型。
- `src/pe-framework/workflow/engine.ts` — 引擎（执行器解析 / 失败分类 / 重试 / trace）。
- `src/pe-framework/workflow/guard.ts` — 重入守卫（防 teammate 自指回路）。
- `src/pe-framework/workflow/registry.ts` — ctx → engine 弱映射（让模块级单例的
  intent/critic provider 挂到**本次调用**的引擎上）。
- `src/pe-framework/llm/subagent-v2.ts` — 新 seam 适配器（`startActivation` → 文本）。
- `src/pe-framework/llm/transport.ts` — 三个执行器 + `PM_TRANSPORT` 开关 + 节点级 `prefer`。
- `src/tools/prompt-author.ts` — 所有角色调用改走 `roleRunner()`；四处 envelope 的
  `observability.workflow` 注入 trace；入口加嵌套守卫。

## 回归闸门

- `tests/pe-framework/workflow/engine.test.ts` — 执行器解析 / 失败分类 / 重试 / 取消不重试 /
  节点级 prefer 覆盖全局开关 / 守卫与注册表。
- `tests/pe-framework/llm/subagent-v2.test.ts` — 新 seam 适配器（无 live parent 不发请求、
  spec 形状、stopReason、取消、dispose）。
- `npm run verify:host-shape` — 按 host 真实服务形状挂载 **dist**，断言 14 个工具全部注册。
