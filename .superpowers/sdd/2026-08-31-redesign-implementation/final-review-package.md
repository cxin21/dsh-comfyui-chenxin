# FINAL review package — refactor diff (ee78de5 baseline..HEAD, src+tests only)

Context: ee78de5 is the plugin-source baseline commit (whole-file adds of the pre-refactor tree; that commit itself is NOT under review). The refactor work is everything after it.

## Commits (Task 1-8)
```6f34a68 docs(prompt-master): resolver x 3.1.0 diff audit + usage doc (intent decision table, observability)
ee4c39d fix(prompt-master): wire ctx into registerCompileTool (enable production logging)
d0d1b67 feat(prompt-master): exact H3 chat-frame budget, dialect-driven intent persona, structured logging
761120b refactor(prompt-master): tools become thin views over runStage (remove duplicate orchestration)
84ea750 feat(prompt-master): register anima/h3 dialects (normalize converges stage/references)
c9f095d feat(prompt-master): add runStage pipeline kernel + render envelope layer
f63f9b2 feat(prompt-master): add dialect registry (registerDialect/getDialect/isDialectReady)
e46ae2c feat(prompt-master): replace hardcoded knowledge paths + asset manifest verification
207d263 test(prompt-master): cover DSH_COMFYUI_PRESET_ROOT env branch (priority chain level 2)
```n
## Stat
``` .../prompt-master/src/pe-framework/audit/budget.ts |  12 +-
 .../src/pe-framework/audit/tokenizer-h3.ts         |  20 ++-
 .../src/pe-framework/dialect/anima-catalog.ts      |  26 +++-
 .../src/pe-framework/dialect/anima.ts              |  50 +++++-
 .../src/pe-framework/dialect/contract.ts           |  32 ++++
 .../prompt-master/src/pe-framework/dialect/h3.ts   |  75 ++++++++-
 .../src/pe-framework/dialect/registry.ts           |  19 +++
 .../src/pe-framework/intent/subagent-provider.ts   |  66 +++++++-
 .../src/pe-framework/pipeline/runStage.ts          |  78 ++++++++++
 .../src/pe-framework/pipeline/types.ts             |  30 ++++
 .../src/pe-framework/render/envelope.ts            |  31 ++++
 .../src/pe-framework/resources/manifest.ts         |  36 +++++
 plugins/prompt-master/src/plugin/index.ts          |   4 +-
 plugins/prompt-master/src/tools/prompt-audit.ts    |  28 ++--
 plugins/prompt-master/src/tools/prompt-author.ts   | 167 +++++++++------------
 plugins/prompt-master/src/tools/prompt-compile.ts  | 119 ++++++---------
 plugins/prompt-master/src/tools/prompt-expand.ts   |   8 +-
 plugins/prompt-master/src/tools/prompt-reverse.ts  |   8 +-
 .../tests/pe-framework/audit/budget-frame.test.ts  |  40 +++++
 .../pe-framework/dialect/anima-register.test.ts    |  23 +++
 .../tests/pe-framework/dialect/h3-register.test.ts |  27 ++++
 .../tests/pe-framework/dialect/registry.test.ts    |  28 ++++
 .../pe-framework/intent/subagent-provider.test.ts  |  18 +++
 .../tests/pe-framework/pipeline/runStage.test.ts   |  81 ++++++++++
 .../tests/pe-framework/resources/manifest.test.ts  | 101 +++++++++++++
 .../tests/pe-framework/resources/resolve.test.ts   |  12 +-
 .../prompt-master/tests/plugin/compile-h3.test.ts  |  51 ++++---
 .../prompt-master/tests/plugin/h3-dialect.test.ts  |   2 +-
 .../prompt-master/tests/plugin/logger-spy.test.ts  |  59 ++++++++
 29 files changed, 1021 insertions(+), 230 deletions(-)
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
diff --git a/plugins/prompt-master/src/pe-framework/audit/tokenizer-h3.ts b/plugins/prompt-master/src/pe-framework/audit/tokenizer-h3.ts
index 9b0a1a4..204cb11 100644
--- a/plugins/prompt-master/src/pe-framework/audit/tokenizer-h3.ts
+++ b/plugins/prompt-master/src/pe-framework/audit/tokenizer-h3.ts
@@ -1,27 +1,38 @@
 /**
  * H3 官方 tokenizer（BPE）TS 移植（P3，保真最高风险）。
  * 唯一事实源：knowledge/tokenizer.json（BPE vocab 151,643 / merges 151,387 / 26 added tokens(14 special)，
  * normalizer NFC、pre_tokenizer Sequence[Split(GPT2 regex, Isolated), ByteLevel(use_regex:false)]、byte_fallback:false、unk_token:null）
  * 语义锚点：token_counting.py 委托 HuggingFace tokenizers Rust 后端（Tokenizer.from_file + encode(add_special_tokens=False)），
  * 此处按 tokenizer.json 配置复刻同一标准 BPE 流水线（逐 token 精确是唯一验收；T12 双跑）。
  */
 import { readFileSync } from 'node:fs'
-import { join } from 'node:path'
+import { dirname, join } from 'node:path'
+import { resolveKnowledgePath } from '../resources/resolve.js'
+import { assertH3Tokenizer } from '../resources/manifest.js'
 
 export interface H3TokenizerConfig {
   vocab: Map<string, number>
   merges: Map<string, number>
   addedTokens: Array<{ id: number; content: string; special: boolean }>
 }
 
-const DEFAULT_SOURCE_DIR = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/minimax-h3-prompt/knowledge'
+const defaultTokenizerSourceDir = () => dirname(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' }))
+let _tokenizerManifestChecked = false
+
+/** manifest 对账只在首次加载前跑一次；失败 console.warn 不硬崩（tokenizer 加载失败 → estimate 回退语义不变） */
+function verifyTokenizerManifestOnce(): void {
+  if (_tokenizerManifestChecked) return
+  _tokenizerManifestChecked = true
+  const r = assertH3Tokenizer()
+  if (!r.ok) console.warn(`[prompt-master] ${r.reason}：资产与 golden 基线不同，请 re-run fidelity capture`)
+}
 
 /** GPT2 split regex（tokenizer.json pre_tokenizer Split pattern，行为 Isolated）——JS 以 i+u 旗标等价 Python (?i:) */
 const SPLIT_RE = /'s|'t|'re|'ve|'m|'ll|'d|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu
 
 /** 生成 GPT-2 标准 byte→unicode 字母表（ByteLevel）：33-126 与 161-172、174-255（Latin-1 可打印）原样；其余字节按序映射 U+0100..（32→'Ġ' U+0120） */
 function buildByteAlphabet(): string[] {
   const alphabet: string[] = new Array(256)
   let special = 0
   for (let b = 0; b < 256; b++) {
     if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255)) {
@@ -49,21 +60,22 @@ function splitIsolated(re: RegExp, text: string): string[] {
   return out.filter((p) => p.length > 0)
 }
 
 export class H3Tokenizer {
   readonly vocab: Map<string, number>
   readonly merges: Map<string, number>
   readonly addedTokens: H3TokenizerConfig['addedTokens']
   private readonly byteAlphabet: string[]
   private readonly specialMatcher: Array<{ id: number; content: string; special: boolean }>
 
-  constructor(sourceDir: string = DEFAULT_SOURCE_DIR) {
+  constructor(sourceDir: string = defaultTokenizerSourceDir()) {
+    verifyTokenizerManifestOnce()
     const raw = JSON.parse(readFileSync(join(sourceDir, 'tokenizer.json'), 'utf8'))
     const model = raw.model
     if (model.type !== 'BPE') throw new Error(`unsupported tokenizer model type: ${model.type}`)
     this.vocab = new Map<string, number>()
     for (const [k, v] of Object.entries(model.vocab as Record<string, number>)) this.vocab.set(k, v)
     this.merges = new Map<string, number>()
     for (let i = 0; i < (model.merges as string[]).length; i++) this.merges.set((model.merges as string[])[i], i)
     this.addedTokens = (raw.added_tokens ?? []).map((t: { id: number; content: string; special?: boolean }) => ({
       id: t.id,
       content: t.content,
@@ -194,21 +206,21 @@ export class H3Tokenizer {
       references += `Picture ${i}: <|vision_start|><|image_pad|><|vision_end|>\n`
     }
     return this.count(`<|im_start|>user\n${references}${text}<|im_end|>\n`)
   }
 }
 
 let _instance: H3Tokenizer | null = null
 let _instanceDir: string | undefined
 
 export function h3Tokenizer(sourceDir?: string): H3Tokenizer {
-  const dir = sourceDir ?? process.env.H3_TOKENIZER_DIR ?? DEFAULT_SOURCE_DIR
+  const dir = sourceDir ?? process.env.H3_TOKENIZER_DIR ?? defaultTokenizerSourceDir()
   if (!_instance || _instanceDir !== dir) {
     _instance = new H3Tokenizer(dir)
     _instanceDir = dir
   }
   return _instance
 }
 
 export function countTokensH3(text: string, sourceDir?: string, referenceCount = 0): { tokens: number; ids?: number[] } {
   const t = h3Tokenizer(sourceDir)
   return { tokens: t.countContext(text, referenceCount) }
diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
index 3864888..f61c9e1 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts
@@ -1,39 +1,53 @@
 /**
  * Anima tag-catalog 查询层（P2 定案）。
  * 来源：comfyui-chenxin preset knowledge/tag-catalog.sqlite（FTS5 1.39M 行）+ catalog/search.py 匹配语义。
  * node:sqlite DatabaseSync 只读直读；canonical→alias→fuzzy 级联（mode auto）；'exact' = 不含 fuzzy 的精确级联。
  */
 import { DatabaseSync } from 'node:sqlite'
 import { statSync, existsSync } from 'node:fs'
-import { join } from 'node:path'
+import { dirname } from 'node:path'
+import { resolveKnowledgePath } from '../resources/resolve.js'
+import { assertAnimaCatalog } from '../resources/manifest.js'
 
 export interface CatalogHit {
   match_type: 'canonical' | 'alias' | 'fuzzy' | 'miss'
   prompt_form?: string
   record_id?: string
   usage_count?: number
   raw?: string
 }
 
 export interface CatalogQueryOptions {
   mode?: 'auto' | 'exact'
   limit?: number
 }
 
 export type MatchKind = 'canonical' | 'alias' | 'fuzzy' | 'miss'
 
-const DEFAULT_CATALOG_PATH = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite'
-const OVERLAY_PATH = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge/relation-overlay.sqlite'
+const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
+const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })
 
 let _db: DatabaseSync | null = null
-let _dbPath = process.env.ANIMA_CATALOG_PATH ?? DEFAULT_CATALOG_PATH
+let _dbPath = process.env.ANIMA_CATALOG_PATH ?? defaultCatalogPath()
+let _manifestChecked = false
+
+/** manifest 对账只跑一次；失败 console.warn 但不硬崩（资源层无 ctx.logger，spec §4.2）。
+ *  在模块求值期执行（先于任何 db 打开）：783MiB catalog 的 sha256 在全量测试并行 IO 下会超过
+ *  vitest 单测 5s 超时，放在惰性 db() 路径会把首次查询拖超时；模块期不计入测试计时。 */
+function verifyManifestOnce(): void {
+  if (_manifestChecked) return
+  _manifestChecked = true
+  const r = assertAnimaCatalog()
+  if (!r.ok) console.warn(`[prompt-master] ${r.reason}：资产与 golden 基线不同，请 re-run fidelity capture`)
+}
+verifyManifestOnce()
 
 export function catalogPath(): string {
   return _dbPath
 }
 
 export function setCatalogPath(path: string): void {
   if (_db) { _db.close(); _db = null }
   _dbPath = path
 }
 
@@ -120,21 +134,21 @@ export function classifyTag(tag: string): MatchKind {
   }
   return 'miss'
 }
 
 /** relation-overlay 缺失 → 降级空视图 + advisory（B3 定案） */
 export function overlayView(): { tags: Record<string, string> } {
   return { tags: {} }
 }
 
 export function overlayStatus(): 'available' | 'unavailable' {
-  return existsSync(OVERLAY_PATH) ? 'available' : 'unavailable'
+  return existsSync(defaultOverlayPath()) ? 'available' : 'unavailable'
 }
 
 export const OVERLAY_ADVISORY = 'overlay_unavailable'
 
 export function catalogMeta(): { file: string; sizeBytes: number; tables: string[]; fts: boolean } {
   const tables = db()
     .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
     .all()
     .map((r) => (r as { name: string }).name)
   const fts = tables.includes('catalog_fts')
@@ -147,12 +161,12 @@ export function catalogMeta(): { file: string; sizeBytes: number; tables: string
   return { file: _dbPath, sizeBytes, tables, fts }
 }
 
 /** 便捷 close（测试隔离用） */
 export function closeCatalog(): void {
   if (_db) { _db.close(); _db = null }
 }
 
 /** 预设 knowledge 目录推导（供 config 接线） */
 export function knowledgeDir(): string {
-  return join('C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge')
+  return dirname(defaultCatalogPath())
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/pe-framework/dialect/anima.ts b/plugins/prompt-master/src/pe-framework/dialect/anima.ts
index 83573e7..1d857a4 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/anima.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/anima.ts
@@ -1,17 +1,20 @@
 /**
  * Anima 编译/审计/关系覆盖 TS 归化（P2 核心）。
  * 逐函数对照：composition.py / grounding.py / output.py / inspection.py / types.py（facets.normalize 经 anima-catalog）。
  * A14 修正：canonical/alias → 直用 catalog.prompt_form；fuzzy/miss → 保留原文 + catalog_miss advisory/assumption（不自动替换）。
  */
 import { SLOT_ORDER } from '../anima.js'
 import { normalizeTag, searchCatalog, overlayStatus, type CatalogHit } from './anima-catalog.js'
+import { registerDialect } from './registry.js'
+import type { DialectContract } from './contract.js'
+import { ANIMA_PERSONA, ANIMA_SCHEMA } from '../intent/subagent-provider.js'
 import type { AuditGate } from '../types.js'
 
 export interface AnimaSlots {
   count_gender?: string[]
   character?: string[]
   appearance?: string[]
   clothing?: string[]
   pose_action?: string[]
   expression?: string[]
   camera?: string[]
@@ -339,11 +342,56 @@ export function overlayAdvisory(): string[] {
 
 export function applyRelationOverlay(catalog: { overlayStatus(): string }): void {
   if (catalog.overlayStatus() !== 'available') {
     _overlayAdvisories = ['overlay_unavailable']
   }
 }
 
 /** 便捷导出：variant 策略表供报告/测试 */
 export function variantPolicy(variant: string): Policy {
   return POLICIES[variant] ?? POLICIES.base
-}
\ No newline at end of file
+}
+
+/* ── Task 5：方言注册（validateAnimaSlots 收敛 _coerce_brief 校验）── */
+
+const ANIMA_SLOT_KEYS = new Set(['count_gender', 'character', 'appearance', 'clothing', 'pose_action', 'expression', 'camera', 'scene', 'detail_mood'])
+
+/** composition.py _coerce_brief 移植：槽位键白名单 + 类型校验（narrative string、其余 string[]） */
+export function validateAnimaSlots(slots: unknown): string | undefined {
+  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'anima 需要 slots 对象'
+  const s = slots as Record<string, unknown>
+  for (const k of Object.keys(s)) {
+    if (k === 'narrative') { if (typeof s[k] !== 'string') return 'narrative 需为 string'; continue }
+    if (!ANIMA_SLOT_KEYS.has(k)) return `未知槽位: ${k}`
+    if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== 'string')) return `槽位 ${k} 需为 string[]`
+  }
+  return undefined
+}
+
+export function registerAnimaDialect(): void {
+  const contract: DialectContract<Record<string, unknown>, { positive: string; negative: string }> = {
+    id: 'anima',
+    label: 'Anima',
+    auditOnlyOk: true,
+    normalize: (input) => {
+      const slots = (input as { slots?: Record<string, unknown> } | undefined)?.slots
+      const err = validateAnimaSlots(slots)
+      if (err) return { error: err }
+      return { value: slots as Record<string, unknown> }
+    },
+    compile: (slots, opts) => {
+      const variant = (opts.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
+      return compileAnima(slots as AnimaSlots, { variant })
+    },
+    audit: (compiled, ctx) => {
+      const variant = (ctx.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
+      const slots = ctx.shots as unknown as AnimaSlots // runStage audit ctx.shots = 归一化 value（slots）
+      return { gates: auditAnima(compiled.positive, compiled.negative, { variant, slots }) }
+    },
+    targetSlotHint: 't2i.prompt',
+    intent: { persona: ANIMA_PERSONA, schema: ANIMA_SCHEMA },
+  }
+  registerDialect(contract)
+}
+
+// 模块级副作用注册：plugin/index.ts import 本模块即完成装配
+registerAnimaDialect()
\ No newline at end of file
diff --git a/plugins/prompt-master/src/pe-framework/dialect/contract.ts b/plugins/prompt-master/src/pe-framework/dialect/contract.ts
new file mode 100644
index 0000000..8588f7a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/dialect/contract.ts
@@ -0,0 +1,32 @@
+import type { AuditGate, Target } from '../types.js'
+import type { Reference } from '../schema/h3-shots.js'
+
+export type { Target }
+
+export interface PipelineInputLike {
+  target: Target
+  slots?: unknown
+  variant?: string
+  shots?: unknown
+  stage?: string
+  scenarioId?: string
+  formFields?: Record<string, unknown>
+  auditOnly?: boolean
+}
+
+export interface DialectContract<TSlots = unknown, TCompiled = unknown> {
+  id: Target
+  label: string
+  auditOnlyOk: boolean
+  normalize(input: PipelineInputLike, opts: { stage?: string; scenarioId?: string; formFields?: unknown }): {
+    error?: string
+    value?: TSlots
+    stage?: string
+    references?: Reference[]
+  }
+  compile(slots: TSlots, opts: { variant?: string; stage?: string }): TCompiled
+  audit(compiled: TCompiled, ctx: { stage?: string; references?: Reference[]; shots?: unknown; variant?: string }): { gates: AuditGate[]; assumptions?: string[] }
+  budget?(compiled: TCompiled, opts: { stage?: string; references?: Reference[] }): unknown
+  targetSlotHint: string
+  intent?: { persona: string; schema: string }
+}
diff --git a/plugins/prompt-master/src/pe-framework/dialect/h3.ts b/plugins/prompt-master/src/pe-framework/dialect/h3.ts
index baf89ee..eafedbc 100644
--- a/plugins/prompt-master/src/pe-framework/dialect/h3.ts
+++ b/plugins/prompt-master/src/pe-framework/dialect/h3.ts
@@ -1,14 +1,19 @@
 /**
  * H3 authoring dialect（TS 移植，逐字符对照 h3_prompt/dialect.py）。
  */
-import { KEYFRAME_STAGES, type Reference, type H3Shot, type StoryRequest } from '../schema/h3-shots.js'
+import { KEYFRAME_STAGES, type Reference, type H3Shot, type StoryRequest, type H3ShotsInput } from '../schema/h3-shots.js'
+import { registerDialect } from './registry.js'
+import type { DialectContract } from './contract.js'
+import { contractGatesH3, auditH3Full } from '../audit/rules-h3.js'
+import { buildH3Budget, h3BudgetToReport } from '../audit/budget.js'
+import { H3_PERSONA, H3_SCHEMA } from '../intent/subagent-provider.js'
 
 const CJK = /[\u4e00-\u9fff]/
 const KANA = /[\u3040-\u30ff]/
 const END_PUNCT = '.!?…'
 
 export function formatTimestamp(seconds: number): string {
   const totalMs = Math.round(seconds * 1000)
   const minutes = Math.floor(totalMs / 60_000)
   const rem = totalMs % 60_000
   const secs = Math.floor(rem / 1000)
@@ -231,37 +236,97 @@ export function buildTextZh(textEn: string): string {
     outLines.push(skeletonTokenize(stripped))
   }
   return outLines.join('\n').trim()
 }
 
 export function buildTextPair(stage: string, request: StoryRequest): { text: string; textZh: string } {
   const textEn = buildText(stage, request)
   return { text: textEn, textZh: buildTextZh(textEn) }
 }
 
-/** 供 T7/E2E 消费（brief 接口）：输入扁平 story → {text, textZh} */
+/** 供 T7/E2E 消费（brief 接口）：输入扁平 story → {text, text_zh}（Task 6 键桥接：result 键直接匹配 golden text_zh） */
 export function compileH3(
   input: { duration_seconds: number; shots: H3Shot[]; references?: unknown[] },
   opts?: { stage?: string },
-): { text: string; textZh: string } {
+): { text: string; text_zh: string } {
   const stage = opts?.stage ?? 't2va'
   const refs: Reference[] = Array.isArray(input.references)
     ? (input.references as unknown[]).map((r) => {
         const raw = r as Record<string, unknown>
         return {
           who: raw['who'] != null ? String(raw['who']) : null,
           image: String(raw['image'] ?? ''),
           width: typeof raw['width'] === 'number' ? raw['width'] : null,
           height: typeof raw['height'] === 'number' ? raw['height'] : null,
         }
       })
     : []
   const request: StoryRequest = {
     stage,
     duration_seconds: input.duration_seconds,
     shots: input.shots,
     references: refs,
     videos: [],
     audios: [],
   }
-  return buildTextPair(stage, request)
-}
\ No newline at end of file
+  const pair = buildTextPair(stage, request)
+  return { text: pair.text, text_zh: pair.textZh }
+}
+
+/* ── Task 5：方言注册（normalize 收敛 inferH3Stage/refs 归一；工具侧副本 Task 6 删）── */
+
+/** refs 归一单点（prompt-author/prompt-compile/prompt-audit 的 toRefs 收敛）：who/image 字符串化 + width/height 仅接受 number（否则 null） */
+export function normalizeRefs(raw: unknown[]): Reference[] {
+  return raw.map((r) => {
+    const x = r as Record<string, unknown>
+    return {
+      who: x['who'] != null ? String(x['who']) : null,
+      image: String(x['image'] ?? ''),
+      width: typeof x['width'] === 'number' ? x['width'] : null,
+      height: typeof x['height'] === 'number' ? x['height'] : null,
+    }
+  })
+}
+
+/** stage 推断 + references 规范化（从 prompt-author.ts inferH3Stage/toRefs 收敛；Task 6 删除工具侧副本） */
+export function normalizeH3Input(
+  input: unknown,
+  opts: { stage?: string; scenarioId?: string; formFields?: unknown },
+): { error?: string; value?: H3ShotsInput; stage?: string; references?: Reference[] } {
+  const shots = (input as { shots?: H3ShotsInput } | undefined)?.shots
+  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) {
+    return { error: 'intent 未产出 shots 结构' }
+  }
+  const formRefs = Array.isArray((opts.formFields as Record<string, unknown> | undefined)?.references)
+    ? ((opts.formFields as Record<string, unknown>).references as unknown[]) : []
+  const refs = Array.isArray(shots.references) ? shots.references : []
+  const references = normalizeRefs(refs.length > 0 ? refs : formRefs)
+  // 优先级与现 prompt-author.ts inferH3Stage 一致：显式 stage > references 存在 > scenarioId==='full_reference' > t2va
+  const stage = opts.stage || (references.length > 0 ? 'ref2va' : opts.scenarioId === 'full_reference' ? 'ref2va' : 't2va')
+  return { value: shots, stage, references }
+}
+
+export function registerH3Dialect(): void {
+  const contract: DialectContract<H3ShotsInput, { text: string; text_zh: string }> = {
+    id: 'h3',
+    label: 'MiniMax-H3',
+    auditOnlyOk: true,
+    normalize: (input, opts) => normalizeH3Input(input, opts),
+    compile: (shots, opts) => compileH3(shots, { stage: opts.stage ?? 't2va' }),
+    audit: (compiled, ctx) => {
+      const stage = ctx.stage ?? 't2va'
+      const shots = ctx.shots as H3ShotsInput
+      const gates = [
+        ...contractGatesH3(stage, shots, ctx.references ?? []),
+        ...auditH3Full(compiled.text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, ctx.references),
+      ]
+      return { gates, assumptions: [] }
+    },
+    budget: (compiled, ctx) => h3BudgetToReport(buildH3Budget(ctx.stage ?? 't2va', compiled.text, ctx.references ?? [])),
+    targetSlotHint: 't2v.prompt',
+    intent: { persona: H3_PERSONA, schema: H3_SCHEMA },
+  }
+  registerDialect(contract)
+}
+
+// 模块级副作用注册：plugin/index.ts import 本模块即完成装配
+registerH3Dialect()
\ No newline at end of file
diff --git a/plugins/prompt-master/src/pe-framework/dialect/registry.ts b/plugins/prompt-master/src/pe-framework/dialect/registry.ts
new file mode 100644
index 0000000..1666a3a
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/dialect/registry.ts
@@ -0,0 +1,19 @@
+import type { DialectContract } from './contract.js'
+
+export type { DialectContract }
+import type { Target } from '../types.js'
+
+const dialects = new Map<Target, DialectContract>()
+
+export function registerDialect(contract: DialectContract): void {
+  if (dialects.has(contract.id)) throw new Error(`dialect already registered: ${contract.id}`)
+  dialects.set(contract.id, contract)
+}
+export function getDialect(target: Target): DialectContract | undefined {
+  return dialects.get(target)
+}
+export function isDialectReady(target: Target): boolean {
+  return dialects.has(target)
+}
+/** 仅测试用：清空注册表（模块级单例在 vitest 间的隔离） */
+export function __resetDialectsForTests(): void { dialects.clear() }
diff --git a/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts b/plugins/prompt-master/src/pe-framework/intent/subagent-provider.ts
index c97a3a6..4bb6e6b 100644
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
@@ -164,20 +165,81 @@ function normalizeSlots(raw: unknown): AnimaSlots {
     if (k === 'narrative') {
       out[k] = typeof v === 'string' ? v : (Array.isArray(v) ? (v as unknown[]).map(String).join(' ') : v == null ? '' : String(v))
     } else {
       out[k] = Array.isArray(v) ? (v as unknown[]).map((x) => String(x))
         : v == null ? [] : [String(v)]
     }
   }
   return out as AnimaSlots
 }
 
+/* ── per-target persona/schema 拆分（Task 5）：语义等价拆出，DEFAULT_* 保留原值作兜底 ── */
+
+export const ANIMA_PERSONA = `你是一位资深的 Anima 提示词工程创作者。
+你的任务：根据用户的创作意图，产出与 Anima 方言严格对齐的结构化输入内容。
+
+规则：
+1. 产出 Anima slots（count_gender / character / appearance / clothing / pose_action / expression / camera / scene / detail_mood 等）与 narrative；不输出方言编译结果
+2. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
+3. **尊重用户原始意图**：用户给的描述字符串（narrative 等）保持原文字面，不要为了更"通顺"而重写或编造
+4. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）
+
+输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
+`
+
+export const H3_PERSONA = `你是一位资深的 MiniMax-H3 视频提示词工程创作者。
+你的任务：根据用户的创作意图，产出与 H3 方言严格对齐的结构化输入内容。
+
+规则：
+1. 产出 H3 shots（duration_seconds + 每 shot 的 what/ambient/music/dialogue/who）
+2. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
+3. **尊重用户原始意图**：用户给的描述字符串（what/ambient 等）保持原文字面，不要为了更"通顺"而重写或编造
+4. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）
+
+输出：严格按下方 JSON Schema 的 JSON 字符串，不要包含任何额外文字（不要 markdown fence，不要解释）。
+`
+
+export const ANIMA_SCHEMA = `{
+  "slots": {
+    "count_gender": ["1girl"],
+    "character": ["Subject 1 from <Picture 1>"],
+    "appearance": ["long hair", "blue eyes"],
+    "clothing": ["red dress"],
+    "pose_action": ["standing"],
+    "expression": ["smile"],
+    "camera": ["close-up"],
+    "scene": ["sunset rooftop"],
+    "detail_mood": ["cinematic"],
+    "narrative": "自由文本，可空"
+  }
+}
+
+输出规则：
+- 只能输出一个 JSON 对象，不要任何前缀后缀文字
+- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
+- 用户提供 references 时保持 ref 标签稳定
+`
+
+export const H3_SCHEMA = `{
+  "duration_seconds": 10,
+  "references": [],
+  "shots": [
+    { "what": "镜头内容", "who": "<Subject 1>", "ambient": "环境声", "music": "BGM", "dialogue": "对白或省略" }
+  ]
+}
+
+输出规则：
+- 只能输出一个 JSON 对象，不要任何前缀后缀文字
+- 必须用 \`\`\`json fence 或纯 JSON；纯 JSON 优先
+- 用户提供 references 时保持 ref 标签稳定
+`
+
 const DEFAULT_PERSONA = `你是一位资深的提示词工程创作者（Anima / MiniMax-H3 方言）。
 你的任务：根据用户的创作意图与目标方言，产出与目标方言严格对齐的结构化输入内容。
 
 规则：
 1. 若 target=anima：产出 Anima slots（count_gender / character / appearance / clothing / pose_action / expression / camera / scene / detail_mood 等）与 narrative；不输出方言编译结果
 2. 若 target=h3：产出 H3 shots（duration_seconds + 每 shot 的 what/ambient/music/dialogue/who）
 3. 若 refs（图片/视频/音频引用）传入：保持 ref 标签稳定（<Picture N>/<Subject N>/<Video N>/<Audio N>），不要替换
 4. **尊重用户原始意图**：用户给的描述字符串（narrative/what/ambient 等）保持原文字面，不要为了更"通顺"而重写或编造
 5. 字段尽量来自用户输入；缺则用最小化合理解释（不编造情节）
 
diff --git a/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
new file mode 100644
index 0000000..126410f
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/pipeline/runStage.ts
@@ -0,0 +1,78 @@
+import { getDialect } from '../dialect/registry.js'
+import type { AuditGate, Budget } from '../types.js'
+import { targetSlotHint } from '../render/envelope.js'
+import type { PipelineInput, PipelineTrace, StageResult } from './types.js'
+
+/**
+ * 唯一管线内核：按注册表调度，零目标业务分支、零日志。
+ * normalize error / auditOnly 不兼容 → throw（可读错误）；方言未注册 → 失败 StageResult。
+ */
+export function runStage(input: PipelineInput): StageResult {
+  const d = getDialect(input.target)
+  if (!d) {
+    const gate: AuditGate = {
+      rule: 'dialect_not_available',
+      target: input.target,
+      severity: 'critical',
+      detail: `方言 ${input.target} 未注册（请以 registerDialect 装配）`,
+      source: 'pipeline/runStage',
+    }
+    return {
+      ok: false,
+      result: {},
+      gates: [gate],
+      advisories: [],
+      assumptions: [],
+      targetSlotHint: targetSlotHint(input.target),
+    }
+  }
+
+  const t0 = performance.now()
+  const auditOnly = input.auditOnly === true
+  if (auditOnly && !d.auditOnlyOk) {
+    throw new Error(`target ${input.target} 不支持 auditOnly`)
+  }
+
+  const normalized = d.normalize(
+    { target: input.target, slots: input.slots, variant: input.variant, shots: input.shots, stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields, auditOnly },
+    { stage: input.stage, scenarioId: input.scenarioId, formFields: input.formFields },
+  )
+  const tSchema = performance.now()
+  if (normalized.error !== undefined) throw new Error(normalized.error)
+  const slots = normalized.value
+  // normalize 单点推断的 stage（h3: references/full_reference → ref2va）优先于显式输入（Task 6：工具侧 inferH3Stage 已删）
+  const stage = normalized.stage ?? input.stage
+
+  const compiled = d.compile(slots as never, { variant: input.variant, stage })
+  const tDialect = performance.now()
+
+  const audit = d.audit(compiled as never, { stage, references: normalized.references, shots: normalized.value ?? input.shots, variant: input.variant })
+  const tAudit = performance.now()
+
+  const budgetRaw = d.budget?.(compiled as never, { stage, references: normalized.references })
+  const tBudget = performance.now()
+
+  const ok = audit.gates.every((g) => g.severity !== 'critical')
+  const result: Record<string, unknown> = auditOnly ? {} : (compiled as Record<string, unknown>)
+
+  const renderMs = 0
+  const stages: PipelineTrace['stages'] = [
+    { name: 'schema', ms: tSchema - t0 },
+    { name: 'dialect', ms: tDialect - tSchema },
+    { name: 'audit', ms: tAudit - tDialect },
+    ...(budgetRaw !== undefined ? [{ name: 'budget' as const, ms: tBudget - tAudit }] : []),
+    { name: 'render', ms: renderMs },
+  ]
+  const trace: PipelineTrace = { stages }
+
+  return {
+    ok,
+    result,
+    gates: audit.gates,
+    advisories: [],
+    assumptions: audit.assumptions ?? [],
+    ...(budgetRaw !== undefined ? { budget: budgetRaw as Budget } : {}),
+    targetSlotHint: d.targetSlotHint,
+    trace,
+  }
+}
diff --git a/plugins/prompt-master/src/pe-framework/pipeline/types.ts b/plugins/prompt-master/src/pe-framework/pipeline/types.ts
new file mode 100644
index 0000000..607f2a4
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/pipeline/types.ts
@@ -0,0 +1,30 @@
+import type { AuditGate, Budget } from '../types.js'
+
+export interface PipelineInput {
+  target: 'anima' | 'h3' | 'sd' | 'generic'
+  slots?: Record<string, unknown>
+  variant?: string
+  shots?: unknown
+  stage?: string
+  scenarioId?: string
+  formFields?: Record<string, unknown>
+  auditOnly?: boolean
+}
+
+export interface PipelineTrace {
+  stages: Array<{ name: 'schema' | 'dialect' | 'audit' | 'budget' | 'render'; ms: number }>
+  catalogHits?: number
+  tokenCounter?: 'official-tokenizer' | 'estimate'
+  references?: number
+}
+
+export interface StageResult {
+  ok: boolean
+  result: Record<string, unknown>
+  gates: AuditGate[]
+  advisories: string[]
+  assumptions: string[]
+  budget?: Budget
+  targetSlotHint: string
+  trace?: PipelineTrace
+}
diff --git a/plugins/prompt-master/src/pe-framework/render/envelope.ts b/plugins/prompt-master/src/pe-framework/render/envelope.ts
new file mode 100644
index 0000000..1a232e5
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/render/envelope.ts
@@ -0,0 +1,31 @@
+import type { AuditReport } from '../types.js'
+import { serializeReport } from '../audit/report.js'
+import type { StageResult } from '../pipeline/types.js'
+
+/** target → 默认 slot 提示；方言自带 targetSlotHint 时优先使用方言值 */
+export function targetSlotHint(target: string): string {
+  if (target === 'h3') return 't2v.prompt'
+  if (target === 'anima') return 't2i.prompt'
+  return 'generic.prompt'
+}
+
+/**
+ * P1 Envelope 唯一组装点（Task 4 定案：audit 收敛为 legacy 形状 {passed, gates, budget?}；
+ * assumptions/advisories 不再入 audit 对象——顶层 advisories 是唯一读取点）：
+ * { ok, ...(ok ? {result} : {}), audit:{passed, gates, ...(budget?{budget}:{})}, advisories:[...stage.advisories, ...trail], target_slot_hint }
+ */
+export function assembleEnvelope(stage: StageResult, trail?: string[]): string {
+  const audit = {
+    passed: stage.ok,
+    gates: stage.gates,
+    ...(stage.budget !== undefined ? { budget: stage.budget } : {}),
+  }
+  const envelope: Record<string, unknown> = {
+    ok: stage.ok,
+    ...(stage.ok ? { result: stage.result } : {}),
+    audit,
+    advisories: [...stage.advisories, ...(trail ?? [])],
+    target_slot_hint: stage.targetSlotHint,
+  }
+  return serializeReport(envelope as unknown as AuditReport)
+}
diff --git a/plugins/prompt-master/src/pe-framework/resources/manifest.ts b/plugins/prompt-master/src/pe-framework/resources/manifest.ts
new file mode 100644
index 0000000..b6e3800
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/resources/manifest.ts
@@ -0,0 +1,36 @@
+// src/pe-framework/resources/manifest.ts — 资产 manifest 对账（校验失败不硬崩，warn 兜底在接线处）
+import { readFileSync, existsSync } from 'node:fs'
+import { createHash } from 'node:crypto'
+import { resolveKnowledgePath } from './resolve.js'
+
+export type AssetCheck = { ok: true } | { ok: false; reason: string }
+
+export function sha256File(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex')
+}
+
+/** anima catalog：manifest.json 的 output.checksum（或顶层 checksum）vs tag-catalog.sqlite 实算 */
+export function assertAnimaCatalog(): AssetCheck {
+  try {
+    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'manifest.json' }), 'utf8')) as any
+    const expected: string | undefined = m?.output?.checksum ?? m?.checksum
+    if (!expected) return { ok: false, reason: 'catalog manifest has no checksum field' }
+    const actual = sha256File(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
+    return expected === actual ? { ok: true } : { ok: false, reason: `catalog checksum mismatch (manifest=${expected} actual=${actual})` }
+  } catch (e) {
+    return { ok: false, reason: `catalog manifest unreadable: ${e instanceof Error ? e.message : String(e)}` }
+  }
+}
+
+/** h3 tokenizer：manifest.json snapshot_id === 'h3-qwen3-vl' 且 tokenizer.json 存在 */
+export function assertH3Tokenizer(): AssetCheck {
+  try {
+    const tokPath = resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })
+    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'manifest.json' }), 'utf8')) as any
+    const okId = m?.snapshot_id === 'h3-qwen3-vl'
+    const tokExists = existsSync(tokPath)
+    return okId && tokExists ? { ok: true } : { ok: false, reason: `tokenizer manifest mismatch (snapshot_id=${m?.snapshot_id ?? 'missing'}, tokenizer_exists=${tokExists})` }
+  } catch (e) {
+    return { ok: false, reason: `tokenizer manifest unreadable: ${e instanceof Error ? e.message : String(e)}` }
+  }
+}
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
index 778acf5..bc7503b 100644
--- a/plugins/prompt-master/src/plugin/index.ts
+++ b/plugins/prompt-master/src/plugin/index.ts
@@ -3,20 +3,22 @@ import type { Context } from '@deepseek-ai/cordis'
 import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
 import { registerExpandTool } from '../tools/prompt-expand.js'
 import { registerReverseTool } from '../tools/prompt-reverse.js'
 import { registerMinimaxTool } from '../tools/minimax-scenario.js'
 import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
 import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
 import { registerCompileTool } from '../tools/prompt-compile.js'
 import { registerCatalogSearchTool } from '../tools/catalog-search.js'
 import { registerAuditTool } from '../tools/prompt-audit.js'
 import { setCustomProfileSource } from '../resolver/profiles/source.js'
+import '../pe-framework/dialect/anima.js'
+import '../pe-framework/dialect/h3.js'
 import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
 import { setPresetRoot } from '../pe-framework/resources/resolve.js'
 import { Config, type Config as ConfigShape } from './config.js'
 
 export const name = 'prompt-master'
 export const inject = ['tools', 'llm', 'settings', 'subagents']
 export { Config }
 
 export function apply(ctx: Context, config: ConfigShape) {
   // 资源路径解析：显式 presetRoot 优先（其后 env / preset 布局 fallback 在 resolve 内部处理）
@@ -43,16 +45,16 @@ export function apply(ctx: Context, config: ConfigShape) {
   //     必须早于 author 工具注册/调用 → 在 ctx.effect 之前完成
   setAuthorIntentProvider(createDefaultIntentProvider(ctx))
 
   ctx.effect(() => {
     const disposers: (() => void)[] = []
     disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
     disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
     disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
     disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope })))
     disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
-    disposers.push(ctx.tools.register(registerCompileTool()))
+    disposers.push(ctx.tools.register(registerCompileTool(ctx)))
     disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
     disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
     return () => { for (const d of disposers) d() }
   }, 'prompt-master.tools')
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/prompt-audit.ts b/plugins/prompt-master/src/tools/prompt-audit.ts
index 9daf339..02ddb06 100644
--- a/plugins/prompt-master/src/tools/prompt-audit.ts
+++ b/plugins/prompt-master/src/tools/prompt-audit.ts
@@ -1,12 +1,13 @@
 import { defineTool } from '@deepseek-ai/dsh-tools'
 import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
+import { normalizeRefs } from '../pe-framework/dialect/h3.js'
 import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
 import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
 import { serializeReport } from '../pe-framework/audit/report.js'
 import type { AuditGate } from '../pe-framework/types.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface AuditContent {
   target: 'anima' | 'h3'
@@ -41,44 +42,34 @@ export function auditContentEnvelope(content: AuditContent): string {
     if (typeof content.text !== 'string') throw new Error('h3 审计需要 text 文本')
     const stage = content.stage ?? 't2va'
     const duration = content.duration ?? 10
     const shotCount = content.shotCount ?? ((content.text.match(/\[Shot \d+\]/g) ?? []).length || 1)
     const references = content.references ?? []
     const shots: H3ShotsInput = { duration_seconds: duration, shots: [{ what: content.text.slice(0, 200) }] }
     gates = [
       ...contractGatesH3(stage, { duration_seconds: duration, shots: [{ what: 'x' }] }, references),
       ...auditH3Full(content.text, { stage, duration, shotCount }, references),
     ]
-    budget = h3BudgetToReport(buildH3Budget(stage, content.text, toRefs(references)))
+    budget = h3BudgetToReport(buildH3Budget(stage, content.text, normalizeRefs(references)))
     ok = gates.every((g) => g.severity !== 'critical')
     void shots
   }
   return serializeReport({
     ok,
     audit: { passed: ok, gates, ...(budget ? { budget } : {}) },
     advisories: [],
   } as never)
 }
 
-function toRefs(raw: unknown[]): Array<{ who: string | null; image: string; width: number | null; height: number | null }> {
-  return raw.map((r) => {
-    const x = r as Record<string, unknown>
-    return {
-      who: x['who'] != null ? String(x['who']) : null,
-      image: String(x['image'] ?? ''),
-      width: typeof x['width'] === 'number' ? x['width'] : null,
-      height: typeof x['height'] === 'number' ? x['height'] : null,
-    }
-  })
-}
-
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
@@ -88,25 +79,32 @@ export function registerAuditTool(_ctx: Context, _config: Config) {
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
index aba6974..f16d107 100644
--- a/plugins/prompt-master/src/tools/prompt-author.ts
+++ b/plugins/prompt-master/src/tools/prompt-author.ts
@@ -1,58 +1,62 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
 import { TARGETS, type Target } from '../pe-framework/index.js'
-import { serializeReport, buildAuditReport } from '../pe-framework/audit/index.js'
-import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
-import { compileH3 } from '../pe-framework/dialect/h3.js'
-import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
-import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
+import { serializeReport } from '../pe-framework/audit/index.js'
+import type { AnimaSlots } from '../pe-framework/dialect/anima.js'
+// 方言模块副作用注册（Task 6：DIALECT_READY 静态表 → 注册表查询）
+import '../pe-framework/dialect/anima.js'
+import '../pe-framework/dialect/h3.js'
+import { isDialectReady as registryIsDialectReady, getDialect } from '../pe-framework/dialect/registry.js'
+import { runStage } from '../pe-framework/pipeline/runStage.js'
+import { assembleEnvelope } from '../pe-framework/render/envelope.js'
+import type { StageResult } from '../pe-framework/pipeline/types.js'
 import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
 import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
-import type { AuditGate } from '../pe-framework/types.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 import { complete } from '../llm/complete.js'
 import { resolveRoute, type ExecLike } from '../llm/route.js'
 
 export interface AuthorArgs {
   target: Target
   input: string
   profile?: string
   variant?: string
   stage?: string
   scenario_id?: string
   form_fields?: Record<string, unknown>
   audit_only?: boolean
 }
 
-/** 方言归化状态机：T13 点亮 anima/h3；sd/generic 保持未归化 */
-const DIALECT_READY: Record<Target, boolean> = { anima: true, h3: true, sd: false, generic: false }
-
+/** 方言归化状态机：查注册表（anima/h3 由上方副作用 import 装配）；sd/generic 未归化 */
 export function isDialectReady(target: Target): boolean {
-  return DIALECT_READY[target] === true
+  return registryIsDialectReady(target)
 }
 
 /* ── intent 层（LLM；测试注入 seam）── */
 
 export interface AuthorDraft {
   slots?: AnimaSlots
   shots?: H3ShotsInput
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
 
@@ -93,112 +97,70 @@ function normalizeSlots(raw: Record<string, unknown>): AnimaSlots {
     if (k === 'narrative') {
       out[k] = typeof v === 'string' ? v : (Array.isArray(v) ? (v as unknown[]).map(String).join(' ') : v == null ? '' : String(v))
     } else {
       out[k] = Array.isArray(v) ? (v as unknown[]).map((x) => String(x))
         : v == null ? [] : [String(v)]
     }
   }
   return out as AnimaSlots
 }
 
-/* ── 编排（意图 → schema → dialect → audit → render + 修正闭环）── */
+/* ── 视图层（意图 → runStage 内核 → 场景表单闸门合并 → Envelope + 修正闭环）── */
 
 const VARIANT_SET = new Set(['base', 'aesthetic', 'turbo'])
+const MAX_CORRECTIONS = 2
 
-function inferH3Stage(shots: H3ShotsInput, references: unknown[], scenarioId?: string): string {
-  if (references.length > 0) return 'ref2va'
-  if (scenarioId === 'full_reference') return 'ref2va'
-  return 't2va'
+/** draft → PipelineInput 输入段：anima {slots, variant}；h3 {shots, stage, scenarioId, formFields} */
+function normalizeDraftToInput(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): { slots?: Record<string, unknown>; variant?: string; shots?: unknown; stage?: string; scenarioId?: string; formFields?: Record<string, unknown> } {
+  if (target === 'anima') {
+    if (!draft.slots || typeof draft.slots !== 'object') throw new Error('intent 未产出 slots 结构')
+    return { slots: draft.slots as unknown as Record<string, unknown>, variant: opts.variant ?? 'base' }
+  }
+  if (!draft.shots || !Array.isArray(draft.shots.shots) || draft.shots.shots.length === 0) throw new Error('intent 未产出 shots 结构')
+  return { shots: draft.shots, stage: opts.stage || undefined, scenarioId: opts.scenarioId, formFields: opts.formFields }
 }
 
-function toRefs(raw: unknown[]): Array<{ who: string | null; image: string; width: number | null; height: number | null }> {
-  return raw.map((r) => {
-    const x = r as Record<string, unknown>
-    return {
-      who: x['who'] != null ? String(x['who']) : null,
-      image: String(x['image'] ?? ''),
-      width: typeof x['width'] === 'number' ? x['width'] : null,
-      height: typeof x['height'] === 'number' ? x['height'] : null,
-    }
-  })
+/** h3 references 计数（原 L144-146 优先级：shots.references > form_fields.references） */
+function referencesCount(draft: AuthorDraft, formFields?: Record<string, unknown>): number {
+  const refs = Array.isArray(draft.shots?.references) ? draft.shots!.references : []
+  if (refs.length > 0) return refs.length
+  const formRefs = Array.isArray(formFields?.references) ? (formFields!.references as unknown[]) : []
+  return formRefs.length
 }
 
-function runDraftStage(opts: { target: string; draft: AuthorDraft; stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
-  const target = opts.target
-  if (target === 'anima') {
-    const slots = opts.draft.slots
-    if (!slots || typeof slots !== 'object') throw new Error('intent 未产出 slots 结构')
-    const variant = opts.variant ?? 'base'
-    if (!VARIANT_SET.has(variant)) throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
-    const compiled = compileAnima(slots, { variant: variant as 'base' | 'aesthetic' | 'turbo' })
-    const gates = auditAnima(compiled.positive, compiled.negative, { variant: variant as 'base' | 'aesthetic' | 'turbo', slots })
-    return {
-      ok: gates.every((g) => g.severity !== 'critical'),
-      result: { positive: compiled.positive, negative: compiled.negative },
-      gates,
-      advisories: [],
-      targetSlotHint: 't2i.prompt',
-    }
-  }
-  const shots = opts.draft.shots
-  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) throw new Error('intent 未产出 shots 结构')
-  const refs = Array.isArray(shots.references) ? shots.references : []
-  const formRefs = Array.isArray(opts.formFields?.references) ? (opts.formFields.references as unknown[]) : []
-  const references = refs.length ? refs : formRefs
-  const stage = opts.stage ?? inferH3Stage(shots, references, opts.scenarioId)
-  const extraGates: AuditGate[] = []
-  const extraAdvisories: string[] = []
-  if (opts.scenarioId) {
-    const checked = sceneToShotsChecked(opts.scenarioId, opts.formFields ?? {})
-    const unmapped = references.length > 0
-    extraGates.push(...checked.gates.filter((g) => !(g.rule === 'references_unmapped' && unmapped)))
-    extraAdvisories.push(...checked.advisories.filter((a) => !(a === 'references_unmapped' && unmapped)))
-  }
-  const { text, textZh } = compileH3(shots, { stage })
-  const gates = [
-    ...contractGatesH3(stage, shots, references), // T13 F1
-    ...extraGates,
-    ...auditH3Full(text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, references),
-  ]
-  const budget = h3BudgetToReport(buildH3Budget(stage, text, toRefs(references)))
+/**
+ * 场景表单闸门合并（原 prompt-author L150-155 语义，视图层职责——场景表单语义不是方言本质）：
+ * sceneToShotsChecked 的 extraGates/advisories 并入 stage；references 非空时抑制 references_unmapped；
+ * 合并后 ok 按全部 gates 重算（extraGates 可能引入 critical）。
+ */
+function applyScenarioGates(stage: StageResult, opts: { scenarioId?: string; formFields?: Record<string, unknown>; refsCount: number }): StageResult {
+  if (!opts.scenarioId) return stage
+  const checked = sceneToShotsChecked(opts.scenarioId, opts.formFields ?? {})
+  const unmapped = opts.refsCount > 0
+  const extraGates = checked.gates.filter((g) => !(g.rule === 'references_unmapped' && unmapped))
+  const extraAdvisories = checked.advisories.filter((a) => !(a === 'references_unmapped' && unmapped))
+  const gates = [...stage.gates, ...extraGates]
   return {
-    ok: gates.every((g) => g.severity !== 'critical'),
-    result: { text, text_zh: textZh },
+    ...stage,
     gates,
-    advisories: extraAdvisories,
-    budget,
-    targetSlotHint: 't2v.prompt',
+    advisories: [...stage.advisories, ...extraAdvisories],
+    ok: gates.every((g) => g.severity !== 'critical'),
   }
 }
 
-export interface StageResult {
-  ok: boolean
-  result: Record<string, unknown>
-  gates: AuditGate[]
-  advisories: string[]
-  budget?: { counter: 'official-tokenizer' | 'estimate'; tokens: number; max?: number; over: boolean }
-  targetSlotHint: string
-}
-
-function renderEnvelope(stage: StageResult, trailAdvisories: string[]): string {
-  const envelope: Record<string, unknown> = {
-    ok: stage.ok,
-    result: stage.result,
-    audit: { passed: stage.ok, gates: stage.gates, ...(stage.budget ? { budget: stage.budget } : {}) },
-    advisories: [...stage.advisories, ...trailAdvisories],
-    target_slot_hint: stage.targetSlotHint,
-  }
-  return serializeReport(envelope as never)
+/** draft → runStage → applyScenarioGates（author 每轮统一入口；audit 不通过不在此处理——闭环在 execute） */
+function runDraftThroughStage(target: string, draft: AuthorDraft, opts: { stage?: string; scenarioId?: string; formFields?: Record<string, unknown>; variant?: string }): StageResult {
+  const input = normalizeDraftToInput(target, draft, opts)
+  const stageResult = runStage({ target: target as Target, ...input })
+  return applyScenarioGates(stageResult, { scenarioId: opts.scenarioId, formFields: opts.formFields, refsCount: referencesCount(draft, opts.formFields) })
 }
 
-const MAX_CORRECTIONS = 2
-
 export function registerAuthorTool(ctx: Context, config: Config) {
   return defineTool({
     name: 'prompt_author',
     description:
       '统一提示词工程主入口（全链路编排）：输入创作意图 → intent（LLM 拆结构）→ schema → dialect（compileAnima/compileH3）→ audit → Envelope + target_slot_hint；audit 未过且有 Critical 时自动修正重跑（max 2 次，仍失败置 loop_exhausted）。当前归化状态：' +
       TARGETS.map((t) => `${t}=${isDialectReady(t) ? 'ready' : 'pending'}`).join(' ') +
       '；sd/generic 报 DIALECT_NOT_AVAILABLE。',
     parameters: {
       target: { type: 'string', description: '目标方言：anima | h3 | sd | generic', default: 'anima' },
       input: { type: 'string', description: '创作意图（一句话/图描述/分镜素材）' },
@@ -223,42 +185,53 @@ export function registerAuthorTool(ctx: Context, config: Config) {
             passed: false,
             gates: [{ rule: 'dialect_not_available', target, severity: 'critical', detail: `方言 ${target} 未归化（P4 范围外），请改用 anima / h3 或 prompt_compile`, source: 'tools/prompt-author' }],
           },
           advisories: [],
         } as never)
       }
       const input = String(a.input ?? '')
       if (!input.trim()) throw new Error('input 必填')
 
       const scenarioId = String(a.scenario_id ?? '').trim() || undefined
+      const runOpts = { stage: a.stage || undefined, scenarioId, formFields: a.form_fields, variant: a.variant }
 
-      // audit_only：不调 LLM，把 input 当结构 JSON
+      // anima variant 参数校验（runStage 的 compileAnima 对未知 variant 静默回退 base——契约要求显式报错）
+      if (target === 'anima' && a.variant !== undefined && !VARIANT_SET.has(a.variant)) {
+        throw new Error(`未知 variant: ${a.variant}；可选 base|aesthetic|turbo`)
+      }
+
+      // audit_only：不调 LLM，把 input 当结构 JSON（原语义：完整编译+审计，result 照常产出——不用内核 auditOnly 标志）
       if (a.audit_only === true) {
         let draft: AuthorDraft
         try {
           const parsed = JSON.parse(input) as Record<string, unknown>
           draft = target === 'anima' ? { slots: parsed as unknown as AnimaSlots } : { shots: parsed as unknown as H3ShotsInput }
         } catch {
           throw new Error('audit_only 需要结构化 JSON 输入（anima: slots；h3: shots{...}）')
         }
-        const stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
-        return renderEnvelope(stage, [])
+        const stage = runDraftThroughStage(target, draft, runOpts)
+        return assembleEnvelope(stage, [])
       }
 
       const provider = _intentProvider ?? ((req: AuthorIntentRequest, exec2?: ExecLike) => defaultIntent(ctx, resolveRoute((exec2 ?? exec) as ExecLike), req))
-      let draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: 0 }, exec)
-      let stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
+      // Task 7：intent persona/schema 方言化——从 dialect 注册表取（ANIMA_*/H3_* 常量），未注册则 undefined → provider 内 DEFAULT 兜底
+      const intentCfg = getDialect(target)?.intent
+      const intentBase = { target, input, variant: a.variant, scenarioId, formFields: a.form_fields, persona: intentCfg?.persona, schema: intentCfg?.schema }
+      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author target=${target}${a.variant ? ` variant=${a.variant}` : ''}${a.stage ? ` stage=${a.stage}` : ''}`)
+      let draft = await provider({ ...intentBase, round: 0 }, exec)
+      let stage = runDraftThroughStage(target, draft, runOpts)
       const trailAdvisories: string[] = []
       let corrections = 0
       while (!stage.ok && stage.gates.some((g) => g.severity === 'critical') && corrections < MAX_CORRECTIONS) {
         corrections++
         const feedback = stage.gates.filter((g) => g.severity === 'critical').map((g) => `[${g.rule}] ${g.detail}`).join('\n')
-        draft = await provider({ target, input, variant: a.variant, scenarioId, formFields: a.form_fields, round: corrections, feedback }, exec)
-        stage = runDraftStage({ target, draft, stage: a.stage, scenarioId, formFields: a.form_fields, variant: a.variant })
+        draft = await provider({ ...intentBase, round: corrections, feedback }, exec)
+        stage = runDraftThroughStage(target, draft, runOpts)
       }
       if (!stage.ok && stage.gates.some((g) => g.severity === 'critical')) {
         trailAdvisories.push('loop_exhausted:true')
       }
-      return renderEnvelope(stage, trailAdvisories)
+      ;(ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger?.info?.(`[prompt-master] prompt_author → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
+      return assembleEnvelope(stage, trailAdvisories)
     },
   })
-}
\ No newline at end of file
+}
diff --git a/plugins/prompt-master/src/tools/prompt-compile.ts b/plugins/prompt-master/src/tools/prompt-compile.ts
index 05eccd5..f6d542d 100644
--- a/plugins/prompt-master/src/tools/prompt-compile.ts
+++ b/plugins/prompt-master/src/tools/prompt-compile.ts
@@ -1,95 +1,56 @@
 import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
-import { compileH3 } from '../pe-framework/dialect/h3.js'
-import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js'
-import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js'
-import { serializeReport, buildAuditReport } from '../pe-framework/audit/report.js'
-import { sceneToShots, sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
-import type { H3ShotsInput, Reference } from '../pe-framework/schema/h3-shots.js'
-import { compileAnima, auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js'
-import type { AuditGate } from '../pe-framework/types.js'
+import type { Context } from '@deepseek-ai/cordis'
+// 方言模块副作用注册（Task 6：编排走 runStage 注册表，需保证 anima/h3 已装配）
+import '../pe-framework/dialect/anima.js'
+import '../pe-framework/dialect/h3.js'
+import { runStage } from '../pe-framework/pipeline/runStage.js'
+import { assembleEnvelope } from '../pe-framework/render/envelope.js'
+import type { StageResult } from '../pe-framework/pipeline/types.js'
+import { serializeReport } from '../pe-framework/audit/report.js'
+import { sceneToShotsChecked } from '../pe-framework/schema/scenes.js'
+import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js'
 
 export interface CompileArgs {
   target?: string
   shots?: H3ShotsInput
   scenario_id?: string
   form_fields?: Record<string, unknown>
   output_lang?: string
   audit_only?: boolean
   slots?: Record<string, unknown>
   variant?: string
 }
 
-export function toReferences(raw: unknown[]): Reference[] {
-  return raw.map((r) => {
-    const x = r as Record<string, unknown>
-    return {
-      who: x['who'] != null ? String(x['who']) : null,
-      image: String(x['image'] ?? ''),
-      width: typeof x['width'] === 'number' ? x['width'] : null,
-      height: typeof x['height'] === 'number' ? x['height'] : null,
-    }
-  })
+/** StageResult → Envelope（thin view 组装点）；omitResult 用于 audit_only 语义（不返回提示词正文） */
+function stageToEnvelope(stage: StageResult, opts?: { omitResult?: boolean }): string {
+  const env = JSON.parse(assembleEnvelope(stage)) as Record<string, unknown>
+  if (opts?.omitResult) delete env.result
+  return serializeReport(env as never)
 }
 
-/** stage 推断（official-capabilities 路由）：有 references → ref2va；full_reference 场景 → ref2va；否则 t2va */
-export function inferH3Stage(shots: H3ShotsInput, scenarioId?: string): 't2va' | 'ref2va' {
-  if (Array.isArray(shots.references) && shots.references.length > 0) return 'ref2va'
-  if (scenarioId === 'full_reference') return 'ref2va'
-  return 't2va'
-}
+const VARIANT_SET = ['base', 'aesthetic', 'turbo']
 
-export function compileH3Envelope(
-  input: { stage: string; shots: H3ShotsInput; references?: unknown[]; auditOnly?: boolean },
-): string {
-  const { text, textZh } = compileH3(input.shots, { stage: input.stage })
-  const shotCount = input.shots.shots.length
-  const gates = [
-    ...contractGatesH3(input.stage, input.shots, input.references ?? []), // T13 F1 前置契约闸门
-    ...auditH3Full(text, { stage: input.stage, duration: input.shots.duration_seconds, shotCount }, input.references),
-  ]
-  const budget = h3BudgetToReport(buildH3Budget(input.stage, text, toReferences(input.references ?? [])))
-  const report = buildAuditReport({ gates, budget, assumptions: [], advisories: [] })
-  const envelope: Record<string, unknown> = {
-    ok: true,
-    audit: { passed: report.passed, gates: report.gates, budget: report.budget },
-    advisories: report.advisories,
-  }
-  if (!input.auditOnly) {
-    envelope.result = { text, text_zh: textZh }
-  }
-  return serializeReport(envelope as never)
-}
-
-/** anima 分支：slots → compileAnima + auditAnima → Envelope（无 budget）。variant 未知 → 参数错误（t50 Minor 处置） */
-export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean): string {
+/** anima 分支：slots → runStage（compileAnima + auditAnima，无 budget）→ Envelope。variant 未知 → 参数错误（t50 Minor 处置）。onStage：成功前打点钩子（日志摘要，不打正文） */
+export function compileAnimaEnvelope(slots: Record<string, unknown> | undefined, variant?: string, auditOnly?: boolean, onStage?: (stage: StageResult) => void): string {
   if (!slots || typeof slots !== 'object') throw new Error('anima 分支需要 slots 输入（AnimaSlots 形状）')
-  if (variant !== undefined && !['base', 'aesthetic', 'turbo'].includes(variant)) {
+  if (variant !== undefined && !VARIANT_SET.includes(variant)) {
     throw new Error(`未知 variant: ${variant}；可选 base|aesthetic|turbo`)
   }
-  const aSlots = slots as unknown as AnimaSlots
-  const v = (variant ?? 'base') as 'base' | 'aesthetic' | 'turbo'
-  const compiled = compileAnima(aSlots, { variant: v })
-  const gates = auditAnima(compiled.positive, compiled.negative, { variant: v, slots: aSlots })
-  const report = buildAuditReport({ gates, assumptions: [], advisories: [] })
-  const envelope: Record<string, unknown> = {
-    ok: true,
-    audit: { passed: report.passed, gates: report.gates },
-    advisories: report.advisories,
-  }
-  if (!auditOnly) {
-    envelope.result = { positive: compiled.positive, negative: compiled.negative }
-  }
-  return serializeReport(envelope as never)
+  const stage = runStage({ target: 'anima', slots, variant, auditOnly: auditOnly === true })
+  onStage?.(stage)
+  return stageToEnvelope(stage, { omitResult: auditOnly === true })
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
@@ -97,51 +58,59 @@ export function registerCompileTool() {
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
-      const extraGates: AuditGate[] = []
+      const extraGates: StageResult['gates'] = []
       const extraAdvisories: string[] = []
       if (a.scenario_id) {
         scenarioId = String(a.scenario_id).trim()
         // T13 F2：references 映射 + ref2va 形态缺引用 advisory/critical
         const checked = sceneToShotsChecked(scenarioId, a.form_fields ?? {}, { lang: a.output_lang })
         shots = checked.shots
         if (!shots) throw new Error(`场景映射不可用: ${scenarioId}`)
         extraGates.push(...checked.gates)
         extraAdvisories.push(...checked.advisories)
       } else if (a.shots && Array.isArray(a.shots.shots) && (a.shots.shots as unknown[]).length > 0) {
         shots = a.shots as unknown as H3ShotsInput
       }
       if (!shots) throw new Error('需要 scenario_id 或 shots 输入')
-      const stage = inferH3Stage(shots, scenarioId)
-      const references = Array.isArray(a.form_fields?.references) ? (a.form_fields.references as unknown[]) : []
-      const envelope = JSON.parse(compileH3Envelope({ stage, shots, references, auditOnly: a.audit_only === true })) as Record<string, unknown>
+      // stage 推断在 runStage normalize 单点（references > full_reference 场景 > t2va）；references 走 formFields
+      let stage = runStage({
+        target: 'h3',
+        shots,
+        scenarioId,
+        formFields: a.form_fields,
+        auditOnly: a.audit_only === true,
+      })
       if (extraGates.length || extraAdvisories.length) {
-        const audit = envelope.audit as { passed: boolean; gates: AuditGate[] }
-        const mergedGates = [...extraGates, ...(audit.gates ?? [])]
-        envelope.audit = { passed: !mergedGates.some((g) => g.severity === 'critical'), gates: mergedGates }
-        envelope.advisories = [...(extraAdvisories), ...((envelope.advisories as string[]) ?? [])]
+        const gates = [...extraGates, ...stage.gates]
+        stage = { ...stage, gates, advisories: [...extraAdvisories, ...stage.advisories], ok: !gates.some((g) => g.severity === 'critical') }
       }
-      return serializeReport(envelope as never)
+      logInfo(`[prompt-master] prompt_compile → ok=${stage.ok} gates=${stage.gates.length} critical=${stage.gates.filter((g) => g.severity === 'critical').length} trace=${JSON.stringify(stage.trace?.stages?.map((s) => `${s.name}:${s.ms}ms`))}`)
+      return stageToEnvelope(stage, { omitResult: a.audit_only === true })
     },
   })
-}
\ No newline at end of file
+}
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
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/anima-register.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/anima-register.test.ts
new file mode 100644
index 0000000..32f927e
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/anima-register.test.ts
@@ -0,0 +1,23 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
+import { registerAnimaDialect, validateAnimaSlots } from '../../../src/pe-framework/dialect/anima.js'
+
+describe('Anima dialect registration', () => {
+  beforeEach(() => { __resetDialectsForTests(); registerAnimaDialect() })
+
+  it('registers anima with targetSlotHint t2i.prompt', () => {
+    expect(getDialect('anima')?.targetSlotHint).toBe('t2i.prompt')
+  })
+
+  it('validateAnimaSlots rejects unknown key', () => {
+    expect(validateAnimaSlots({ bogus_key: ['x'] })).toContain('bogus_key')
+  })
+
+  it('validateAnimaSlots rejects non-string-array slot', () => {
+    expect(validateAnimaSlots({ appearance: 'long hair' })).toContain('string[]')
+  })
+
+  it('validateAnimaSlots accepts valid slots', () => {
+    expect(validateAnimaSlots({ count_gender: ['1girl'], narrative: '描述' })).toBeUndefined()
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/h3-register.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/h3-register.test.ts
new file mode 100644
index 0000000..5719994
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/h3-register.test.ts
@@ -0,0 +1,27 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
+import { normalizeH3Input, registerH3Dialect } from '../../../src/pe-framework/dialect/h3.js'
+
+describe('H3 dialect registration', () => {
+  beforeEach(() => { __resetDialectsForTests(); registerH3Dialect() })
+
+  it('registers h3 with targetSlotHint t2v.prompt and auditOnlyOk', () => {
+    const d = getDialect('h3')
+    expect(d?.targetSlotHint).toBe('t2v.prompt')
+    expect(d?.auditOnlyOk).toBe(true)
+  })
+
+  it('normalizeH3Input infers ref2va when references present', () => {
+    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }], references: [{ who: 'x', image: 'p' }] } }, {})
+    expect(r.stage).toBe('ref2va')
+  })
+
+  it('normalizeH3Input infers t2va when no references', () => {
+    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }] } }, {})
+    expect(r.stage).toBe('t2va')
+  })
+
+  it('normalizeH3Input error on missing shots', () => {
+    expect(normalizeH3Input({}, {})?.error).toBeTruthy()
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts b/plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts
new file mode 100644
index 0000000..8df71c7
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/dialect/registry.test.ts
@@ -0,0 +1,28 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { registerDialect, getDialect, isDialectReady, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
+
+const base: DialectContract = {
+  id: 'anima', label: 'Anima', auditOnlyOk: true,
+  normalize: () => ({ value: {} }), compile: () => ({}), audit: () => ({ gates: [] }),
+  targetSlotHint: 't2i.prompt',
+}
+
+describe('dialect registry', () => {
+  beforeEach(() => { __resetDialectsForTests() })
+
+  it('registers and retrieves a dialect', () => {
+    registerDialect(base)
+    expect(getDialect('anima')).toBe(base)
+    expect(isDialectReady('anima')).toBe(true)
+  })
+
+  it('throws on duplicate registration (fail loud)', () => {
+    registerDialect(base)
+    expect(() => registerDialect({ ...base, label: 'dup' })).toThrow(/already registered/)
+  })
+
+  it('returns undefined for unregistered target', () => {
+    expect(getDialect('sd')).toBeUndefined()
+    expect(isDialectReady('sd')).toBe(false)
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
diff --git a/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
new file mode 100644
index 0000000..c2fd10d
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/pipeline/runStage.test.ts
@@ -0,0 +1,81 @@
+import { describe, expect, it, beforeEach } from 'vitest'
+import { registerDialect, __resetDialectsForTests, type DialectContract } from '../../../src/pe-framework/dialect/registry.js'
+import { runStage } from '../../../src/pe-framework/pipeline/runStage.js'
+import { assembleEnvelope } from '../../../src/pe-framework/render/envelope.js'
+
+const fakeDialect: DialectContract = {
+  id: 'anima', label: 'Fake', auditOnlyOk: true,
+  normalize: () => ({ value: { a: 1 } }),
+  compile: (v) => ({ positive: 'p', negative: 'n' }),
+  audit: () => ({ gates: [] }),
+  targetSlotHint: 't2i.prompt',
+}
+
+describe('runStage', () => {
+  beforeEach(() => { __resetDialectsForTests() })
+
+  it('dispatches to registered dialect and returns StageResult', () => {
+    registerDialect(fakeDialect)
+    const r = runStage({ target: 'anima' } as any)
+    expect(r.ok).toBe(true)
+    expect(r.result).toEqual({ positive: 'p', negative: 'n' })
+    expect(r.targetSlotHint).toBe('t2i.prompt')
+    expect(r.trace?.stages.length).toBeGreaterThanOrEqual(4)
+  })
+
+  it('unregistered target → failed StageResult with dialect_not_available gate (no throw)', () => {
+    const r = runStage({ target: 'sd' } as any)
+    expect(r.ok).toBe(false)
+    expect(r.gates[0].rule).toBe('dialect_not_available')
+    expect(r.gates[0].severity).toBe('critical')
+    expect(r.gates[0].target).toBe('sd')
+    expect(r.targetSlotHint).toBe('generic.prompt')
+  })
+
+  it('normalize error → throws readable error', () => {
+    registerDialect({ ...fakeDialect, normalize: () => ({ error: 'bad slots: unknown key x' }) })
+    expect(() => runStage({ target: 'anima' } as any)).toThrow(/bad slots/)
+  })
+
+  it('auditOnly=true omits result body', () => {
+    registerDialect(fakeDialect)
+    const r = runStage({ target: 'anima', auditOnly: true } as any)
+    expect(r.result).toEqual({})
+  })
+
+  it('budget present when dialect provides it', () => {
+    registerDialect({ ...fakeDialect, budget: () => ({ counter: 'estimate', tokens: 1, max: 10, over: false }) })
+    const r = runStage({ target: 'anima' } as any)
+    expect(r.budget?.counter).toBe('estimate')
+  })
+
+  it('auditOnly throws when dialect.auditOnlyOk is false', () => {
+    registerDialect({ ...fakeDialect, auditOnlyOk: false })
+    expect(() => runStage({ target: 'anima', auditOnly: true } as any)).toThrow(/auditOnly/)
+  })
+})
+
+describe('assembleEnvelope', () => {
+  it('emits P1 envelope with ok/result/audit/advisories/target_slot_hint', () => {
+    const s = JSON.parse(assembleEnvelope(
+      { ok: true, result: { x: 1 }, gates: [], advisories: ['a'], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
+      ['trail'],
+    ))
+    expect(s.ok).toBe(true)
+    expect(s.result).toEqual({ x: 1 })
+    expect(s.audit.passed).toBe(true)
+    // Task 4 定案：audit 收敛为 {passed, gates, budget?}——assumptions/advisories 不再入 audit 对象
+    expect(Object.keys(s.audit).sort()).toEqual(['gates', 'passed'])
+    expect(s.target_slot_hint).toBe('t2i.prompt')
+    expect(s.advisories).toEqual(['a', 'trail'])
+  })
+
+  it('omits result when ok=false (audit_only semantics)', () => {
+    const s = JSON.parse(assembleEnvelope(
+      { ok: false, result: {}, gates: [{ rule: 'x', target: 'anima', severity: 'critical', detail: 'd' }], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
+    ))
+    expect(s.ok).toBe(false)
+    expect(s.result).toBeUndefined()
+    expect(s.audit.passed).toBe(false)
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/resources/manifest.test.ts b/plugins/prompt-master/tests/pe-framework/resources/manifest.test.ts
new file mode 100644
index 0000000..b92dd0b
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/resources/manifest.test.ts
@@ -0,0 +1,101 @@
+import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { createHash } from 'node:crypto'
+import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
+import { assertAnimaCatalog, assertH3Tokenizer } from '../../../src/pe-framework/resources/manifest.js'
+
+let tmp: string
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex')
+}
+
+function writeAnimaFixture(opts: { checksum?: string; omitChecksum?: boolean; omitManifest?: boolean; catalogContent?: string }): void {
+  const knowledge = join(tmp, 'skills', 'anima-prompt-v1', 'knowledge')
+  mkdirSync(knowledge, { recursive: true })
+  writeFileSync(join(knowledge, 'tag-catalog.sqlite'), opts.catalogContent ?? 'fake-catalog-bytes')
+  if (!opts.omitManifest) {
+    const manifest: Record<string, unknown> = { content_filters: false, output: { path: 'tag-catalog.sqlite' } }
+    if (!opts.omitChecksum) {
+      ;(manifest.output as Record<string, unknown>).checksum = opts.checksum ?? sha256(join(knowledge, 'tag-catalog.sqlite'))
+    }
+    writeFileSync(join(knowledge, 'manifest.json'), JSON.stringify(manifest))
+  }
+}
+
+function writeH3Fixture(opts: { snapshotId?: string; withTokenizer?: boolean; omitManifest?: boolean }): void {
+  const knowledge = join(tmp, 'skills', 'minimax-h3-prompt', 'knowledge')
+  mkdirSync(knowledge, { recursive: true })
+  if (!opts.omitManifest) {
+    writeFileSync(
+      join(knowledge, 'manifest.json'),
+      JSON.stringify({ schema_version: 1, snapshot_id: opts.snapshotId ?? 'h3-qwen3-vl' }),
+    )
+  }
+  if (opts.withTokenizer !== false) writeFileSync(join(knowledge, 'tokenizer.json'), '{}')
+}
+
+describe('asset manifest verification', () => {
+  beforeEach(() => {
+    tmp = mkdtempSync(join(tmpdir(), 'pm-manifest-'))
+    setPresetRoot(tmp)
+  })
+  afterEach(() => {
+    setPresetRoot(undefined)
+    rmSync(tmp, { recursive: true, force: true })
+  })
+
+  it('anima: manifest checksum matches actual file → ok', () => {
+    writeAnimaFixture({})
+    expect(assertAnimaCatalog()).toEqual({ ok: true })
+  })
+
+  it('anima: checksum mismatch → ok:false with mismatch reason', () => {
+    writeAnimaFixture({ checksum: 'deadbeef'.repeat(8), catalogContent: 'different-bytes' })
+    const r = assertAnimaCatalog()
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.reason).toContain('mismatch')
+  })
+
+  it('anima: manifest missing → ok:false with unreadable reason', () => {
+    writeAnimaFixture({ omitManifest: true })
+    const r = assertAnimaCatalog()
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.reason).toContain('unreadable')
+  })
+
+  it('anima: manifest without checksum field → ok:false', () => {
+    writeAnimaFixture({ omitChecksum: true })
+    const r = assertAnimaCatalog()
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.reason).toContain('checksum')
+  })
+
+  it('h3: correct snapshot_id + tokenizer.json present → ok', () => {
+    writeH3Fixture({})
+    expect(assertH3Tokenizer()).toEqual({ ok: true })
+  })
+
+  it('h3: wrong snapshot_id → ok:false with mismatch reason', () => {
+    writeH3Fixture({ snapshotId: 'wrong-snapshot' })
+    const r = assertH3Tokenizer()
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.reason).toContain('mismatch')
+  })
+
+  it('h3: tokenizer.json missing → ok:false', () => {
+    writeH3Fixture({ withTokenizer: false })
+    const r = assertH3Tokenizer()
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.reason).toContain('mismatch')
+  })
+
+  it('h3: manifest missing → ok:false with unreadable reason', () => {
+    writeH3Fixture({ omitManifest: true })
+    const r = assertH3Tokenizer()
+    expect(r.ok).toBe(false)
+    if (!r.ok) expect(r.reason).toContain('unreadable')
+  })
+})
diff --git a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
index 1102080..6450f47 100644
--- a/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
+++ b/plugins/prompt-master/tests/pe-framework/resources/resolve.test.ts
@@ -1,12 +1,12 @@
 // tests/pe-framework/resources/resolve.test.ts
-import { describe, expect, it, beforeEach, afterEach } from 'vitest'
+import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
 import { join, sep } from 'node:path'
 import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
 
 describe('resolveKnowledgePath', () => {
   beforeEach(() => setPresetRoot('C:/fake-preset'))
   afterEach(() => setPresetRoot(undefined))
 
   it('joins presetRoot + skillDir + knowledge + asset', () => {
     expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
       .toBe('C:\\fake-preset\\skills\\anima-prompt-v1\\knowledge\\tag-catalog.sqlite')
@@ -33,11 +33,21 @@ describe('resolveKnowledgePath', () => {
     if (!threw) {
       expect(result).toBeDefined()
       const suffix = join('skills', 'x', 'knowledge', 'y')
       expect(result!.endsWith(suffix)).toBe(true)
       // fallback 解析出的根应为非空绝对路径（本 checkout 下即 preset 根目录）
       const root = result!.slice(0, result!.length - suffix.length).replace(/[\\/]+$/, '')
       expect(root.length).toBeGreaterThan(0)
       expect(sep === '\\' ? /^[A-Za-z]:[\\/]/.test(root) : root.startsWith('/')).toBe(true)
     }
   })
+
+  it('uses DSH_COMFYUI_PRESET_ROOT env when no explicit presetRoot is set', () => {
+    setPresetRoot(undefined)
+    vi.stubEnv('DSH_COMFYUI_PRESET_ROOT', 'C:/env-root')
+    try {
+      expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe(join('C:/env-root', 'skills', 'x', 'knowledge', 'y.json'))
+    } finally {
+      vi.unstubAllEnvs()
+    }
+  })
 })
diff --git a/plugins/prompt-master/tests/plugin/compile-h3.test.ts b/plugins/prompt-master/tests/plugin/compile-h3.test.ts
index 86281c2..516b70e 100644
--- a/plugins/prompt-master/tests/plugin/compile-h3.test.ts
+++ b/plugins/prompt-master/tests/plugin/compile-h3.test.ts
@@ -1,61 +1,76 @@
 import { describe, expect, it } from 'vitest'
-import { registerCompileTool, compileH3Envelope, inferH3Stage } from '../../src/tools/prompt-compile.js'
+import { registerCompileTool } from '../../src/tools/prompt-compile.js'
 import { stubCtx, runTool } from './helpers.js'
 
 const def = () => registerCompileTool()
+const run = async (args: Record<string, unknown>) => JSON.parse(String(await runTool(stubCtx(), def(), args)))
 
 describe('prompt_compile (target=h3)', () => {
   it('scenario_id=full_reference maps to shots (with references) and compiles six-section text', async () => {
-    const ctx = stubCtx()
-    const raw = JSON.parse(String(await runTool(ctx, def(), {
+    const raw = await run({
       target: 'h3',
       scenario_id: 'full_reference',
       form_fields: {
         subject: 'bai fa jian ke', scene: 'xue shan', duration_seconds: '10', ambient: 'feng xue', music: 'gu zheng',
         references: [{ kind: 'picture', who: 'Sword', image: 'snow.png', width: 1024, height: 1024 }], // T13 F2 refs mapping
       },
-    })))
+    })
     expect(raw.ok).toBe(true) // refs mapped → no references_unmapped critical
     const text: string = raw.result.text
     expect(text.length).toBeGreaterThan(0)
   })
 
   it('direct shots input compiles deterministically', async () => {
-    const raw = JSON.parse(compileH3Envelope({ stage: 't2va', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } }))
+    const raw = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
     expect(raw.ok).toBe(true)
     expect(raw.result.text).toContain('integrated_multimodal_description: [Shot 1]')
   })
 
   it('ref2va → auditH3Full label gates run with references (F2)', async () => {
-    const raw = JSON.parse(compileH3Envelope({
+    const raw = await run({
+      target: 'h3',
       stage: 'ref2va',
       shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }], references: [{ kind: 'picture', who: 'A', image: 'a.png' }] as never },
-    }))
+    })
     expect(raw.result.text).toContain('subject_definitions:')
   })
 
   it('F1 contract gate: ref2va with 2 references rejected as critical ref_count', async () => {
-    const raw = JSON.parse(compileH3Envelope({
+    const raw = await run({
+      target: 'h3',
       stage: 'ref2va',
       shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }] },
-      references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }],
-    }))
-    expect(raw.audit.passed).toBe(false) // ok=编译成功；审计闸门经 audit.passed 表达
+      form_fields: { references: [{ who: 'A', image: 'a.png' }, { who: 'B', image: 'b.png' }] },
+    })
+    expect(raw.audit.passed).toBe(false) // 审计闸门经 audit.passed 表达
     expect(raw.audit.gates.some((g: any) => g.rule === 'ref_count' && g.severity === 'critical')).toBe(true)
   })
 
   it('budget counter is official-tokenizer (T12 switch)', async () => {
-    const v = compileH3Envelope({ stage: 't2va', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
-    expect(JSON.parse(v).audit.budget.counter).toBe('official-tokenizer')
+    const raw = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
+    expect(raw.audit.budget.counter).toBe('official-tokenizer')
   })
 
   it('unknown target errors with DIALECT_NOT_AVAILABLE', async () => {
     await expect(runTool(stubCtx(), def(), { target: 'sd', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } } as any)).rejects.toThrow(/DIALECT_NOT_AVAILABLE/)
   })
 
-  it('stage inference: references → ref2va, else t2va, full_reference → ref2va', () => {
-    expect(inferH3Stage({ duration_seconds: 8, shots: [{ what: 'x' }], references: [{ who: 'A', image: 'a.png' }] as never })).toBe('ref2va')
-    expect(inferH3Stage({ duration_seconds: 6, shots: [{ what: 'x' }] })).toBe('t2va')
-    expect(inferH3Stage({ duration_seconds: 8, shots: [{ what: 'x' }] }, 'full_reference')).toBe('ref2va')
+  it('stage inference via tool: references → ref2va, else t2va, full_reference scenario → ref2va', async () => {
+    // stage 推断收敛进 runStage normalize 单点（Task 6）；此处经工具入口做行为等价断言
+    const withRefs = await run({
+      target: 'h3',
+      shots: { duration_seconds: 8, shots: [{ what: 'x', who: 'A' }], references: [{ kind: 'picture', who: 'A', image: 'a.png' }] as never },
+    })
+    expect(withRefs.result.text).toContain('subject_definitions:') // ref2va
+    const noRefs = await run({ target: 'h3', shots: { duration_seconds: 6, shots: [{ what: 'x' }] } })
+    expect(noRefs.result.text).toContain('integrated_multimodal_description:') // t2va
+    const fullRef = await run({
+      target: 'h3', scenario_id: 'full_reference',
+      form_fields: {
+        subject: 'bai fa jian ke', scene: 'xue shan', duration_seconds: '10', ambient: 'feng xue', music: 'gu zheng',
+        references: [{ kind: 'picture', who: 'Sword', image: 'snow.png', width: 1024, height: 1024 }],
+      },
+    })
+    expect(fullRef.result.text).toContain('subject_definitions:') // ref2va
   })
-})
\ No newline at end of file
+})
diff --git a/plugins/prompt-master/tests/plugin/h3-dialect.test.ts b/plugins/prompt-master/tests/plugin/h3-dialect.test.ts
index 038af5d..e816c51 100644
--- a/plugins/prompt-master/tests/plugin/h3-dialect.test.ts
+++ b/plugins/prompt-master/tests/plugin/h3-dialect.test.ts
@@ -80,21 +80,21 @@ describe('h3 dialect golden double-run (dialect.py port)', () => {
     { name: 'ref2va-neko', stage: 'ref2va' },
     { name: 'ref2va-mei-three-refs', stage: 'ref2va' },
   ]
 
   for (const { name, stage } of CASES) {
     it(`${name}: compileH3 text/text_zh byte-exact against golden`, () => {
       const golden = readGolden(name) as any
       const input = golden.input
       const compiled = compileH3(input, { stage })
       assertGolden(
-        { result: { text: compiled.text, text_zh: compiled.textZh } },
+        { result: { text: compiled.text, text_zh: compiled.text_zh } },
         name,
         ['result.text', 'result.text_zh'],
       )
     })
   }
 
   it('fl2va-multishot: official validation failure reproduced (no refs under fl2va)', () => {
     const golden = readGolden('fl2va-multishot') as any
     const input = golden.input
     let threw: Error | undefined
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
