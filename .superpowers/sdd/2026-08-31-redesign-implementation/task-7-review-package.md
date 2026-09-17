# Review package — Task 7 (base 761120b..d0d1b67)

## Commits
```d0d1b67 feat(prompt-master): exact H3 chat-frame budget, dialect-driven intent persona, structured logging
```n
## Stat
``` .../prompt-master/src/pe-framework/audit/budget.ts | 12 ++++-
 .../src/pe-framework/intent/subagent-provider.ts   |  5 +-
 plugins/prompt-master/src/tools/prompt-audit.ts    | 13 ++++-
 plugins/prompt-master/src/tools/prompt-author.ts   | 14 +++--
 plugins/prompt-master/src/tools/prompt-compile.ts  | 17 +++++--
 plugins/prompt-master/src/tools/prompt-expand.ts   |  8 ++-
 plugins/prompt-master/src/tools/prompt-reverse.ts  |  8 ++-
 .../tests/pe-framework/audit/budget-frame.test.ts  | 40 +++++++++++++++
 .../pe-framework/intent/subagent-provider.test.ts  | 18 +++++++
 .../prompt-master/tests/plugin/logger-spy.test.ts  | 59 ++++++++++++++++++++++
 10 files changed, 179 insertions(+), 15 deletions(-)
```n
## Full diff (-U10, src+tests)
```diff
diff --git a/plugins/prompt-master/src/pe-framework/audit/budget.ts b/plugins/prompt-master/src/pe-framework/audit/budget.ts
index d1f0460..d7bc2ef 100644
--- a/plugins/prompt-master/src/pe-framework/audit/budget.ts
+++ b/plugins/prompt-master/src/pe-framework/audit/budget.ts
@@ -49,38 +49,45 @@ export function visualTokens(reference: Reference, assumptions: string[]): numbe
 export function estimateTokens(text: string): number {
   return Math.ceil(text.length / 4)
 }
 
 export interface H3BudgetProjection {
   counter: 'official-tokenizer' | 'estimate'
   textTokens: number
   charCount: number
   charLimit: number
   qualityCap: number
+  chatTemplateTokens: number
   effectiveCap: number
   over: boolean
   tokenOver: boolean
   charOver: boolean
 }
 
 /** budget.py build_budget 投影（contracts.md ② 保真字段集；放弃字段不入投影）。T12：精确计数为唯一口径，estimate 仅显式回退 */
 export function buildH3Budget(
   stage: string,
   text: string,
   references: Reference[] = [],
   options?: { textTokensOverride?: number; tokenizerSourceDir?: string },
 ): H3BudgetProjection {
   const qualityCap = STAGE_QUALITY_CAPS[stage] ?? STAGE_QUALITY_CAPS.t2va
   const assumptions: string[] = []
   const visual = references.reduce((sum, ref) => sum + visualTokens(ref, assumptions), 0)
-  // chat 帧底（估算口径：无引用时 5 token 与官方 golden 一致；有引用按官方帧语义不做精确值）
-  const chatTemplateTokens = references.length === 0 ? 5 : Math.ceil(5 + references.length * 2)
+  // chat 帧底（T14 精确口径：官方 user 上下文帧全量 BPE，text="" + vision pads 展开；
+  // tokenizer 不可载 → 显式回退旧估算 5+2N，与 textTokens 的 estimate 回退相互独立）
+  let chatTemplateTokens: number
+  try {
+    chatTemplateTokens = countTokensH3('', options?.tokenizerSourceDir, references.length).tokens
+  } catch {
+    chatTemplateTokens = references.length === 0 ? 5 : Math.ceil(5 + references.length * 2)
+  }
   const available = H3_CONTEXT_LIMIT - visual - chatTemplateTokens - DEFAULT_RUNTIME_SAFETY_MARGIN
   if (available < 0) throw new Error('multimodal inputs exceed the physical H3 context limit')
   const effectiveCap = Math.min(qualityCap, available)
   const charCount = text.length
   const charOver = charCount > MAX_PROMPT_CHARS
   let counter: H3BudgetProjection['counter'] = 'official-tokenizer'
   let textTokens: number
   if (options?.textTokensOverride !== undefined) {
     textTokens = options.textTokensOverride
   } else {
@@ -93,20 +100,21 @@ export function buildH3Budget(
       textTokens = estimateTokens(text)
     }
   }
   const tokenOver = textTokens > effectiveCap
   return {
     counter,
     textTokens,
     charCount,
     charLimit: MAX_PROMPT_CHARS,
     qualityCap,
+    chatTemplateTokens,
     effectiveCap,
     over: tokenOver || charOver,
     tokenOver,
     charOver,
   }
 }
 
 /** 对齐 AuditReport.budget（T1 类型）——counter 随精确/回退口径 */
 export function h3BudgetToReport(budget: H3BudgetProjection): Budget {
   return {
diff --git a/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts b/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
index ea96b5c..4bb6e6b 100644
--- a/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
+++ b/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
@@ -40,30 +40,31 @@ export interface SubagentProviderOptions {
 }
 
 /**
  * 创建子代理 Intent Provider：ownerCtx 在此一次性绑定，返回可装入 author.ts seam 的 AuthorIntentFn。
  * ownerCtx 应包含 ctx.subagents 服务（plugin inject ['subagents']）。
  */
 export function createSubagentIntentProvider(
   ownerCtx: any,
   opts: SubagentProviderOptions = {},
 ): AuthorIntentFn {
-  const persona = opts.persona ?? DEFAULT_PERSONA
-  const schema = opts.schema ?? DEFAULT_SCHEMA
   const timeoutMs = opts.timeoutMs ?? 60_000
   const provider = opts.provider ?? 'spawn'
 
   if (!ownerCtx?.subagents?.start) {
     throw new Error('SubagentIntentProvider 不可用：ctx.subagents 未注册（DSH host 未加载 subagent 服务或 plugin 未注入 "subagents"）。提示：检查 plugin inject 是否含 "subagents"，或稍后重试。')
   }
 
   return async function subagentIntent(req: AuthorIntentRequest, exec?: any): Promise<AuthorDraft> {
+    // persona/schema 解析（Task 7 方言化）：req（author 按 dialect.intent 注入）> opts（插件配置）> 全局 DEFAULT 兜底
+    const persona = (req as { persona?: string }).persona ?? opts.persona ?? DEFAULT_PERSONA
+    const schema = (req as { schema?: string }).schema ?? opts.schema ?? DEFAULT_SCHEMA
     // parent 必须是当前调用 Agent：工具执行上下文（exec.agent）优先，
     // 回退到 apply 绑定的 ownerCtx.agent（仅在插件确实在 agent scope 下 apply 时可用）。
     const parent = exec?.agent ?? ownerCtx?.agent
     if (!parent) {
       throw new Error('SubagentIntentProvider 需要调用 Agent 上下文（exec.agent / ownerCtx.agent 均不可用）：请从 Agent 会话内调用 prompt_author')
     }
     const label = `pm-author-${req.target}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
     const taskText = [
       persona,
       '',
diff --git a/plugins/prompt-master/src/tools/prompt-audit.ts b/plugins/prompt-master/src/tools/prompt-audit.ts
index e73793b..02ddb06 100644
--- a/plugins/prompt-master/src/tools/prompt-audit.ts
+++ b/plugins/prompt-master/src/tools/prompt-audit.ts
@@ -53,21 +53,23 @@ export function auditContentEnvelope(content: AuditContent): string {
     ok = gates.every((g) => g.severity !== 'critical')
     void shots
   }
   return serializeReport({
     ok,
     audit: { passed: ok, gates, ...(budget ? { budget } : {}) },
     advisories: [],
   } as never)
 }
 
-export function registerAuditTool(_ctx: Context, _config: Config) {
+export function registerAuditTool(ctx: Context, _config: Config) {
+  type LogCtx = { logger?: { info?: (msg: string) => void } }
+  const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
   return defineTool({
     name: 'prompt_audit',
     description:
       '纯审计闸门（无 LLM）：按 target 对已有内容直接跑审计 + budget（anima: positive/negative（可附 slots）；h3: text + stage/duration/shotCount/references）。',
     parameters: {
       target: { type: 'string', default: 'h3', description: 'anima | h3' },
       positive: { type: 'string', default: '', description: 'anima positive' },
       negative: { type: 'string', default: '', description: 'anima negative' },
       variant: { type: 'string', default: 'base', description: 'anima variant' },
       slots: { type: 'object', description: 'anima 槽位（catalog_miss/段数审计）', default: {}, additionalProperties: true },
@@ -77,25 +79,32 @@ export function registerAuditTool(_ctx: Context, _config: Config) {
       shotCount: { type: 'number', default: 1, description: 'h3 镜头数' },
       references: { type: 'array', description: 'h3 图片引用', default: [] },
     },
     output: {
       schema: { type: 'string', description: 'Envelope JSON 字符串 {ok, audit, advisories}' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
     async execute(args: Record<string, unknown>) {
       const target = String(args.target ?? 'h3') as 'anima' | 'h3'
       if (target !== 'anima' && target !== 'h3') throw new Error(`未知 target: ${target}`)
-      return auditContentEnvelope({
+      logInfo(`[prompt-master] prompt_audit target=${target}${typeof args.stage === 'string' && target === 'h3' ? ` stage=${args.stage}` : ''}`)
+      const out = auditContentEnvelope({
         target,
         positive: typeof args.positive === 'string' ? args.positive : undefined,
         negative: typeof args.negative === 'string' ? args.negative : undefined,
         variant: typeof args.variant === 'string' ? args.variant : undefined,
         slots: args.slots as AnimaSlots | undefined,
         text: typeof args.text === 'string' ? args.text : undefined,
         stage: typeof args.stage === 'string' ? args.stage : undefined,
         duration: typeof args.duration === 'number' ? args.duration : undefined,
         shotCount: typeof args.shotCount === 'number' ? args.shotCount : undefined,
         references: Array.isArray(args.references) ? args.references : undefined,
       })
+      try {
+        const env = JSON.parse(out) as { ok?: boolean; audit?: { gates?: Array<{ severity: string }> } }
+        const gates = env.audit?.gates ?? []
+        logInfo(`[prompt-master] prompt_audit → ok=${env.ok === true} gates=${gates.length} critical=${gates.filter((g) => g.severity === 'critical').length}`)
+      } catch { /* 日志失败不影响工具结果 */ }
+      return out
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/prompt-author.ts b/plugins/prompt-master/src/tools/prompt-author.ts
index e6fca5f..f16d107 100644
--- a/plugins/prompt-master/src/tools/prompt-author.ts
+++ b/plugins/prompt-master/src/tools/prompt-author.ts
@@ -1,18 +1,18 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { TARGETS, type Target } from '../pe-framework/index.js'
 import { serializeReport } from '../pe-framework/audit/index.js'
 import type { AnimaSlots } from '../pe-framework/dialect/anima.js'
 // 方言模块副作用注册（Task 6：DIALECT_READY 静态表 → 注册表查询）
 import '../pe-framework/dialect/anima.js'
 import '../pe-framework/dialect/h3.js'
-import { isDialectReady as registryIsDialectReady } from '../pe-framework/dialect/registry.js'
+import { isDialectReady as registryIsDialectReady, getDialect } from '../pe-framework/dialect/registry.js'
 import { runStage } from '../pe-framework/pipeline/runStage.js'
 import { assembleEnvelope } from '../pe-framework/render/envelope.js'
 import type { StageResult } from '../pe-framework/pipeline/types.js'
 import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
 
@@ -40,20 +40,23 @@ export interface AuthorDraft {
 }
 
 export interface AuthorIntentRequest {
   target: string
   input: string
   variant?: string
   scenarioId?: string
   formFields?: Record<string, unknown>
   round: number
   feedback?: string
+  /** Task 7 方言化：author 按 getDialect(target).intent 注入（req > opts > DEFAULT 兜底在 provider 内） */
+  persona?: string
+  schema?: string
 }
 
 export type AuthorIntentFn = (req: AuthorIntentRequest, exec?: ExecLike) => Promise<AuthorDraft>
 
 let _intentProvider: AuthorIntentFn | null = null
 
 export function setAuthorIntentProvider(fn: AuthorIntentFn | null): void {
   _intentProvider = fn
 }
 
@@ -203,27 +206,32 @@ export function registerAuthorTool(ctx: Context, config: Config) {
           const parsed = JSON.parse(input) as Record<string, unknown>
           draft = target === 'anima' ? { slots: parsed as unknown as AnimaSlots } : { shots: parsed as unknown as H3ShotsInput }
         } catch {
           throw new Error('audit_only 需要结构化 JSON 输入（anima: slots；h3: shots{...}）')
         }
         const stage = runDraftThroughStage(target, draft, runOpts)
         return assembleEnvelope(stage, [])
       }
 
       const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
-      let draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: 0 }, exec)
+      // Task 7：intent persona/schema 方言化——从 dialect 注册表取（ANIMA_*/H3_* 常量），未注册则 undefined → provider 内 DEFAULT 兜底
+      const intentCfg = getDialect(target)?.intent
+      const intentBase = { target, input, variant: a.variant, scenarioId, formFields: a.form_fields, persona: intentCfg?.persona, schema: intentCfg?.schema }
+      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author target=${target}${a.variant ? ` variant=${a.variant}` : ''}${a.stage ? ` stage=${a.stage}` : ''}`)
+      let draft = await provider({ ...intentBase, round: 0 }, exec)
       let stage = runDraftThroughStage(target, draft, runOpts)
       const trailAdvisories: string[] = []
       let corrections = 0
       while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
         corrections++
         const feedback = stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`).join('\n')
-        draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: corrections, feedback }, exec)
+        draft = await provider({ ...intentBase, round: corrections, feedback }, exec)
         stage = runDraftThroughStage(target, draft, runOpts)
       }
       if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
         trailAdvisories.push('loop_exhausted:true')
       }
+      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
       return assembleEnvelope(stage, trailAdvisories)
     },
   })
 }
diff --git a/plugins/prompt-master/src/tools/prompt-compile.ts b/plugins/prompt-master/src/tools/prompt-compile.ts
index 23754bf..f6d542d 100644
--- a/plugins/prompt-master/src/tools/prompt-compile.ts
+++ b/plugins/prompt-master/src/tools/prompt-compile.ts
@@ -1,11 +1,12 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
+import type { Context } from '@deepseek-ai/cordis'
 // 方言模块副作用注册（Task 6：编排走 runStage 注册表，需保证 anima/h3 已装配）
 import '../pe-framework/dialect/anima.js'
 import '../pe-framework/dialect/h3.js'
 import { runStage } from '../pe-framework/pipeline/runStage.js'
 import { assembleEnvelope } from '../pe-framework/render/envelope.js'
 import type { StageResult } from '../pe-framework/pipeline/types.js'
 import { serializeReport } from '../pe-framework/audit/report.js'
 import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 
@@ -22,31 +23,34 @@ export interface CompileArgs {
 
 /** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文） */
 function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean }): string {
   const env = JSON.parse(assembleEnvelope(stage)) as Record<string, unknown>
   if (opts?.omitResult) delete env.result
   return serializeReport(env as never)
 }
 
 const VARIANT_SET = ['base', 'aesthetic', 'turbo']
 
-/** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置） */
-export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean): string {
+/** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置）。onStage：成功前打点钩子（日志摘要，不打正文） */
+export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean, onStage?: (stage: StageResult) => void): string {
   if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
   if (variant !== undefined && !VARIANT_SET.includes(variant)) {
     throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
   }
   const stage = runStage({ target: 'anima', slots, variant, auditOnly: auditOnly === true })
+  onStage?.(stage)
   return stageToEnvelope(stage, { omitResult: auditOnly === true })
 }
 
-export function registerCompileTool() {
+export function registerCompileTool(ctx?: Context) {
+  type LogCtx = { logger?: { info?: (msg: string) => void } }
+  const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
   return defineTool({
     name: 'prompt_compile',
     description:
       '确定性编译+审计：target=h3（场景/shots → official dialect 文本+审计）或 target=anima（slots → positive/negative+审计；无 budget）。h3 budget counter=estimate（T12 前）。',
     parameters: {
       target: { type: 'string', default: 'h3', description: '目标方言：h3 / anima' },
       slots: { type: 'object', description: 'anima 槽位 brief（AnimaSlots 形状）', default: {}, additionalProperties: true },
       variant: { type: 'string', default: 'base', description: 'anima variant：base/aesthetic/turbo' },
       shots: { type: 'object', description: '直接传入 H3 shots（{duration_seconds, shots[]}）', default: {}, additionalProperties: true },
       scenario_id: { type: 'string', default: '', description: 'PM 场景 id（如 full_reference；映射生成 shots）' },
@@ -54,25 +58,29 @@ export function registerCompileTool() {
       output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en/ja' },
       audit_only: { type: 'boolean', default: false, description: '只返回审计结果（不返回提示词正文）' },
     },
     output: {
       schema: { type: 'string', description: 'Envelope JSON 字符串 {ok, result?, audit, advisories}' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
     async execute(args: { target?: string; shots?: Record<string, unknown>; scenario_id?: string; form_fields?: Record<string, unknown>; output_lang?: string; audit_only?: boolean; slots?: Record<string, unknown>; variant?: string }, _exec: ToolRunContext) {
       const a = args as unknown as CompileArgs
       const target = String(a.target || 'h3')
+      logInfo(`[prompt-master] prompt_compile target=${target}${a.scenario_id ? ` scenario=${String(a.scenario_id).trim()}` : ''}`)
       if (target === 'anima') {
         if (a.scenario_id || a.shots || a.form_fields) {
           throw new Error('参数错误：scenario_id/form_fields/shots 属于 h3 分支，anima 请使用 slots + variant')
         }
-        return compileAnimaEnvelope(a.slots, a.variant, a.audit_only === true)
+        const out = compileAnimaEnvelope(a.slots, a.variant, a.audit_only === true, (stage) => {
+          logInfo(`[prompt-master] prompt_compile → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
+        })
+        return out
       }
       if (target !== 'h3') {
         throw new Error(`DIALECT_NOT_AVAILABLE: ${target} 方言未归化（本期支持 h3 / anima）`)
       }
       if (a.slots || a.variant) {
         throw new Error('参数错误：slots/variant 属于 anima 分支，h3 请使用 scenario_id/form_fields 或 shots')
       }
       let shots: H3ShotsInput | null = null
       let scenarioId: string | undefined
       const extraGates: StageResult['gates'] = []
@@ -94,14 +102,15 @@ export function registerCompileTool() {
         target: 'h3',
         shots,
         scenarioId,
         formFields: a.form_fields,
         auditOnly: a.audit_only === true,
       })
       if (extraGates.length || extraAdvisories.length) {
         const gates = [...extraGates, ...stage.gates]
         stage = { ...stage, gates, advisories: [...extraAdvisories, ...stage.advisories], ok: !gates.some((g) => g.severity === 'critical') }
       }
+      logInfo(`[prompt-master] prompt_compile → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
       return stageToEnvelope(stage, { omitResult: a.audit_only === true })
     },
   })
 }
diff --git a/plugins/prompt-master/src/tools/prompt-expand.ts b/plugins/prompt-master/src/tools/prompt-expand.ts
index fda2f3f..255c82c 100644
--- a/plugins/prompt-master/src/tools/prompt-expand.ts
+++ b/plugins/prompt-master/src/tools/prompt-expand.ts
@@ -25,39 +25,45 @@ export function registerExpandTool(ctx: Context, config: Config) {
       output_lang: { type: 'string', default: 'zh', description: '输出语言 zh/en' },
       length: { type: 'string', default: 'medium', description: '篇幅 short/medium/long' },
       extra_prompt: { type: 'string', default: '', description: '附加要求' },
       dry_run: { type: 'boolean', default: false, description: '只返回组装好的 system/user/maxTokens，不调用模型' },
     },
     output: {
       schema: { type: 'string', description: '扩写正文；dry_run 时返回含 debug 的 JSON 字符串' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
     async execute(args: ExpandArgs, exec: ToolRunContext) {
+      type LogCtx = { logger?: { info?: (msg: string) => void } }
+      const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
       const text = String(args.text || '').trim()
       if (!text) throw new Error('text is required')
       const profile = findProfileById(String(args.profile || 'pe_expand_natural').trim())
       if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_expand_natural')}`)
+      logInfo(`[prompt-master] prompt_expand profile=${profile.id} length=${String(args.length || 'medium')}${args.dry_run ? ' dry_run=true' : ''}`)
       const expanded = resolveExpand(profile, {
         outputLang: String(args.output_lang || 'zh') as 'zh' | 'en' | 'auto',
         expandLen: String(args.length || 'medium'),
         userExtraPrompt: String(args.extra_prompt || ''),
         shortText: text,
       })
       if (args.dry_run) {
-        return JSON.stringify({
+        const debug = JSON.stringify({
           debug: { system: expanded.system, user: expanded.user, maxTokens: expanded.maxTokens },
           profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
         })
+        logInfo(`[prompt-master] prompt_expand → ok=true dry_run=true chars=${debug.length}`)
+        return debug
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
       const { text: result } = await complete(ctx, {
         provider, model,
         system: expanded.system,
         user: expanded.user,
         maxTokens: expanded.maxTokens,
         temperature: config.temperature,
         signal: exec.signal,
       })
+      logInfo(`[prompt-master] prompt_expand → ok=true chars=${result.length}`)
       return result || ''
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/prompt-reverse.ts b/plugins/prompt-master/src/tools/prompt-reverse.ts
index 181ff57..7686416 100644
--- a/plugins/prompt-master/src/tools/prompt-reverse.ts
+++ b/plugins/prompt-master/src/tools/prompt-reverse.ts
@@ -51,50 +51,55 @@ export function registerReverseTool(ctx: Context, config: Config) {
       quality_prompt_enabled: { type: 'boolean', default: false, description: '启用质量词前缀' },
       quality_prompt_prefix: { type: 'string', default: '', description: '自定义质量词前缀' },
       media_target: { type: 'string', default: 'image', description: 'image（默认，兼容现有）/ anima / h3——anima=产出可槽位化的丰富描述，h3=产出分镜素材' },
       dry_run: { type: 'boolean', default: false, description: '只返回组装好的 system/text/maxTokens，不调用模型' },
     },
     output: {
       schema: { type: 'string', description: '反推提示词正文；dry_run 时返回含 debug 的 JSON 字符串' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
     async execute(args: ReverseArgs, exec: ToolRunContext) {
+      type LogCtx = { logger?: { info?: (msg: string) => void } }
+      const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)
       const desc = String(args.image_description || '').trim()
       const images = await collectRecentImages(exec)
       if (!desc && images.length === 0) throw new Error('image_description is required, or attach an image to the session')
       const profile = findProfileById(String(args.profile || 'pe_reverse_descriptive').trim())
       if (!profile) throw new Error(`Profile not found: ${String(args.profile || 'pe_reverse_descriptive')}`)
+      logInfo(`[prompt-master] prompt_reverse profile=${profile.id} media_target=${String(args.media_target || 'image')} images=${images.length}${args.dry_run ? ' dry_run=true' : ''}`)
       const reverseResult = resolveReverse(profile, {
         caption_lang: String(args.output_lang || 'zh') as 'zh' | 'en' | 'auto',
         len: String(args.length || 'medium'),
         media_target: String(args.media_target || 'image') as 'image' | 'video',
         extra_prompt: String(args.extra_prompt || ''),
         anima3_enhance: args.anima3_enhance === true,
       })
       const user = [reverseResult.userLead, reverseResult.userBody, reverseResult.outputConstraints, reverseResult.userTail]
         .filter(Boolean).join('\n')
       // 文本路径修复：画面描述必须进入 LLM 上下文。user 是组装指令，desc 是用户对画面的描述；
       // user 开头非空时也要并入 desc，否则模型只收到指令、看不到画面内容（历史 bug：
       // builtin reverse profiles 四段拼接恒非空 → `user || desc` 永远取 user，desc 被静默丢弃）。
       const text = user
         ? (desc ? `${user}\n\n[${String(args.output_lang || 'zh') === 'en' ? 'Scene description' : '画面描述'}]\n${desc}` : user)
         : desc
       if (args.dry_run) {
-        return JSON.stringify({
+        const debug = JSON.stringify({
           debug: {
             system: reverseResult.system,
             text,
             imageBlocks: images.length,
             maxTokens: 512,
           },
           profile_meta: { id: profile.id, name: profile.name, outputFormat: profile.outputFormat },
         })
+        logInfo(`[prompt-master] prompt_reverse → ok=true dry_run=true chars=${debug.length}`)
+        return debug
       }
       const { provider, model } = resolveRoute(exec as ExecLike)
       const blocks: ContentBlock[] = [
         ...images.map((b) => ({ ...b })),
         ...(text ? [{ type: 'text' as const, text }] : []),
       ]
       if (images.length > 0) {
         const info = await (ctx.llm as any).resolveModelInfo?.(provider, model, exec.signal)
         if (!info || !info.inputModalities?.includes('image')) {
           throw new Error(`当前模型 ${model} 不支持图片输入，请在 Web UI Settings→Models 切换到支持图片输入的模型（如 deepseek-v4-flash-vision-exp），或在参数中提供 image_description 文本描述`)
@@ -109,14 +114,15 @@ export function registerReverseTool(ctx: Context, config: Config) {
         signal: exec.signal,
       })
       const sanitized = sanitizeFinalCaption(raw, {
         type: reverseResult.captionType,
         caption_lang: String(args.output_lang || 'zh'),
         len: String(args.length || 'medium'),
         anima3_enhance: args.anima3_enhance === true,
         quality_prompt_enabled: args.quality_prompt_enabled === true,
         quality_prompt_prefix: String(args.quality_prompt_prefix || ''),
       })
+      logInfo(`[prompt-master] prompt_reverse → ok=true chars=${sanitized.length}`)
       return sanitized
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/audit/budget-frame.test.ts b/plugins/prompt-master/tests/pe-framework/audit/budget-frame.test.ts
new file mode 100644
index 0000000..ae4ca80
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/audit/budget-frame.test.ts
@@ -0,0 +1,40 @@
+import { describe, expect, it } from 'vitest'
+import { buildH3Budget, H3_CONTEXT_LIMIT, DEFAULT_RUNTIME_SAFETY_MARGIN } from '../../../src/pe-framework/audit/budget.js'
+import { countTokensH3 } from '../../../src/pe-framework/audit/tokenizer-h3.js'
+import { resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
+import { dirname } from 'node:path'
+
+const realTokenizerDir = dirname(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' }))
+
+describe('H3 budget chat-frame precision', () => {
+  it('estimate fallback intact when tokenizer dir invalid', () => {
+    const b = buildH3Budget('t2va', 'hello', [{ who: 'a', image: 'x', width: 1024, height: 1024 }], { tokenizerSourceDir: 'C:/nonexistent' })
+    expect(b.counter).toBe('estimate')
+    // 回退口径：帧底用旧估算 5+2N（1 引用 → 7）
+    expect(b.chatTemplateTokens).toBe(7)
+  })
+
+  it('exact frame bottom with real tokenizer: refs>0 帧底来自 countTokensH3 而非 5+2N', () => {
+    const b = buildH3Budget('t2va', 'hello', [{ who: 'a', image: 'x', width: 1024, height: 1024 }], { tokenizerSourceDir: realTokenizerDir })
+    expect(b.counter).toBe('official-tokenizer')
+    const exactFrame = countTokensH3('', realTokenizerDir, 1).tokens
+    expect(b.chatTemplateTokens).toBe(exactFrame)
+    // 旧估算是 7（5+2*1）——官方帧（im_start/user/vision pads/im_end）严格大于估算
+    expect(exactFrame).toBeGreaterThan(7)
+  })
+
+  it('zero-ref frame bottom matches golden baseline (framed-raw=5, t2va_baker golden)', () => {
+    const b = buildH3Budget('t2va', 'x'.repeat(100), [], { tokenizerSourceDir: realTokenizerDir })
+    expect(b.chatTemplateTokens).toBe(5) // golden: raw=76 framed=81 → 无引用帧底 = 5
+    expect(b.qualityCap).toBe(1200)
+    expect(b.over).toBe(false)
+  })
+
+  it('effectiveCap reflects exact frame bottom in available', () => {
+    const refs = [{ who: 'a', image: 'x', width: 1024, height: 1024 }]
+    const b = buildH3Budget('t2va', 'hello', refs, { tokenizerSourceDir: realTokenizerDir })
+    const frame = countTokensH3('', realTokenizerDir, 1).tokens
+    const available = H3_CONTEXT_LIMIT - 1024 - frame - DEFAULT_RUNTIME_SAFETY_MARGIN
+    expect(b.effectiveCap).toBe(Math.min(1200, available))
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/intent/subagent-provider.test.ts b/plugins/prompt-master/tests/pe-framework/intent/subagent-provider.test.ts
index 1c06344..d5ab726 100644
--- a/plugins/prompt-master/tests/pe-framework/intent/subagent-provider.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/intent/subagent-provider.test.ts
@@ -107,20 +107,38 @@ describe('createSubagentIntentProvider', () => {
     await expect(fn({ target: 'anima', input: 'x', round: 0 } as any)).rejects.toThrow(/未产出 assistant 文本/)
     expect(fake.disposed).toBe(true)
   })
 
   it('unknown target throws after parse', async () => {
     const fake = makeFakeRun({ outputText: JSON.stringify({ x: 1 }) })
     const fn = createSubagentIntentProvider(makeFakeOwnerCtx(fake.run), { timeoutMs: 2000 })
     await expect(fn({ target: 'sd', input: 'x', round: 0 } as any)).rejects.toThrow(/未知 target/)
   })
 
+  it('req.persona/req.schema 优先于 opts 与 DEFAULT（Task 7 方言化）', async () => {
+    let captured: any = null
+    const run = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'] } }) })
+    const ctx = {
+      subagents: {
+        start: async (_provider: string, request: any) => { captured = request; return run.run },
+      },
+      agent: { options: { delegationDepth: 0 } },
+    } as any
+    const fn = createSubagentIntentProvider(ctx, { timeoutMs: 2000, persona: 'OPTS_PERSONA', schema: 'OPTS_SCHEMA' })
+    await fn({ target: 'anima', input: 'x', round: 0, persona: 'REQ_PERSONA_MARK', schema: 'REQ_SCHEMA_MARK' } as any)
+    const c = String(captured.prompt?.[0]?.text ?? '')
+    expect(c).toContain('REQ_PERSONA_MARK')
+    expect(c).toContain('REQ_SCHEMA_MARK')
+    expect(c).not.toContain('OPTS_PERSONA')
+    expect(c).not.toContain('资深')
+  })
+
   it('sends persona+schema+req as the subagent prompt', async () => {
     let captured: any = null
     const run = makeFakeRun({ outputText: JSON.stringify({ slots: { count_gender: ['1girl'] } }) })
     const ctx = {
       subagents: {
         start: async (_provider: string, request: any) => { captured = request; return run.run },
       },
       agent: { options: { delegationDepth: 0 } },
     } as any
     const fn = createSubagentIntentProvider(ctx, { timeoutMs: 2000 })
diff --git a/plugins/prompt-master/tests/plugin/logger-spy.test.ts b/plugins/prompt-master/tests/plugin/logger-spy.test.ts
new file mode 100644
index 0000000..12a987a
--- /dev/null
+++ b/plugins/prompt-master/tests/plugin/logger-spy.test.ts
@@ -0,0 +1,59 @@
+import { describe, expect, it, vi } from 'vitest'
+import { registerCompileTool } from '../../src/tools/prompt-compile.js'
+import { registerExpandTool } from '../../src/tools/prompt-expand.js'
+import { stubExec } from './helpers.js'
+
+/** �?logger spy �?ctx stub（复�?helpers stub 模式；logger 用可选链访问，缺失时工具静默跳过�?*/
+function spyCtx() {
+  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
+  const ctx: any = {
+    tools: { register(def: any) { return () => {} } },
+    llm: { stream: async function* () {} },
+    logger,
+    effect() {},
+  }
+  return { ctx, logger }
+}
+
+describe('tool logging (logger spy)', () => {
+  it('prompt_compile logs entry + success summaries; never the prompt body', async () => {
+    const { ctx, logger } = spyCtx()
+    const def = registerCompileTool(ctx)
+    const slots = {
+      count_gender: ['1girl'],
+      appearance: ['SECRET-APPEARANCE-BODY'],
+      narrative: 'SECRET-NARRATIVE-BODY',
+    }
+    await def.execute({ target: 'anima', slots, variant: 'base' }, stubExec() as any)
+    expect(logger.info.mock.calls.length).toBeGreaterThanOrEqual(1)
+    const all = logger.info.mock.calls.map((c) => String(c[0])).join('\n')
+    expect(all).toContain('prompt_compile')
+    expect(all).toContain('target=anima')
+    expect(all).toMatch(/�?ok=/)
+    // 正文不落日志
+    expect(all).not.toContain('SECRET-APPEARANCE-BODY')
+    expect(all).not.toContain('SECRET-NARRATIVE-BODY')
+  })
+
+  it('prompt_compile works without a logger (optional chaining, stub env)', async () => {
+    const ctx: any = {
+      tools: { register() { return () => {} } },
+      llm: { stream: async function* () {} },
+    }
+    const def = registerCompileTool(ctx)
+    const out = await def.execute({ target: 'anima', slots: { count_gender: ['1girl'] }, variant: 'base' }, stubExec() as any)
+    expect(String(out)).toContain('"ok"')
+  })
+
+  it('prompt_expand dry_run logs entry + success summary without the assembled body', async () => {
+    const { ctx, logger } = spyCtx()
+    const def = registerExpandTool(ctx, { temperature: 0.7 } as any)
+    const out = await def.execute({ text: 'EXPAND-INPUT-MARKER', dry_run: true }, stubExec() as any)
+    const all = logger.info.mock.calls.map((c) => String(c[0])).join('\n')
+    expect(all).toContain('prompt_expand')
+    expect(all).toContain('dry_run=true')
+    expect(all).toMatch(/�?ok=true/)
+    expect(all).not.toContain('EXPAND-INPUT-MARKER')
+    expect(String(out)).toContain('debug')
+  })
+})
```
