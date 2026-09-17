# Review package — Task 2 (base 207d263..e46ae2c)

## Commits
```e46ae2c feat(prompt-master): replace hardcoded knowledge paths + asset manifest verification
```n
## Stat
``` .../src/pe-framework/audit/tokenizer-h3.ts         |  20 +++-
 .../src/pe-framework/dialect/anima-catalog.ts      |  26 ++++--
 .../src/pe-framework/resources/manifest.ts         |  36 ++++++++
 .../tests/pe-framework/resources/manifest.test.ts  | 101 +++++++++++++++++++++
 4 files changed, 173 insertions(+), 10 deletions(-)
```n
## Full diff (-U10, src+tests)
```diff
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
```
