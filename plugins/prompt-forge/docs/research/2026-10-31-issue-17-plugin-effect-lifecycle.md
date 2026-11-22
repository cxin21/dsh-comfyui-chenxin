# 插件模块级单例与 cordis effect 生命周期

- 日期：2026-10-31
- 问题：prompt-master 的 apply(ctx) 把模块级单例写在 ctx.effect 外面。插件卸载后这些单例仍指向旧 ctx；同进程再挂载时，新挂载会覆盖，但卸载到重挂之间没有清理合同。
- 范围：plugins/prompt-master 的 apply 接缝（preset root、custom profile source、intent provider、builtin filter）与 cordis 4.0.5 的 fiber effect 语义。settings namespace 的 registerOrReuseNamespace 不在本题。

## 结论

1. cordis 的 ctx.effect(cb) 立刻执行，返回的 disposer 在 fiber 卸载时按注册逆序调用。模块级单例若要跟插件同生共死，写入和复位都必须发生在同一个 effect 回调里：回调开头写入，返回的函数里复位。
2. 今天 apply 在 effect 之前调用 setPresetRoot、setCustomProfileSource、setAuthorIntentProvider、setBuiltinFilter。effect 只注销 ctx.tools.register。卸载后四条接缝仍是旧值。
3. 「intent provider 必须早于工具注册」可以留在同一个 effect 里：先 setAuthorIntentProvider，再 ctx.tools.register。cordis 同步执行 effect，顺序不变。复位放在该 effect 的 disposer，卸载时后于工具注销执行（逆序）。
4. 卸载后的安全缺省已经由各 setter 的 null/undefined 形态定义，不必新造哨兵：preset root 未设置时回落环境变量再回落 layout；custom source 传 null 回到内置空源；builtin filter 传 undefined 清除过滤；intent provider 传 null 时 author 走 defaultIntent(ctx, ...)，用的是调用方传入的 ctx，不是卸载前缓存的那个。
5. 测试替身若 effect(cb){ cb() } 丢掉返回值，就测不到卸载。验收测试必须保住 disposer 并在「卸载」时调用它。

## 依据

### cordis effect 是同步的，卸载逆序跑 disposer

plugins/prompt-master/node_modules/.pnpm/@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/cordis/lib/types/fiber.d.ts：

- Context.effect：注册并立刻执行，返回 disposer；插件 apply 返回后这些回调已经跑完。
- disposer 在所属 fiber 卸载时调用，后注册的先执行。

因此「必须早于工具注册」不是「必须写在 effect 外面」。写在同一个 effect、且写在 ctx.tools.register 之前，工具闭包创建时 provider 已经就位。

### 当前 apply 把四条接缝留在 effect 外

plugins/prompt-master/src/plugin/index.ts（apply）：

- setPresetRoot(config.presetRoot) 在 effect 前。
- setCustomProfileSource(...) 在 effect 前。
- setAuthorIntentProvider(createDefaultIntentProvider(ctx)) 在 effect 前，注释写明必须早于 author 工具注册。
- setBuiltinFilter(config.builtinFilter) 在 effect 前。
- 唯一的 ctx.effect 只 ctx.tools.register(...)，disposer 只负责注销工具。

plugins/prompt-master/src/plugin/register.ts 的 registerAllTools 在注册 author 时就会经 createDefaultAuthorDeps(ctx) 读到当时的 intent provider。provider 若在这次 register 之后才设置，author 会拿到 null 并走另一条意图路径。这是顺序约束，不是「禁止进入 effect」。

### 各接缝的卸载缺省

- preset root：resources/resolve.ts setPresetRoot(root: string | undefined)，未设置则 getPresetRoot() 为 undefined。resolveKnowledgePath 再试 DSH_COMFYUI_PRESET_ROOT，仍无则用 layout 默认。
- custom profile source：resolver/profiles/source.ts setCustomProfileSource(null) 重置为 () => []。
- builtin filter：resolver/profiles/index.ts setBuiltinFilter(filter: BuiltinFilter | undefined)，不传则清除。
- intent provider：tools/prompt-author.ts setAuthorIntentProvider(null) 清空模块槽。槽空时 defaultIntent(ctx, resolveRoute(live), req, live.signal) 使用调用时传入的 ctx，不会静默沿用卸载前那个 ctx。

setDirectingDeps、setAuthorJudgeDeps、setAuthorEnrichProvider、setAuthorFeedbackDbPath、setFeedbackDbPath、setOverlayPath、setCatalogPath、setVectorSearch 也是模块槽，但 apply 不写它们。本题只清理 apply 写过的四条。

### 旧设计只假设单进程挂一次

plugins/prompt-master/docs/2026-08-31-redesign-spec.md §4.2 把 setPresetRoot 写成模块级单例，并写「DSH 单插件单进程，不存在多 preset 并发」。同文件把多 preset 覆盖列为未来项（显式参数替代模块全局），没有卸载 disposer。anima-catalog.ts 也写资源层没有 ctx.logger，manifest 失败走 console.warn。所以卸载清理是 2026-08-31 规格没覆盖的合同，不是对那份规格的实现。

### 现有测试为什么看不见泄漏

plugins/prompt-master/tests/plugin/registry.test.ts 的 stubCtx 把 effect 实现成 cb() 并丢掉返回值。afterAll 里手动 setAuthorIntentProvider(null)，就是因为 apply 会把测试的 fake provider 留在模块槽里。这证明泄漏已被测试作者看见，但没有被插件自己的 disposer 接住。

## 开放问题

- 工具方法若在卸载后仍被调用，且闭包捕获了 apply 时的 ctx（registerAllTools 把 ctx 传进各工具），那是工具注销合同，不是这四条模块槽能单独解决的。本题验收的是：卸载后模块槽不再指向旧 ctx；重挂载后槽指向新 ctx。
- catalog / overlay / vector 的惰性单例（打开过的 sqlite、缓存的 vector seam）不由 apply 设置。卸载时要不要 close()，留给专门的资源所有权票，不塞进这次接缝复位。
