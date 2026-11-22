# transport 抽象设计（2026-11-22）

## 事故

host 升到 DSH 0.2.2-rc.5 后，预设能显示、camera 三件套正常，但 prompt-forge 的
14 个工具一个都没有。根因是**两个 host seam 被移除/改形**，而插件把整条 LLM 编排
押在其中一个上：

| seam | 旧 host | host 0.2.2-rc.5 | 撞上的位置 |
|---|---|---|---|
| `ctx.settings.register(ns, schema)` | 有（任意 namespace） | **删**（只剩 configure/describe/update/replace/mutate/write，namespace 变成 profile entry id） | `apply()` 第一行 → TypeError → fiber rejected |
| `ctx.subagents.start(provider, req)` | 有 | **改名改形** → 只有 `startActivation(spec)`（spec 要 `parent: Agent` 真实实例） | intent provider 工厂级 guard → apply 期硬接线直接 throw |

两个都在**挂载期**炸，所以表现为「预设静默失能」而不是「调用报错」。

## 第一性原理

插件真正需要的不是「spawn 一个子代理」，而是**「把一段 taskText 变成一段 assistant
文本」**。前者是 host 的一种实现手段，后者是需求本身。需求被写成了手段，就必然会
随手段变形而塌陷。

所以修法不是给每个调用点打补丁（那会立刻产生第二份漂移实现），而是：

```
intent core（与 transport 无关）        transport（两种实现）
├─ resolveIntentPersonaSchema            ├─ direct   : ctx.llm.stream 直连
├─ buildIntentTaskText                   └─ subagent : ctx.subagents.start 一次性 spawn
├─ parseIntentDraft
└─ applyBlueprintClarify
```

两条路拿到**同一份 taskText**，行为等价由结构保证，而不是靠两边同步改代码。

## 落地

- `src/pe-framework/intent/core.ts` — intent core（persona/schema/taskText/parse）。
- `src/pe-framework/intent/personas.ts` — persona/schema 常量（core 与两个 provider 共用）。
- `src/pe-framework/intent/direct-provider.ts` — direct transport 的 intent provider。
- `src/pe-framework/intent/subagent-provider.ts` — 瘦身为 transport 适配层。
- `src/pe-framework/llm/transport.ts` — transport 抽象 + 能力探测 + `PM_TRANSPORT` 开关。
- `src/llm/complete.ts` — `completeTaskText()`：system 空、单条 user 消息，与 subagent
  的 `prompt:[{type:'text',text:taskText}]` **逐字同形**（parity 前提）。
- `src/pe-framework/eval/critic.ts` — `buildCriticTaskText()` 与 intent 共用同一份
  persona/schema/契约纪律；`createDirectCriticProvider()` 与 subagent 版同签名。
- `src/pe-framework/pipeline/judge-assembly.ts` — `createProductionCriticProvider()`
  按能力选路。

### 开关

`PM_TRANSPORT=direct|subagent`

- `direct`（默认）：优先 direct，direct 不可用时回退 subagent。
- `subagent`：优先 subagent，等价于旧行为。

### apply 期的纪律

provider 的**构造**不允许抛错。apply 期只「绑定 ctx」，transport 在**调用期**按能力
解析；解析不到就抛可观测的调用期错误，而不是让 fiber rejected、整包工具失能。

## 能力降级（必须可见）

host 的 `ContentBlockMap` 里没有 `tool-result` 块，`ctx.llm.stream` 是一次性
文本/工具声明生成——**插件内无法闭环「模型调工具 → 回填结果 → 继续」**。
因此 direct 路径下：

- `catalog_search` 这类「模型主动调工具」的交互不可用 → 出 advisory
  `catalog_tool_unavailable_direct_transport`；
- compositing 的证据职责交给确定性机器门（`verifyTag` / `search` 直接查 catalog），
  不依赖 LLM 调工具。

## 回归闸门

`npm run verify:host-shape`（`scripts/verify-host-shape.mjs`）：按 host 真实服务形状
挂载 **dist**，断言 14 个工具全部注册。它复刻的正是事故现场——形状不对，工具就少。
