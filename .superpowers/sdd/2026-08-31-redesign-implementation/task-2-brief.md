# Task 2 Brief: 替换硬编码路径 + 资产 manifest 对账

## 背景
prompt-master DSH 插件重构（方案 A）第 2 个任务。Task 1 已建立 `resolveKnowledgePath`（src/pe-framework/resources/resolve.ts）。本任务：(a) 把两处硬编码 `C:/Users/11245/...` 路径替换为该解析入口；(b) 新增资产 manifest 对账（catalog checksum / tokenizer snapshot），校验失败不硬崩。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 全局约束
- 测试：`Push-Location <插件根>; npx vitest run <file>`；全量 `npx vitest run`；构建 `npm run build`
- git 根 = `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`；commit 用 `git -C <根> add <相对路径>`
- 资源路径禁止硬编码 `C:/Users/...`（src 下 Select-String 检查必须 0 matches）
- **保留测试注入点**：`setCatalogPath`/`ANIMA_CATALOG_PATH`（anima-catalog 现有）、`tokenizerSourceDir` 选项（buildH3Budget options，现有——不要动它的签名）
- TypeScript ESM (NodeNext)，import 带 `.js` 后缀
- 纯函数库代码不打 console.log（manifest 校验的 warn 见下——资源层允许 console.warn 兜底，spec §4.2 定案：资源层无 ctx.logger，用 console.warn）

## Files
- Modify: `src/pe-framework/dialect/anima-catalog.ts`（L25-26 默认路径 + L157 目录返回 + 接入 manifest 校验）
- Modify: `src/pe-framework/audit/tokenizer-h3.ts`（L17 DEFAULT_SOURCE_DIR + 接入 manifest 校验）
- Create: `src/pe-framework/resources/manifest.ts`
- Test: `tests/pe-framework/resources/manifest.test.ts`（新增）
- 现有回归：`tests/plugin/budget-tokenizer.test.ts`、`tests/fidelity/harness.test.ts`、`tests/fidelity/*-golden.test.ts`、`tests/plugin/tokenizer.test.ts`、`tests/plugin/anima-catalog.test.ts` 必须继续全绿

## Consumes（Task 1 接口）
```ts
// src/pe-framework/resources/resolve.ts
export function resolveKnowledgePath(opts: { skillDir: string; asset: string }): string
// 返回 <presetRoot>/skills/<skillDir>/knowledge/<asset>
```

## Step A: 改 anima-catalog.ts

现状（先 read 该文件核实行号）：
```ts
const DEFAULT_CATALOG_PATH = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge/tag-catalog.sqlite'  // L25
const OVERLAY_PATH = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/anima-prompt-v1/knowledge/relation-overlay.sqlite'    // L26
let _dbPath = process.env.ANIMA_CATALOG_PATH ?? DEFAULT_CATALOG_PATH
// L157 附近：return join('C:/Users/11245/.../knowledge')  ← 目录用途
```

改为：
```ts
import { resolveKnowledgePath } from '../resources/resolve.js'
import { dirname } from 'node:path'

const defaultCatalogPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' })
const defaultOverlayPath = () => resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'relation-overlay.sqlite' })

let _dbPath = process.env.ANIMA_CATALOG_PATH ?? defaultCatalogPath()
```
- 查 OVERLAY_PATH 的所有使用点，改用 `defaultOverlayPath()`（惰性调用，保持 ANIMA_OVERLAY_PATH env 覆盖语义如果现在有——read 核实）。
- L157 的目录返回改 `dirname(defaultCatalogPath())` 或等价（read 该函数确认用途）。
- 保留 `setCatalogPath` / `catalogPath()` 现有 API 不变。
- **manifest 校验接线**：在 `db()` 函数首次打开前调用 `assertAnimaCatalog()`（Step C 实现）；校验失败时 `console.warn('[prompt-master] ' + reason + '：资产与 golden 基线不同，请 re-run fidelity capture')` 并继续打开（不硬崩）。用模块级 flag 保证只 warn 一次。

## Step B: 改 tokenizer-h3.ts

现状 L17：
```ts
const DEFAULT_SOURCE_DIR = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/skills/minimax-h3-prompt/knowledge'
```
改为：
```ts
import { resolveKnowledgePath } from '../resources/resolve.js'
import { dirname } from 'node:path'
const defaultTokenizerSourceDir = () => dirname(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' }))
```
所有使用 DEFAULT_SOURCE_DIR 的地方改 `defaultTokenizerSourceDir()`（注意：`tokenizerSourceDir` 函数参数 override 优先级必须保持——read 核实现有优先级链：显式参数 > DEFAULT_SOURCE_DIR，改后为 显式参数 > defaultTokenizerSourceDir()）。
**manifest 校验接线**：tokenizer 首次加载前调 `assertH3Tokenizer()`；失败 → console.warn 同上（tokenizer 已有加载失败 → estimate 回退语义，校验 warn 不改变该语义）。

## Step C: 实现 src/pe-framework/resources/manifest.ts

```ts
import { createHash, readFileSync } from 'node:fs'
import { resolveKnowledgePath } from './resolve.js'

export type AssetCheck = { ok: true } | { ok: false; reason: string }

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** anima catalog：manifest.json 的 output checksum（或顶层 checksum）vs tag-catalog.sqlite 实算 */
export function assertAnimaCatalog(): AssetCheck {
  try {
    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'manifest.json' }), 'utf8')) as any
    const expected: string | undefined = m?.output?.checksum ?? m?.checksum
    const actual = sha256File(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
    if (!expected) return { ok: false, reason: 'catalog manifest has no checksum field' }
    return expected === actual ? { ok: true } : { ok: false, reason: `catalog checksum mismatch (manifest=${expected} actual=${actual})` }
  } catch (e) {
    return { ok: false, reason: `catalog manifest unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** h3 tokenizer：manifest.json snapshot_id === 'h3-qwen3-vl' 且 tokenizer.json 可解析路径存在 */
export function assertH3Tokenizer(): AssetCheck {
  try {
    const tokPath = resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'tokenizer.json' })
    const m = JSON.parse(readFileSync(resolveKnowledgePath({ skillDir: 'minimax-h3-prompt', asset: 'manifest.json' }), 'utf8')) as any
    const okId = m?.snapshot_id === 'h3-qwen3-vl'
    const tokExists = existsSyncCompat(tokPath)
    return okId && tokExists ? { ok: true } : { ok: false, reason: `tokenizer manifest mismatch (snapshot_id=${m?.snapshot_id ?? 'missing'}, tokenizer_exists=${tokExists})` }
  } catch (e) {
    return { ok: false, reason: `tokenizer manifest unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
}
```
> `existsSyncCompat` = 从 node:fs import `existsSync`。真实 anima manifest 的字段形态先 read `C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\skills\anima-prompt-v1\knowledge\manifest.json` 核实（可能是 `output.checksum` 或别的嵌套）——按实际字段调整读取路径，保持 API 不变。同核实 `skills\minimax-h3-prompt\knowledge\manifest.json` 的 `snapshot_id`。**重要**：实算 783 MiB catalog 的 sha256 很慢（秒级）——`assertAnimaCatalog` 若被 fidelity 测试频繁触发会拖慢测试。处理：manifest 校验函数本身保持纯净（每次调用实算），但 anima-catalog.ts 的接线处用模块级 flag 只执行一次。fidelity golden 测试里已直接用 golden sha256 断言（不经 assert 函数），不受影响。

## Step D: 测试 tests/pe-framework/resources/manifest.test.ts

用临时目录 fixture 测两分支（不要读真实 783MiB 库）：
```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setPresetRoot } from '../../../src/pe-framework/resources/resolve.js'
import { assertAnimaCatalog, assertH3Tokenizer } from '../../../src/pe-framework/resources/manifest.js'

// helper: 搭 <tmp>/skills/anima-prompt-v1/knowledge/{manifest.json, tag-catalog.sqlite}
// manifest.json 的 checksum 用真实文件 sha256（createHash 算 tmp 文件）
```
用例（至少 4 个）：
1. anima：manifest checksum 与实文件一致 → `{ok:true}`
2. anima：checksum 不匹配 → `{ok:false, reason 含 'mismatch'}`
3. anima：manifest 缺失 → `{ok:false, reason 含 'unreadable'}`
4. h3：snapshot_id 正确 + tokenizer.json 存在 → `{ok:true}`；snapshot_id 错 → `{ok:false, reason 含 'mismatch'}`
afterEach 清理 tmp 目录 + setPresetRoot(undefined)。

## Step E: 验证 + 回归 + 提交

1. `npx vitest run tests/pe-framework/resources/manifest.test.ts` → PASS
2. `npx vitest run tests/plugin/budget-tokenizer.test.ts tests/plugin/tokenizer.test.ts tests/plugin/anima-catalog.test.ts` → 全绿（注入点未破坏）
3. `npx vitest run`（全量）→ 全绿（~274+）
4. `npm run build` → exit 0
5. `Select-String -Path src -Pattern "C:/Users/11245" -Recurse`（在插件根）→ 0 matches
6. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework plugins/prompt-master/tests/pe-framework
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): replace hardcoded knowledge paths + asset manifest verification"
```

## 验收
- src 下无 `C:/Users/11245` 硬编码
- manifest.test.ts ≥4 用例绿
- 全量测试绿（注入点 setCatalogPath/ANIMA_CATALOG_PATH/tokenizerSourceDir 全保留）
- assertAnimaCatalog/assertH3Tokenizer 接线（惰性单次 warn）
