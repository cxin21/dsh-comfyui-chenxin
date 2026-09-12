# 风格预设库 v2 + 美学分析 + NSFW 三档 实现计划（M1 机制全量 + 55 条迁移）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 的 M1——统一风格预设 schema/registry/applyStyleV2 并迁移 55 条既有预设、NSFW 三档 rating + 硬边界闸门、4 条确定性美学 gates + 卡推荐器、5 处 LLM 提示词改动、prompt_author 编排 v2（intent 恒跑）、style_list 工具。

**Architecture:** 全部新逻辑为 pe-framework 内确定性纯函数模块（styles/ safety/ aesthetics/），以数据表驱动（策略表/边界词表/预设 JSON），LLM 只在既有 ①intent→②enrich→③judge 编排中做质量放大；管线插入点全部在 prompt_author 的既有分支缝隙。

**Tech Stack:** TypeScript (tsc → dist，ESM)、vitest、node:sqlite（feedback store 既有）、JSON 数据文件（assets/style-presets/）。

**Spec:** `docs/specs/2026-09-12-style-aesthetics-nsfw-design.md`（计划从 spec 论证；执行者两份都读）

## Global Constraints

- 基线：`npx vitest run` 831 passed / 1 skipped / 0 failed，任何任务完成时不得回退。
- 类型：`npx tsc --noEmit` 必须干净。
- **铁律**：任何 `src/**` 改动的任务，提交前必须 `npm run build`（dist 不入 git 但必须本机同步）。
- 提交：单意图提交，message 带 spec 章节（如 `spec §5`）；`git add` 只加本任务文件（+ 测试）。
- Rating 序：`safe < sensitive < explicit`；类型定义在 `src/pe-framework/types.ts`（与 AuditGate 同处）。
- 硬边界词表是确定性数据：闸门判定不得引入任何 LLM 调用。
- 工作目录：所有命令在 `plugins/prompt-master/` 下执行。
- 禁止：改 `skills/**`、改 camera asset、引入新 npm 依赖。
- 迁移数据质量门：fragments 无空泛词（VAGUE_WORDS = cinematic/beautiful/大气/电影感）、光影词过 LIGHTING_BAN、`negative_hints.length ≥ 1`。

---

### Task 1: StylePresetV2 类型 + 确定性校验器

**Files:**
- Modify: `src/pe-framework/types.ts`（追加 `Rating`）
- Create: `src/pe-framework/styles/schema.ts`
- Test: `tests/pe-framework/styles/schema.test.ts`

**Interfaces:**
- Produces: `type Rating = 'safe' | 'sensitive' | 'explicit'`（types.ts）；`const RATING_ORDER: readonly Rating[]`；`interface StylePresetV2`（字段见 spec §4.1）；`function validateStylePreset(v: unknown): { ok: true; value: StylePresetV2 } | { ok: false; errors: string[] }`；`type StyleCategory`（十类联合）。后续所有任务从这里 import。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/styles/schema.test.ts
import { describe, expect, it } from 'vitest'
import { validateStylePreset, RATING_ORDER } from '../../../src/pe-framework/styles/schema.js'
import type { Rating } from '../../../src/pe-framework/types.js'

const valid = {
  id: 'nb01_x', name: '测试', category: 'anime', rating: 'safe',
  fragments: { image: 'cel shading, flat colors', video: 'cel shading, flat colors' },
  negative_hints: ['impasto'], artist_hints: ['rella'], artist_max: 3,
  applies_to: ['anima', 'h3', 'sd'], source: 'newbie-migrated',
}

describe('validateStylePreset', () => {
  it('accepts a valid preset', () => {
    const r = validateStylePreset(valid)
    expect(r.ok).toBe(true)
  })
  it('rejects missing required fields with field-path errors', () => {
    const r = validateStylePreset({ ...valid, category: undefined, fragments: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('category'))).toBe(true)
      expect(r.errors.some((e) => e.includes('fragments'))).toBe(true)
    }
  })
  it('rejects bad rating enum and empty fragments channels', () => {
    expect(validateStylePreset({ ...valid, rating: 'r18' }).ok).toBe(false)
    expect(validateStylePreset({ ...valid, fragments: { image: '', video: 'x' } }).ok).toBe(false)
  })
  it('rejects empty negative_hints and non-positive artist_max', () => {
    expect(validateStylePreset({ ...valid, negative_hints: [] }).ok).toBe(false)
    expect(validateStylePreset({ ...valid, artist_max: 0 }).ok).toBe(false)
  })
  it('nsfw presets must apply to anima only', () => {
    expect(validateStylePreset({ ...valid, rating: 'explicit' }).ok).toBe(false)
    expect(validateStylePreset({ ...valid, rating: 'explicit', applies_to: ['anima'] }).ok).toBe(true)
    expect(validateStylePreset({ ...valid, rating: 'sensitive', applies_to: ['anima'] }).ok).toBe(true)
  })
  it('rejects unknown category', () => {
    expect(validateStylePreset({ ...valid, category: 'wuxia' }).ok).toBe(false)
  })
  it('rating order is safe<sensitive<explicit', () => {
    expect(RATING_ORDER).toEqual<Rating[]>(['safe', 'sensitive', 'explicit'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/styles/schema.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/pe-framework/types.ts` 追加：

```ts
/** spec §5：内容分级档位（序：safe < sensitive < explicit） */
export type Rating = 'safe' | 'sensitive' | 'explicit'
export const RATING_ORDER: readonly Rating[] = ['safe', 'sensitive', 'explicit']
```

`src/pe-framework/styles/schema.ts`：

```ts
/** 风格预设 v2 schema（spec §4.1）——纯类型 + 确定性校验器 */
import type { Rating } from '../types.js'

export type StyleCategory =
  | 'photography' | 'anime' | 'illustration' | 'cg_3d' | 'oriental'
  | 'dark_supernatural' | 'scifi_fantasy' | 'retro' | 'graphic' | 'glamour_intimate'

const CATEGORIES: readonly StyleCategory[] = [
  'photography', 'anime', 'illustration', 'cg_3d', 'oriental',
  'dark_supernatural', 'scifi_fantasy', 'retro', 'graphic', 'glamour_intimate',
]
const RATINGS: readonly Rating[] = ['safe', 'sensitive', 'explicit']

export interface StylePresetV2 {
  id: string
  name: string
  category: StyleCategory
  rating: Rating
  base?: string
  theme?: string
  palette?: string
  fragments: { image: string; video: string }
  negative_hints: string[]
  artist_hints: string[]
  artist_max: number
  applies_to: ('anima' | 'h3' | 'sd')[]
  art_direction_hints?: Partial<Record<'perspective' | 'composition' | 'lighting' | 'color' | 'motion', string>>
  source: string
}

function isNonEmptyString(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0 }
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null }

export function validateStylePreset(v: unknown): { ok: true; value: StylePresetV2 } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ['preset must be an object'] }
  if (!isNonEmptyString(v['id'])) errors.push('id must be a non-empty string')
  if (!isNonEmptyString(v['name'])) errors.push('name must be a non-empty string')
  if (!CATEGORIES.includes(v['category'] as StyleCategory)) errors.push(`category must be one of ${CATEGORIES.join('|')}`)
  if (!RATINGS.includes(v['rating'] as Rating)) errors.push('rating must be safe|sensitive|explicit')
  const frag = v['fragments']
  if (!isRecord(frag) || !isNonEmptyString(frag['image']) || !isNonEmptyString(frag['video'])) {
    errors.push('fragments.image/fragments.video must be non-empty strings')
  }
  if (!Array.isArray(v['negative_hints']) || v['negative_hints'].length < 1) errors.push('negative_hints must be a non-empty array')
  if (!Array.isArray(v['artist_hints'])) errors.push('artist_hints must be an array')
  const am = v['artist_max']
  if (typeof am !== 'number' || !Number.isFinite(am) || am < 1) errors.push('artist_max must be a number >= 1')
  if (!Array.isArray(v['applies_to']) || v['applies_to'].length < 1) errors.push('applies_to must be a non-empty array')
  if (!isNonEmptyString(v['source'])) errors.push('source must be a non-empty string')
  if (errors.length > 0) return { ok: false, errors }
  // spec §4.1：nsfw 预设只能 anima
  if ((v['rating'] === 'sensitive' || v['rating'] === 'explicit')) {
    const ap = v['applies_to'] as unknown[]
    if (ap.length !== 1 || ap[0] !== 'anima') errors.push('sensitive/explicit presets must apply to ["anima"] only')
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: v as unknown as StylePresetV2 }
}
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/styles/schema.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/types.ts src/pe-framework/styles/schema.ts tests/pe-framework/styles/schema.test.ts
git commit -m "feat(styles): StylePresetV2 schema + deterministic validator (spec §4.1)"
```

---

### Task 2: builtin 11 条迁移 → JSON（golden 锁定与 TS 零漂移）

**Files:**
- Create: `assets/style-presets/cinematic_real.json`、`game_cg.json`、`cel_shading.json`、`thick_paint.json`、`cyberpunk.json`、`wafuu.json`、`wasteland.json`、`dark_epic.json`、`watercolor.json`、`concept_art.json`、`fairy_tale.json`
- Test: `tests/pe-framework/styles/builtin-migration.test.ts`

**Interfaces:**
- Consumes: Task 1 `validateStylePreset`；既有 `MINIMAL_STYLES`（enrichment/style.ts）。
- Produces: 11 个 v2 JSON，`source: 'builtin-migrated'`，`rating: 'safe'`，`artist_max: 3`，`applies_to: ['anima','h3','sd']`。Task 4 registry 消费。

- [ ] **Step 1: 写失败测试（与 TS 常量逐字段比对，防手工转写漂移）**

```ts
// tests/pe-framework/styles/builtin-migration.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { MINIMAL_STYLES } from '../../../src/pe-framework/enrichment/style.js'
import { validateStylePreset } from '../../../src/pe-framework/styles/schema.js'

const dir = resolve(fileURLToPath(import.meta.url), '../../../../assets/style-presets')

describe('builtin migration (spec §4.4/§10)', () => {
  const byId = new Map(MINIMAL_STYLES.map((s) => [s.id, s]))
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('nb'))

  it('has one JSON per builtin style', () => {
    expect(files.length).toBe(MINIMAL_STYLES.length)
    for (const f of files) expect(byId.has(f.replace('.json', '')), f).toBe(true)
  })

  it('each builtin JSON validates and matches its TS source 1:1', () => {
    for (const f of files) {
      const raw = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      const r = validateStylePreset(raw)
      expect(r.ok, `${f}: ${r.ok ? '' : r.errors.join(';')}`).toBe(true)
      if (!r.ok) continue
      const src = byId.get(raw.id)!
      expect(raw.name).toBe(src.name)
      expect(raw.base ?? undefined).toBe(src.base ?? undefined)
      expect(raw.theme ?? undefined).toBe(src.theme ?? undefined)
      expect(raw.palette ?? undefined).toBe(src.palette ?? undefined)
      expect(raw.fragments.image).toBe(src.prompt_fragments.image)
      expect(raw.fragments.video).toBe(src.prompt_fragments.video)
      expect(raw.negative_hints).toEqual(src.negative_hints)
      expect(raw.artist_hints).toEqual(src.artistHints)
      expect(raw.rating).toBe('safe')
      expect(raw.applies_to).toEqual(src.applies_to)
      expect(raw.source).toBe('builtin-migrated')
      expect(raw.artist_max).toBe(3)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/styles/builtin-migration.test.ts`
Expected: FAIL（JSON 不存在）

- [ ] **Step 3: 转写 11 个 JSON**

样板（cinematic_real.json，其余 10 个按同构从 `enrichment/style.ts` 逐字段转写，category 按 spec §4.4 归属表：game_cg→cg_3d、cel_shading→anime、thick_paint/watercolor/concept_art/fairy_tale→illustration、cyberpunk/wasteland→scifi_fantasy、wafuu→oriental、dark_epic→dark_supernatural、cinematic_real→photography）：

```json
{
  "id": "cinematic_real",
  "name": "写实电影",
  "category": "photography",
  "rating": "safe",
  "base": "photorealistic",
  "palette": "teal and orange grading",
  "fragments": {
    "image": "IMAX film grain, anamorphic lens flare, teal and orange grading, golden hour ambience, shallow depth of field",
    "video": "IMAX film grain, anamorphic lens flare, teal and orange grading, golden hour ambience, shallow depth of field"
  },
  "negative_hints": ["amateur photography", "over-sharpened"],
  "artist_hints": ["guweiz", "wlop", "ask (askzy)"],
  "artist_max": 3,
  "applies_to": ["anima", "h3", "sd"],
  "source": "builtin-migrated"
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/styles/builtin-migration.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add assets/style-presets/*.json tests/pe-framework/styles/builtin-migration.test.ts
git commit -m "feat(styles): migrate 11 builtin styles to v2 JSON, golden-locked to TS source (spec §10)"
```

---

### Task 3: nb 44 条迁移 → v2（authoring + 质量门测试）

**Files:**
- Modify: `assets/style-presets/nb*.json`（44 个，原地转 v2 schema）
- Test: `tests/pe-framework/styles/nb-migration.test.ts`

**Interfaces:**
- Consumes: Task 1 validator。
- Produces: 44 个 v2 预设；`source: 'newbie-migrated'`、`rating: 'safe'`（保留）、`id`/`name`/`artists→artist_hints`/`artist_max` 直传、`applies_to: ['anima','h3','sd']`。

**映射规则（style_tags 全表，实现为迁移常量并测试覆盖）：**

| style_tags 值 | base | theme |
|---|---|---|
| `anime_style` | `anime style` | — |
| `realistic_shading` | — | `realistic shading` |
| 二者并存 | `anime style` | `realistic shading` |
| 其他取值（迁移时逐文件确认） | — | 取 tag 原文 |

**fragments/negative_hints authoring 规则**：从 `style_tags` + 中文名语义派生 2-4 个具体名词短语（image 与 video 同文）；negative_hints ≥1 条与该画风相斥的具体名词（如 realistic_shading ↔ `flat colors`、anime_style ↔ `photorealistic render`）。golden 样板（nb01）：

```json
{
  "id": "nb01_2024顶级画师混搭_rella_wlop",
  "name": "2024顶级画师混搭 (Rella & WLOP)",
  "category": "anime",
  "rating": "safe",
  "base": "anime style",
  "theme": "realistic shading",
  "fragments": {
    "image": "clean lineart, realistic shading, detailed eyes, contemporary anime palette",
    "video": "clean lineart, realistic shading, detailed eyes, contemporary anime palette"
  },
  "negative_hints": ["photorealistic render", "flat colors"],
  "artist_hints": ["rella", "tidsean", "wlop", "ciloranko", "atdan"],
  "artist_max": 3,
  "applies_to": ["anima", "h3", "sd"],
  "source": "newbie-migrated"
}
```

（category 归属按 spec §4.4 迁移表；style_tags 只有一个值时另一个字段缺省。）

- [ ] **Step 1: 写失败测试（质量门）**

```ts
// tests/pe-framework/styles/nb-migration.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { validateStylePreset } from '../../../src/pe-framework/styles/schema.js'

const dir = resolve(fileURLToPath(import.meta.url), '../../../../assets/style-presets')
const nbFiles = readdirSync(dir).filter((f) => f.startsWith('nb') && f.endsWith('.json'))
const VAGUE = ['cinematic', 'beautiful', '大气', '电影感']

describe('nb migration (spec §10)', () => {
  it('migrates all 44 nb presets to valid v2', () => {
    expect(nbFiles.length).toBe(44)
    for (const f of nbFiles) {
      const r = validateStylePreset(JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
      expect(r.ok, `${f}: ${r.ok ? '' : r.errors.join(';')}`).toBe(true)
    }
  })
  it('ids unique across nb set; rating preserved as safe', () => {
    const ids = nbFiles.map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')).id)
    expect(new Set(ids).size).toBe(44)
    for (const f of nbFiles) expect(JSON.parse(readFileSync(resolve(dir, f), 'utf8')).rating).toBe('safe')
  })
  it('quality gates: no vague words, non-empty fragments/negatives, bare artists within artist_max', () => {
    for (const f of nbFiles) {
      const p = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      for (const ch of ['image', 'video'] as const) {
        const low = p.fragments[ch].toLowerCase()
        for (const w of VAGUE) expect(low.includes(w), `${f} vague:${w}`).toBe(false)
      }
      expect(p.negative_hints.length).toBeGreaterThanOrEqual(1)
      for (const a of p.artist_hints) expect(a.startsWith('@'), `${f} artist ${a}`).toBe(false)
      expect(p.artist_hints.length).toBeLessThanOrEqual(p.artist_max + 2) // 候选可多于注入上限，截断在 apply 层
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/styles/nb-migration.test.ts`
Expected: FAIL（44 个还是 v1 结构）

- [ ] **Step 3: 逐文件迁移 44 个 JSON**

按映射规则 + nb01 样板执行。先跑 `Get-ChildItem assets/style-presets -Filter nb*.json | ForEach-Object { Get-Content $_ | ConvertFrom-Json | Select-Object id, artists, artist_max, style_tags } | Format-Table` 拿全量字段清单，再批量转写（可写一次性 Node 脚本生成骨架后手工校对 fragments/negative_hints——脚本产物也必须过 Step 1 的质量门）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/styles/nb-migration.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add assets/style-presets/nb*.json tests/pe-framework/styles/nb-migration.test.ts
git commit -m "feat(styles): migrate 44 NewBie presets to v2 schema with quality gates (spec §10)"
```

---

### Task 4: registry（目录加载/去重/索引/过滤/查询）

**Files:**
- Create: `src/pe-framework/styles/registry.ts`
- Test: `tests/pe-framework/styles/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 validator；assets 目录定位**复用 `src/pe-framework/resources/resolve.ts` 的根路径解析机制**（先读该文件，跟随其模式取 `assets/style-presets/`，禁止硬编码相对路径猜层级）。
- Produces:
  - `loadStylePresets(): { presets: StylePresetV2[]; advisories: string[] }`（重复 id 加 `-2` 后缀 + advisory `style_preset_id_conflict:<id>`；非法文件 throw，不静默丢弃）
  - `getStylePreset(id: string): StylePresetV2 | undefined`
  - `listStylePresets(filter?: { category?: StyleCategory; maxRating?: Rating; appliesTo?: 'anima'|'h3'|'sd'; query?: string }): StylePresetV2[]`（maxRating 语义：`preset.rating ≤ maxRating`，序 safe<sensitive<explicit；query 匹配 id/name 子串）
  - `stylePresetCount(): number`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/styles/registry.test.ts
import { describe, expect, it } from 'vitest'
import { loadStylePresets, getStylePreset, listStylePresets, stylePresetCount } from '../../../src/pe-framework/styles/registry.js'

describe('style registry (spec §4.2)', () => {
  const loaded = loadStylePresets()

  it('loads 55 presets with no conflicts', () => {
    expect(loaded.advisories).toEqual([])
    expect(stylePresetCount()).toBe(55)
  })
  it('get by id returns preset; unknown returns undefined', () => {
    expect(getStylePreset('cinematic_real')?.category).toBe('photography')
    expect(getStylePreset('nb01_2024顶级画师混搭_rella_wlop')?.source).toBe('newbie-migrated')
    expect(getStylePreset('nope')).toBeUndefined()
  })
  it('rating filter: safe session never sees sensitive/explicit presets', () => {
    const safe = listStylePresets({ maxRating: 'safe' })
    expect(safe.every((p) => p.rating === 'safe')).toBe(true)
  })
  it('category + applies_to + query filters compose', () => {
    expect(listStylePresets({ category: 'anime' }).every((p) => p.category === 'anime')).toBe(true)
    expect(listStylePresets({ appliesTo: 'h3' }).every((p) => p.applies_to.includes('h3'))).toBe(true)
    expect(listStylePresets({ query: 'rella' }).length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/styles/registry.test.ts` → FAIL

- [ ] **Step 3: 实现 registry**（按 Interfaces 契约；目录扫描用 `readdirSync` + `readFileSync` + `JSON.parse`；重复 id 处理：第二个及以后重命名为 `${id}-N` 并 push advisory；模块内缓存 load 结果）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/styles/registry.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/styles/registry.ts tests/pe-framework/styles/registry.test.ts
git commit -m "feat(styles): preset registry with dedupe/rating-filter/query (spec §4.2)"
```

---

### Task 5: applyStyleV2（negative/artist_max 接线）+ 兼容 shim

**Files:**
- Create: `src/pe-framework/styles/apply.ts`
- Modify: `src/pe-framework/enrichment/style.ts`（改为从 apply.ts re-export 的兼容 shim；`MINIMAL_STYLES` 标记 `@deprecated`，指向 registry）
- Modify: `src/pe-framework/enrichment/engine.ts:169`（`applyStyle` 改从 registry 查询 + 未知 id advisory）
- Test: `tests/pe-framework/styles/apply.test.ts`

**Interfaces:**
- Consumes: Task 4 registry；Task 1 类型。
- Produces: `applyStyle(bp: BlueprintV1, styleId: string, conformity: number): BlueprintV2 行为同旧签名`——语义变化三处（spec §4.3）：① `negative_hints` 以 `{ target: hint, severity: 'soft' }` 并入 `core.negative`（与既有 target 大小写不敏感去重）；② `artist_hints` 经 `slice(0, artist_max)` 截断后写入 `core.style.artist_hints`；③ 未知 styleId 仍返回原对象（engine 层补 advisory `style_preset_unknown:<id>`）。conformity 三档语义逐字节不变。

- [ ] **Step 1: 写失败测试**（把 `tests/pe-framework/enrichment/style.test.ts` 的 applyStyle/conformity 用例整体复制到新文件并改 import 为 `styles/apply.js`，另加三个新用例）

```ts
// 追加用例
it('wires negative_hints into core.negative as soft constraints, dedup case-insensitive', () => {
  const withDup: BlueprintV1 = { ...bp, core: { ...bp.core, negative: [{ target: 'Amateur Photography', severity: 'soft' }] } }
  const out = applyStyle(withDup, 'cinematic_real', 1)
  const targets = (out.core.negative ?? []).map((n) => n.target)
  expect(targets.filter((t) => t.toLowerCase() === 'amateur photography')).toHaveLength(1)
  expect(targets).toContain('over-sharpened')
})
it('caps artist_hints at preset artist_max', () => {
  const out = applyStyle(bp, 'nb01_2024顶级画师混搭_rella_wlop', 1)
  expect(out.core.style?.artist_hints).toHaveLength(3) // artist_max=3, 候选 5
})
it('conformity >= 1 keeps reference-only semantics (no fragment injection)', () => {
  const out = applyStyle(bp, 'cinematic_real', 1)
  expect(out.media_layer.video?.shots[0]?.action ?? '').not.toContain('IMAX')
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/styles/apply.test.ts tests/pe-framework/enrichment/style.test.ts` → 新用例 FAIL、旧用例 PASS（shim 未建前旧文件仍指向旧实现）

- [ ] **Step 3: 实现**：把 `enrichment/style.ts` 的 `applyStyle`/`proportionalFragment` 移入 `styles/apply.ts`（改查 registry），旧文件改为 `export { applyStyle } from '../styles/apply.js'` + deprecated `MINIMAL_STYLES = loadStylePresets().presets.filter(p => p.source === 'builtin-migrated')` 形状的兼容导出；`engine.ts:169` 前补 `if (opts.styleId && !getStylePreset(opts.styleId)) expansions.push('style_preset_unknown:' + opts.styleId)`。

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/styles tests/pe-framework/enrichment && npx tsc --noEmit` → 全 PASS（旧 style.test.ts 经 shim 也必须 PASS）

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/styles/apply.ts src/pe-framework/enrichment/style.ts src/pe-framework/enrichment/engine.ts tests/pe-framework/styles/apply.test.ts
git commit -m "feat(styles): applyStyleV2 wires negative_hints + artist_max, registry-backed (spec §4.3)"
```

---

### Task 6: safety/rating.ts（定档 + 策略表）

**Files:**
- Create: `src/pe-framework/safety/rating.ts`
- Test: `tests/pe-framework/safety/rating.test.ts`

**Interfaces:**
- Consumes: `Rating`（types.ts）。
- Produces:
  - `const EXPLICIT_MARKERS: readonly string[]`（自 `dialect/anima.ts` `EXPLICIT_SAFETY_MARKERS` **平移**，anima.ts 改为从这里 import 以保兼容）
  - `const SENSITIVE_MARKERS: readonly string[] = ['swimsuit','bikini','lingerie','underwear','cleavage','seductive','泳装','内衣','性感','撩人']`
  - `resolveRating(input: Rating | undefined, corpus: string): { rating: Rating; escalatedFrom?: Rating; source: 'input' | 'keyword' }`（显式输入优先；双命中取高）
  - `RATING_SEEDS: Record<Rating, readonly string[]>` = `{ safe:['safe'], sensitive:['rating_sensitive'], explicit:['rating_explicit'] }`
  - `RATING_NEGATIVE_ADDITIONS: Record<Rating, readonly string[]>` = `{ safe:[], sensitive:['nude','nudity','genitals','rating_explicit'], explicit:['child','loli','shota','toddler','kid','preteen'] }`
  - `resolveEffectiveRating(slots: { rating?: Rating; explicit?: boolean; /* 其余槽位 */ }): Rating`（slots.rating 优先 → explicit 布尔映射 → 关键词扫描 → safe；供方言层用）

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/safety/rating.test.ts
import { describe, expect, it } from 'vitest'
import { resolveRating, resolveEffectiveRating, RATING_SEEDS, RATING_NEGATIVE_ADDITIONS } from '../../../src/pe-framework/safety/rating.js'

describe('resolveRating (spec §5.2)', () => {
  it('explicit input wins over keywords', () => {
    expect(resolveRating('safe', 'nude girls')).toEqual({ rating: 'safe', source: 'input' })
  })
  it('keyword escalation to explicit and sensitive', () => {
    expect(resolveRating(undefined, 'she is nude')?.rating).toBe('explicit')
    expect(resolveRating(undefined, 'bikini at the beach')?.rating).toBe('sensitive')
    expect(resolveRating(undefined, 'nude bikini')?.rating).toBe('explicit') // 双命中取高
  })
  it('no signal stays safe without escalation', () => {
    expect(resolveRating(undefined, 'a knight on a hill')).toEqual({ rating: 'safe', source: 'keyword' })
  })
  it('policy tables are complete per rating', () => {
    expect(RATING_SEEDS.safe).toEqual(['safe'])
    expect(RATING_SEEDS.explicit).toEqual(['rating_explicit'])
    expect(RATING_NEGATIVE_ADDITIONS.sensitive).toContain('rating_explicit')
    expect(RATING_NEGATIVE_ADDITIONS.explicit).toContain('loli')
    expect(RATING_NEGATIVE_ADDITIONS.safe).toEqual([])
  })
  it('slots mapping: rating field > explicit bool > keywords', () => {
    expect(resolveEffectiveRating({ rating: 'sensitive', explicit: true })).toBe('sensitive')
    expect(resolveEffectiveRating({ explicit: true })).toBe('explicit')
    expect(resolveEffectiveRating({ detail_mood: ['nude'] })).toBe('explicit')
    expect(resolveEffectiveRating({})).toBe('safe')
  })
})
```

（`resolveEffectiveRating` 入参用 `AnimaSlots` 类型。）

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/safety/rating.test.ts` → FAIL

- [ ] **Step 3: 实现**；`dialect/anima.ts` 的 `EXPLICIT_SAFETY_MARKERS` 常量改为 `export { EXPLICIT_MARKERS as EXPLICIT_SAFETY_MARKERS } from '../safety/rating.js'` 的再导出（原位引用不断）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/safety && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/safety/rating.ts src/pe-framework/dialect/anima.ts tests/pe-framework/safety/rating.test.ts
git commit -m "feat(safety): rating resolution + per-tier policy tables (spec §5.1-5.3)"
```

---

### Task 7: safety/boundaries.ts（硬边界闸门）

**Files:**
- Create: `src/pe-framework/safety/boundaries.ts`
- Test: `tests/pe-framework/safety/boundaries.test.ts`

**Interfaces:**
- Produces:
  - `interface BoundaryViolation { gate: 'minor_content_conflict' | 'nonconsensual_content_rejected' | 'bestiality_content_rejected'; matched: string }`
  - `checkBoundaries(corpus: string, rating: Rating): BoundaryViolation[]`
  - 词表常量：`MINOR_MARKERS`（loli/shota/child/children/toddler/kid/preteen/幼女/萝莉/正太/小学生/儿童/小孩/婴儿/infant/baby；**明确不含** flat_chest、petite 等成人身材词）、`NONCONSENT_MARKERS`（rape/raping/forced sex/non-consensual/nonconsensual/强奸/非自愿/强迫性行为）、`BESTIALITY_MARKERS`（bestiality/zoophilia/兽奸/人兽）
  - 语义：minor gate 仅 `rating !== 'safe'` 时触发；nonconsensual/bestiality 任何档触发；匹配大小写不敏感。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/safety/boundaries.test.ts
import { describe, expect, it } from 'vitest'
import { checkBoundaries } from '../../../src/pe-framework/safety/boundaries.js'

describe('hard boundaries (spec §5.4)', () => {
  it('minor × sensitive/explicit is rejected', () => {
    expect(checkBoundaries('1girl, loli, explicit pose', 'explicit')[0]?.gate).toBe('minor_content_conflict')
    expect(checkBoundaries('小学生 制服', 'sensitive')[0]?.gate).toBe('minor_content_conflict')
  })
  it('minor × safe passes (drawing children is legitimate at safe tier)', () => {
    expect(checkBoundaries('1boy, child, playing soccer', 'safe')).toEqual([])
  })
  it('adult body trait words are NOT minor markers', () => {
    expect(checkBoundaries('1girl, flat_chest, petite, nude', 'explicit')).toEqual([])
  })
  it('nonconsensual rejected at every tier', () => {
    for (const r of ['safe', 'sensitive', 'explicit'] as const) {
      expect(checkBoundaries('rape scene', r)[0]?.gate).toBe('nonconsensual_content_rejected')
    }
  })
  it('bestiality rejected', () => {
    expect(checkBoundaries('bestiality', 'explicit')[0]?.gate).toBe('bestiality_content_rejected')
  })
  it('clean corpus passes at every tier', () => {
    expect(checkBoundaries('masterpiece, 1girl, dress, garden', 'explicit')).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/safety/boundaries.test.ts` → FAIL

- [ ] **Step 3: 实现**（纯函数；corpus `toLowerCase()` 后 `includes` 匹配，CJK 直接 includes）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/safety/boundaries.test.ts && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/safety/boundaries.ts tests/pe-framework/safety/boundaries.test.ts
git commit -m "feat(safety): deterministic hard-boundary gates, tier-crossed matching (spec §5.4)"
```

---

### Task 8: anima 方言接入 rating（种子/负向/终检）

**Files:**
- Modify: `src/pe-framework/dialect/anima.ts`（AnimaSlots +rating；装配 3b；policy 负向追加；inspectAnima 终检）
- Test: `tests/pe-framework/dialect/anima-rating.test.ts`

**Interfaces:**
- Consumes: Task 6 `resolveEffectiveRating`/`RATING_SEEDS`/`RATING_NEGATIVE_ADDITIONS`；Task 7 `checkBoundaries`。
- Produces:
  - `AnimaSlots.rating?: Rating`（`explicit?: boolean` 保留，语义映射）
  - 装配 3b 替换：`const eff = resolveEffectiveRating(slots)`；`for (const t of RATING_SEEDS[eff]) pushSeg(t, 'positive', 'policy', 99)`；`eff !== 'safe'` 时 `assumptions.push('rating_active:' + eff)`；原 `safety_seed_injected:...` assumption 移除
  - policy 负向（3a 之后、unconditional，不受 qualityPrefix 门控）：`for (const t of RATING_NEGATIVE_ADDITIONS[eff]) pushSeg(t, 'negative', 'policy', 98)`
  - `inspectAnima` 末尾：`for (const v of checkBoundaries(positive + ' ' + negative, eff))` 追加同形 gate（id = v.gate），并保证 phase_status.inspection = 'ADVISORY' 语义不被降级（blocker 级 gate 让调用方按既有 critical 通道处理）

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/dialect/anima-rating.test.ts
import { describe, expect, it } from 'vitest'
import { compileAnima } from '../../../src/pe-framework/dialect/anima.js'

const slots = (extra: Record<string, unknown>) => ({
  count_gender: ['1girl'], detail_mood: ['white dress'], ...extra,
}) as Parameters<typeof compileAnima>[0]

describe('rating integration (spec §5.3)', () => {
  it('safe: seed "safe", no additions, assumption present', () => {
    const r = compileAnima(slots({}), { variant: 'base' })
    expect(r.positive).toContain('safe,')
    expect(r.negative).not.toContain('rating_explicit')
  })
  it('sensitive: rating_sensitive seed + explicit blockers in negative', () => {
    const r = compileAnima(slots({ rating: 'sensitive' }), { variant: 'base' })
    expect(r.positive).toContain('rating_sensitive')
    expect(r.positive).not.toContain(' safe,')
    expect(r.negative).toContain('nude')
    expect(r.assumptions).toContain('rating_active:sensitive')
  })
  it('explicit bool alias maps to explicit tier; qualityPrefix=false still adds negative additions', () => {
    const r = compileAnima(slots({ explicit: true, qualityPrefix: false }), { variant: 'base' })
    expect(r.positive).toContain('rating_explicit')
    expect(r.negative).toContain('loli')
  })
  it('terminal boundary gate fires on compiled corpus', () => {
    const r = compileAnima(slots({ rating: 'explicit', appearance: ['loli'] }), { variant: 'base' })
    expect(r.phase_status.inspection).toBe('ADVISORY')
    // gate 断言：inspectAnima 输出中存在 id=minor_content_conflict 的 gate（经 compile 内部 inspect 通道）
  })
})
```

（最后一个用例若 compileAnima 不直接暴露 gates，则改为直接调 `inspectAnima(r.positive, r.negative, { rating: 'explicit' })` 断言 `gates.some(g => g.id === 'minor_content_conflict')`——以现有 inspect 通道实际形状为准，跟随相邻 gate 用例写法。）

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/dialect/anima-rating.test.ts` → FAIL

- [ ] **Step 3: 实现三处改动**（见 Interfaces）。**同任务内**：grep `tests/` 中 `safety_seed_injected` 字面量并更新为新 assumption 口径（预期只影响少量既有断言）。

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/dialect && npx tsc --noEmit` → PASS（含既有 dialect 测试全绿）

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/dialect/anima.ts tests/pe-framework/dialect/anima-rating.test.ts
git commit -m "feat(anima): three-tier rating seeds/negatives + terminal boundary gate (spec §5.3)"
```

---

### Task 9: 美学 gates（确定性审计层）

**Files:**
- Create: `src/pe-framework/aesthetics/audit.ts`
- Modify: `src/pe-framework/dialect/anima.ts`（inspectAnima 追加 4 条 advisory gate）
- Test: `tests/pe-framework/aesthetics/audit.test.ts`

**Interfaces:**
- Produces:
  - `interface AestheticGate { id: 'aesthetic_composition_missing' | 'aesthetic_lighting_missing' | 'aesthetic_palette_missing' | 'aesthetic_focal_missing'; cardField: 'composition'|'lighting'|'color'|'perspective'; cardIds: string[] }`
  - `detectAestheticGates(positive: string): AestheticGate[]`
  - 判定词表（小写 includes）：composition ← `['rule of thirds','negative space','leading lines','golden ratio','symmetry','diagonal composition','framed composition','silhouette','off-center']`；lighting ← `['golden hour','chiaroscuro','dramatic shadows','soft diffused','dappled','cool blue tones','warm amber','high contrast lighting','long shadows','luminous outline']`（全部为 LIGHTING_BAN 合规写法）；palette ← `['palette','tones','monochrome','pastel','saturated','desaturated','teal','sepia','color scheme']`；focal ← `['close-up','closeup','portrait','depth of field','focal','upper body','cowboy shot','full body','wide shot']`
  - inspectAnima 末尾追加：`detectAestheticGates(positive).map(g => 同形 advisory gate, id = g.id)`

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/aesthetics/audit.test.ts
import { describe, expect, it } from 'vitest'
import { detectAestheticGates } from '../../../src/pe-framework/aesthetics/audit.js'

describe('aesthetic gates (spec §6.1)', () => {
  it('bare prompt triggers all four gates with card hints', () => {
    const gates = detectAestheticGates('masterpiece, best quality, score_7, 1girl, white dress')
    expect(gates.map((g) => g.id)).toEqual(expect.arrayContaining([
      'aesthetic_composition_missing', 'aesthetic_lighting_missing', 'aesthetic_palette_missing', 'aesthetic_focal_missing',
    ]))
    for (const g of gates) expect(g.cardIds.length).toBeGreaterThan(0)
  })
  it('fully anchored prompt triggers none', () => {
    const p = 'masterpiece, 1girl, rule of thirds, golden hour long shadows, warm amber tones, close-up, shallow depth of field'
    expect(detectAestheticGates(p)).toEqual([])
  })
  it('card tags themselves never trigger gates (ban-safe vocabulary)', () => {
    const p = 'cinematic lighting, dramatic shadows, rule of thirds, limited palette, close-up'
    expect(detectAestheticGates(p)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/aesthetics/audit.test.ts` → FAIL

- [ ] **Step 3: 实现** + inspectAnima 追加（advisory 级：不影响 phase_status 的 PASS，仅进 gates 列表——跟随相邻 advisory gate 的既有写法）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/aesthetics tests/pe-framework/dialect && npx tsc --noEmit` → PASS（既有 dialect 测试若断言 gates 数量需同步修正）

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/aesthetics/audit.ts src/pe-framework/dialect/anima.ts tests/pe-framework/aesthetics/audit.test.ts
git commit -m "feat(aesthetics): 4 deterministic gates with art-direction repair hints (spec §6.1)"
```

---

### Task 10: 艺术指导卡推荐器

**Files:**
- Create: `src/pe-framework/aesthetics/recommend.ts`
- Test: `tests/pe-framework/aesthetics/recommend.test.ts`

**Interfaces:**
- Consumes: `ALL_ART_DIRECTION`（enrich/art-direction.ts）。
- Produces:
  - `interface RecommendSignals { media: 'image'|'video'|'mixed'; hasMotionIntent: boolean; hasLighting: boolean; hasComposition: boolean; hasFocal: boolean; presetHints?: Partial<Record<ArtDirectionField, string>> }`
  - `recommendArtDirection(s: RecommendSignals): { field: ArtDirectionField; cardId: string; reason: string }[]`
  - 规则（每类至多 1，顺序即优先级）：①`hasMotionIntent || media!=='image'` → motion（cardId 取 `dynamic_pose`；presetHints.motion 优先）；②`!hasLighting` → lighting（presetHints.lighting 优先，否则 `cinematic_lighting`）；③`!hasComposition` → composition（`rule_of_thirds`）；④`!hasFocal` → perspective（`close_up`）。presetHints 中的字段视为已满足（不再推荐该类）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/aesthetics/recommend.test.ts
import { describe, expect, it } from 'vitest'
import { recommendArtDirection } from '../../../src/pe-framework/aesthetics/recommend.js'

describe('card recommender (spec §6.2)', () => {
  it('video intent recommends motion first', () => {
    const r = recommendArtDirection({ media: 'video', hasMotionIntent: false, hasLighting: true, hasComposition: true, hasFocal: true })
    expect(r[0]?.field).toBe('motion')
    expect(r[0]?.cardId).toBe('dynamic_pose')
  })
  it('missing dimensions each yield one card; hints suppress their field', () => {
    const r = recommendArtDirection({ media: 'image', hasMotionIntent: false, hasLighting: false, hasComposition: false, hasFocal: false, presetHints: { lighting: 'golden_hour' } })
    const fields = r.map((x) => x.field)
    expect(fields).toContain('lighting'); expect(fields).toContain('composition'); expect(fields).toContain('perspective')
    expect(r.find((x) => x.field === 'lighting')?.cardId).toBe('golden_hour')
  })
  it('satisfied signals yield no recommendations', () => {
    expect(recommendArtDirection({ media: 'image', hasMotionIntent: true, hasLighting: true, hasComposition: true, hasFocal: true })).toEqual([])
  })
  it('every recommended cardId exists in its field deck', () => {
    const r = recommendArtDirection({ media: 'video', hasMotionIntent: true, hasLighting: false, hasComposition: false, hasFocal: false })
    for (const x of r) expect(x.cardId.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/aesthetics/recommend.test.ts` → FAIL

- [ ] **Step 3: 实现**（纯规则函数；isKnownCardId 校验 presetHints 合法性，非法 hint 忽略并记 reason 'invalid_hint_ignored'）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/aesthetics && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/aesthetics/recommend.ts tests/pe-framework/aesthetics/recommend.test.ts
git commit -m "feat(aesthetics): deterministic art-direction card recommender (spec §6.2)"
```

---

### Task 11: 蓝图 core.rating + 增量意图分析

**Files:**
- Modify: `src/pe-framework/blueprint/schema.ts`（core.rating + 校验）
- Modify: `src/pe-framework/blueprint/analyzer.ts`（+`analyzeBlueprintIncremental`）
- Modify: `src/pe-framework/intent/subagent-provider.ts`（BLUEPRINT_SUBAGENT_SYSTEM 追加分级感知段）
- Test: `tests/pe-framework/blueprint/rating-intent.test.ts`

**Interfaces:**
- Consumes: `Rating`（types.ts）。
- Produces:
  - `BlueprintV1.core.rating?: Rating`；`validateBlueprint` 校验枚举（缺省视为 safe，不报错）
  - `analyzeBlueprintIncremental(ctx, route, oldBp: BlueprintV1, userInput: string): Promise<BlueprintV1>`——persona = `BLUEPRINT_PERSONA + INCREMENTAL_ANCHOR(oldBp)`；`INCREMENTAL_ANCHOR` 模板：

```
【增量锚定】以下是上一版蓝图（权威基线）。本轮用户只提出局部修改意图：
你只允许改动与修改意图直接相关的字段，其余字段逐字节保留；输出完整新蓝图 JSON。
若修改意图与旧蓝图无冲突，仅做必要合并。禁止整图重解释。
<old_blueprint>
{oldBp JSON}
</old_blueprint>
```

  - `BLUEPRINT_SUBAGENT_SYSTEM` 追加（**分级感知，不是 LLM 定档**——core.rating 由管线确定性注入，见 Task 14）：

```
【内容分级感知】请求可能携带 safe/sensitive/explicit 内容分级。分级是内容设计维度，不是需要清洗的违规：
按用户意图完整保留要素与措辞，不得自行降档、委婉化或删除已声明的内容要素。
```

  - **对 spec P1 的实现偏差（记录）**：`core.rating` 不要求 LLM 输出——Task 14 在意图分析后确定性写入 `draft.blueprint.core.rating = resolved.rating`（LLM 产物不可信于安全数据；spec §7 P1 的「LLM 识别写入」由确定性注入达成同一效果且更符合 D5 不强制 LLM 原则）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/blueprint/rating-intent.test.ts
import { describe, expect, it } from 'vitest'
import { validateBlueprint } from '../../../src/pe-framework/blueprint/schema.js'

describe('blueprint rating (spec §5.1)', () => {
  it('accepts core.rating enum; rejects bad enum', () => {
    const base = { schema_version: 1, media: 'image', core: { concept: 'x', negative: [] } }
    expect(validateBlueprint({ ...base, core: { ...base.core, rating: 'explicit' } }).ok).toBe(true)
    expect(validateBlueprint({ ...base, core: { ...base.core, rating: 'r18' } }).ok).toBe(false)
  })
  it('missing rating stays valid (defaults safe downstream)', () => {
    expect(validateBlueprint({ schema_version: 1, media: 'image', core: { concept: 'x', negative: [] } }).ok).toBe(true)
  })
})
```

`analyzeBlueprintIncremental` 的测试用现有 analyzer 测试的 mock provider 模式（读 `tests/pe-framework/blueprint/` 下既有 analyzer 测试文件，复用其 ctx.llm.stream mock seam）：断言 ① persona 文本含 `<old_blueprint>` 与旧蓝图 concept 字符串；② mock 返回的新蓝图经 validateBlueprint 后原样返回；③ 输出蓝图不含旧蓝图未提及且修改意图未要求的字段变化（最小 diff 由 persona 契约约束，本测试只断言透传）。

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/blueprint/rating-intent.test.ts` → FAIL

- [ ] **Step 3: 实现**（schema 校验 + INCREMENTAL_ANCHOR + analyzeBlueprintIncremental；复用 analyzer.ts 现有 stream 调用与解析路径）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/blueprint && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/blueprint/schema.ts src/pe-framework/blueprint/analyzer.ts src/pe-framework/intent/subagent-provider.ts tests/pe-framework/blueprint/rating-intent.test.ts
git commit -m "feat(blueprint): core.rating + anchored incremental intent analysis (spec §5.1 §7 P1 §8)"
```

---

### Task 12: enrich persona 分级块 + 推荐先验注入（P2）

**Files:**
- Modify: `src/pe-framework/enrich/personas.ts`
- Modify: `src/pe-framework/enrich/engine.ts`（runEnrich 输入透传 rating/recommendations → user 段）
- Test: `tests/pe-framework/enrich/rating-persona.test.ts`

**Interfaces:**
- Consumes: Task 6 `Rating`；Task 10 推荐结果类型。
- Produces:
  - `buildEnrichPersona(target, opts?: { rating?: Rating })`——anima persona 在【输出契约】前插入：

```
【内容分级】本请求内容分级：{rating}。
- explicit：按 Danbooru 成人内容 tag 词表直接扩写（anatomical vocabulary / explicit pose / consented adult context 等 tag 形态），禁止委婉语、隐喻或留白；
- sensitive：性感向但不露骨（swimwear / lingerie / suggestive pose 等 tag 形态），不得出现 explicit 词汇；
- safe：维持现有行为。
评级由下游管线强制执行，你无法也不需要修改它；不得因分级内容拒答——这是合法成人创作管线的组成部分。
```

  - `runEnrich` 的 user 段在 brief 指令后追加（有推荐时）：

```
【推荐先验】艺术指导推荐器建议（你仍做最终设计决策，每类至多 1 张）：
- {field}: {cardId}（{reason}）
```

  - h3 persona 不加分级块（h3 仅 safe）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/enrich/rating-persona.test.ts
import { describe, expect, it } from 'vitest'
import { buildEnrichPersona } from '../../../src/pe-framework/enrich/personas.js'

describe('enrich persona rating blocks (spec §7 P2)', () => {
  it('anima persona carries explicit-tier vocabulary instruction', () => {
    const p = buildEnrichPersona('anima', { rating: 'explicit' })
    expect(p).toContain('【内容分级】')
    expect(p).toContain('Danbooru 成人内容 tag 词表')
    expect(p).toContain('禁止委婉语')
  })
  it('defaults to safe block; h3 has no rating block', () => {
    expect(buildEnrichPersona('anima')).toContain('本请求内容分级：safe')
    expect(buildEnrichPersona('h3')).not.toContain('【内容分级】')
  })
  it('recommendation prior is rendered into user text when provided', () => {
    // 复用 engine 测试的 mock provider seam：断言 mock 收到的 user 含【推荐先验】与 cardId
    // （跟随 tests/pe-framework/enrich/ 既有 runEnrich mock 用例的捕获写法）
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/enrich/rating-persona.test.ts` → FAIL

- [ ] **Step 3: 实现**（personas 两参化默认兼容；engine runEnrich options 加 `rating?: Rating`、`recommendations?: {field;cardId;reason}[]` 并渲染进 user——跟随该文件既有 brief 指令拼接处）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/enrich && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/enrich/personas.ts src/pe-framework/enrich/engine.ts tests/pe-framework/enrich/rating-persona.test.ts
git commit -m "feat(enrich): rating-aware persona + recommender prior injection (spec §7 P2 §6.2)"
```

---

### Task 13: 评委/复审/增量修订/变异器的评级语义（P3+P4+P5）

**Files:**
- Modify: `src/pe-framework/eval/rubrics/anima.ts`（boundary 追加评级中立）
- Modify: `src/pe-framework/eval/critic.ts`（buildPersona/buildRevisionPersona 追加条件段；JudgeReviewInput +declaredRating）
- Modify: `src/pe-framework/continue/engine.ts` 调用方注入模板（grep `seed.system` 的生产调用点，instruction 追加评级行）
- Modify: `src/pe-framework/optimize/mutate.ts`（MUTATION_PERSONA 追加约束行）
- Test: `tests/pe-framework/eval/rating-neutral.test.ts`

**Interfaces:**
- Produces（文本契约，逐字落盘）：
  - rubrics/anima.ts `boundary` 追加：

```
【评级中立】被评审产物若声明了内容分级（rating 档位），该档位下的合法词汇与要素不得作为 finding：
评委只评该档位内的结构/一致性/美学质量；对 explicit 档产出「违反内容政策」类 finding 属无效死信，禁止输出。
```

  - critic.ts：`JudgeReviewInput.declaredRating?: Rating` 存在时，buildPersona 产物尾部与 buildRevisionPersona 产物尾部各追加一行 `当前内容分级：{declaredRating}——按评级中立条款评审。`
  - continue instruction 追加行：`当前内容分级：{rating}——修订不得降档、不得清洗或委婉化已声明内容、不得触碰硬边界负向。`
  - MUTATION_PERSONA 追加：`变异候选不得修改内容分级语义与硬边界规则（safety/boundaries 词表与策略表为常量）。`

- [ ] **Step 1: 写失败测试**（字符串断言四件套：rubric boundary 含「评级中立」；buildPersona 在 declaredRating='explicit' 时 persona 含「当前内容分级：explicit」、undefined 时不含；buildRevisionPersona 同理；MUTATION_PERSONA 含「硬边界规则」）

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/pe-framework/eval/rating-neutral.test.ts` → FAIL

- [ ] **Step 3: 实现**（critic.ts 中 persona 拼装处按条件 append；continue 调用点定位：grep `seed.system` 生产侧传参处）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/pe-framework/eval tests/pe-framework/optimize && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/eval/rubrics/anima.ts src/pe-framework/eval/critic.ts src/pe-framework/continue/engine.ts src/pe-framework/optimize/mutate.ts tests/pe-framework/eval/rating-neutral.test.ts
git commit -m "feat(eval): rating-neutral judging + revision/mutation rating constraints (spec §7 P3-P5)"
```

---

### Task 14: prompt_author 编排 v2（预检/恒跑/审计移除/envelope）

**Files:**
- Modify: `src/tools/prompt-author.ts`
- Modify: `src/pe-framework/feedback/store.ts`（generations 表 +`rating TEXT` 列，`try { ALTER TABLE } catch {}` 幂等迁移）
- Test: `tests/tools/prompt-author-orchestration.test.ts`

**Interfaces:**
- Consumes: Task 6/7（预检）、Task 11（增量意图）、Task 10（推荐）、Task 5（applyStyleV2 advisory）。
- Produces（execute 路径按序）：
  1. schema：+`rating: { type: 'string', enum: ['safe','sensitive','explicit'], default: 'safe' }`；**删除** `audit_only` 字段与 L715-735 分支；`style_id` description 改为「风格预设 id（style_list 可查，82+ 条）」；tool description 同步。
  2. **预检**（input 校验后、任何 LLM 之前）：`const resolved = resolveRating(a.rating ?? 'safe', input)`；`escalatedFrom` 存在 → advisories.push(`rating_escalated:${resolved.rating}`)；`const violations = checkBoundaries(input, resolved.rating)`；非空 → `throw new Error(violations.map(v => v.gate + ':' + v.matched).join('; '))`。
  3. **恒跑**：`blueprint_id` 分支改为 `const oldBp = repo.load(a.blueprint_id); if (!oldBp) throw ...; draft.blueprint = await analyzeBlueprintIncremental(ctx, route, oldBp, input)`（input 必填校验去掉 `!a.blueprint_id` 豁免）；`draft.blueprint.core.rating = resolved.rating` 确定性注入。
  4. runEnrich 调用传 `rating: resolved.rating` 与推荐器输出（推荐器信号：media 判定 + input 关键词扫描 hasMotionIntent=/(挥|斩|跑|跃|战斗|dance|swing|run|leap|battle|action)/i 等，具体词表复用 Task 10 测试词表）。
  5. 两条 envelope 出口（蓝图分支 ~L905、默认 ~L966）result 顶层追加：`rating: { resolved: resolved.rating, escalatedFrom: resolved.escalatedFrom, source: resolved.source }`、`aesthetics: { recommendedCards }`（gates 已在既有审计通道）、`style: <applyStyleV2 摘要：id/name/injectedFragmentPhrases/artists/negativeAdded>`（engine 返回或从 blueprint.core.style 提取）。
  6. `recordGenerationSafe` payload +`rating: resolved.rating`。

- [ ] **Step 1: 写失败测试**（跟随既有 prompt-author 工具级测试文件的 mock seam——`_enrichProvider` 注入 / intent provider seam；用例：① rating='explicit' + input 含 'loli' → 抛错含 minor_content_conflict；② input 含 'bikini' 无显式 rating → envelope.rating.resolved='sensitive' 且 advisories 含 rating_escalated；③ audit_only 传入 → schema 校验失败（unknown field）；④ blueprint_id + input → mock intent 收到的 persona 含 `<old_blueprint>`，envelope.rating.resolved 注入蓝图；⑤ 默认路径 envelope 含 aesthetics.recommendedCards）

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/tools/prompt-author-orchestration.test.ts` → FAIL

- [ ] **Step 3: 实现六处**（见 Produces；audit_only 删除后 grep 全仓 `audit_only` 清残留——含本文件 description、docs 引用）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/tools && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/prompt-author.ts src/pe-framework/feedback/store.ts tests/tools/prompt-author-orchestration.test.ts
git commit -m "feat(author): orchestration v2 - preflight rating gate, intent always-on, envelope fields (spec §8 §9)"
```

---

### Task 15: style_list 工具 + 注册

**Files:**
- Create: `src/tools/style-list.ts`
- Modify: `src/plugin/index.ts`（注册工具，跟随既有工具注册模式）
- Test: `tests/tools/style-list.test.ts`

**Interfaces:**
- Produces: 工具 `style_list`，输入 `{ category?, rating?, applies_to?, query? }`（均可选）→ 输出 presets 摘要数组 `{ id, name, category, rating, artistCount, negativeCount, source }`；零 LLM、只读。

- [ ] **Step 1: 写失败测试**（mock registry 或直接用真 assets：断言全量 55、rating 过滤、query 命中、输出字段形状）

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/tools/style-list.test.ts` → FAIL

- [ ] **Step 3: 实现 + 注册**（tool description：「风格预设库查询（spec §9）：按 category/rating/applies_to/关键字过滤；只读零 LLM」）

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run tests/tools && npx tsc --noEmit` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/style-list.ts src/plugin/index.ts tests/tools/style-list.test.ts
git commit -m "feat(tools): style_list read-only preset discovery tool (spec §9)"
```

---

### Task 16: 全量验证 + dist 同步 + 文档收口

**Files:**
- Modify: `docs/cli-cookbook.md`（prompt_author 新参数 rating、style_list 用法、audit_only 移除说明）
- Modify: `plugins/prompt-master/AGENTS.md` 不在仓库？否——**preset 根 `AGENTS.md`** 的 prompt_author 描述行同步（rating 参数、audit_only 移除）

- [ ] **Step 1: 全量测试** — Run: `npx vitest run` → 831+ 基线全绿（新增测试计入，0 failed）
- [ ] **Step 2: 类型 + 构建** — Run: `npx tsc --noEmit && npm run build` → 干净；`node -e "import('./dist/src/pe-framework/styles/registry.js').then(m => console.log(m.stylePresetCount()))"` → 输出 55（dist ESM 冒烟）
- [ ] **Step 3: 文档收口**（cli-cookbook 补 rating/style_list/audit_only→prompt_audit 迁移；preset 根 AGENTS.md 同步字段说明）
- [ ] **Step 4: Commit**

```bash
git add docs/cli-cookbook.md ../AGENTS.md
git commit -m "docs: rating/style_list/audit_only migration notes (spec §9)"
```

---

## M2（独立后续计划，不在本计划范围）

27 条新增预设 authoring（spec §4.4 新增表，NSFW 11 条词表在 authoring 时经 catalog_search 逐一验证画师与锚点 tag）+ 对应存在性测试。纯数据里程碑，零机制改动；待 M1 合入后单独立计划执行。

## 计划自审记录

- Spec 覆盖：§4.1-4.4→T1-5、§5→T6-8+T14、§6→T9-10+T12、§7 P1→T11（含偏差记录：rating 确定性注入）、P2→T12、P3-P5→T13、§8→T14、§9→T14-15、§10→T2-3、§11→各任务 Step 4 + T16、M2→尾注。无缺口。
- 占位符扫描：T8/T12/T14 中「跟随既有 mock 模式」处均已指明具体文件与 seam 名（`_enrichProvider`、ctx.llm.stream、seed.system），非泛化指示。
- 类型一致性：`Rating` 唯一定义于 types.ts；`recommendArtDirection` 返回形状在 T10 定义、T12/T14 消费同名；`resolveEffectiveRating` 入参为 AnimaSlots（T6 定义 T8 消费）。
