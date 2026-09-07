# Blueprint IR（Phase 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 prompt-master 插件上插入「创作蓝图 IR」层——意图分析 → 蓝图 v0 → 美学扩展 → v1 → 方言投影 → 现有 runStage，并修复 CJK 审计误报、duration 语义、失败语义、增量修正四大上次会话痛点。

**Architecture:** 保留 runStage/DialectContract/Envelope 内核不动，新增 `blueprint/`（schema+投影器+存储）、`enrichment/`（扩展引擎+风格库）、`aesthetics/`（词库+自检）三个目录；author 工具改为「蓝图管线」入口；audit 语义闸门降级 + Envelope 加 `next_action`。

**Tech Stack:** TypeScript、Cordis plugin、dsh-tools `defineTool`、dsh-llm `complete`、vitest、现有 stubCtx/runTool 测试 helpers、现有 settings namespace（`prompt-master-custom-profiles`）复用为蓝图存储。

**Spec:** `docs/2026-09-07-blueprint-ir-design.md`（本计划从 spec 论证，执行者需同时阅读 spec 与本文档）

## Global Constraints

- 现有 golden fidelity 测试必须保持全绿（方言编译逐字节不变）——投影器输出必须与现有 `H3ShotsInput` / `AnimaSlots` 形状完全兼容。
- 现有 `prompt_compile` / `prompt_audit` / `catalog_*` / resolver 族工具行为不变（Phase 1 只动 `prompt_author` 全链 + 审计语义 + Envelope）。
- 负向三档适配、角色卡识别锚点、duration 双字段语义按 spec §5.2 执行。
- LLM 调用预算 ≤3 次/任务（分析 1 + 扩展 1 + 修正 ≤1）；确定性路径（投影/预修/审计/自检）零 LLM。
- 测试用现有 `tests/plugin/helpers.ts`（`stubCtx` / `runTool` / `textStream` / `stubExec`）；vitest 跑 `npx vitest run`。
- 所有新文件位于 `src/pe-framework/blueprint/`、`src/pe-framework/enrichment/`、`src/pe-framework/aesthetics/`。
- 每次任务结束 `git commit`，提交信息按 `feat(prompt-master): ...` / `fix(prompt-master): ...` / `docs(prompt-master): ...` 前缀。

---

### Task 1: 修 CJK 语义闸门误报（事故根因 #1）

**Files:**
- Modify: `src/pe-framework/audit/rules-h3.ts`（`semanticShot` + `auditTimeline` 的 shot_execution 判定）
- Test: `tests/pe-framework/audit/cjk-shots.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `auditH3Full(text, meta, refs)`（规则注册点，见 `rules-h3.ts`），`H3Shot`/`Reference` 类型来自 `schema/h3-shots.ts`。
- Produces: 无新导出；`shot_execution` 闸门从 `severity: 'critical'` 改为 `'important'`，且对 CJK 文本不再误报「no new information」。

- [ ] **Step 1: 写失败测试**（先锁定当前 bug）

```ts
// tests/pe-framework/audit/cjk-shots.test.ts
import { describe, expect, it } from 'vitest'
import { auditH3Full } from '../../../src/pe-framework/audit/rules-h3.js'

const zhShots =
  'integrated_multimodal_description: [Shot 1] 黄昏荒原，两名持刀武者相隔十步相向而立，镜头缓慢推近，风吹起衣摆与沙尘，剑拔弩张. [Shot 2] At 00:02.500, the camera cuts to 两人同时爆发冲刺，双刀猛烈碰撞溅出火花，写实的刀身震颤与受击反馈. [Shot 3] At 00:05.000, the camera cuts to 决定性一击：青年武者一刀崩开对手的刀，刀锋停在对方颈侧，胜负已分.\n\noverall_soundscape: 荒原风卷沙尘，写实光影\n\nnon_diegetic_music: 低沉鼓点渐强'

describe('H3 audit: CJK multi-shot should NOT false-positive', () => {
  it('three distinct Chinese shots produce no shot_execution gate', () => {
    const gates = auditH3Full(zhShots, { stage: 't2va', duration: 7.5, shotCount: 3 }, [])
    const se = gates.filter((g) => g.rule === 'shot_execution')
    expect(se).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/audit/cjk-shots.test.ts`
Expected: FAIL——`shot_execution` gate 被触发（当前 CJK 语义判空导致 `Shot 2/3` 误报「no new information」）。

- [ ] **Step 3: 修 `semanticShot` 与 `auditTimeline`**

在 `src/pe-framework/audit/rules-h3.ts` 中定位 `semanticShot`（当前实现只抽 ASCII `[a-z0-9]+`），替换为 CJK 感知的差异度量，并把 `shot_execution` 降级为 `important`：

```ts
// 替换原 semanticShot（ASCII-only）
function semanticShot(text: string): string {
  // CJK 感知：抽中文二元组 + ASCII 词，中文正文不再判空
  const norm = text.toLowerCase()
  const ascii = (norm.match(/[a-z0-9]+/g) ?? []).join(' ')
  const cjkChars = norm.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []
  const bigrams: string[] = []
  for (let i = 0; i + 1 < cjkChars.length; i++) bigrams.push(cjkChars[i] + cjkChars[i + 1])
  return [ascii, ...bigrams].filter(Boolean).join(' ')
}
```

在 `auditTimeline` 的 shot_execution 判定处：`semanticShot(prev) === semanticShot(cur)` 判定保留，但产出 gate 的 `severity` 改为 `'important'`（语义近似，非确定性硬约束）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/audit/cjk-shots.test.ts tests/plugin/h3-audit.test.ts`
Expected: 新测试 PASS；现有 `h3-audit.test.ts` 的 `shot_execution: empty shot content fails`（空内容仍应报）继续 PASS。

- [ ] **Step 5: Commit**

```bash
git add tests/pe-framework/audit/cjk-shots.test.ts src/pe-framework/audit/rules-h3.ts
git commit -m "fix(prompt-master): CJK-aware semanticShot + demote shot_execution to important (spec #1)"
```

---

### Task 2: 蓝图 IR schema + 校验（纯类型 + 纯函数）

**Files:**
- Create: `src/pe-framework/blueprint/schema.ts`
- Test: `tests/pe-framework/blueprint/schema.test.ts`（新建）

**Interfaces:**
- Consumes: 无（独立纯模块；`Reference` 类型从 `schema/h3-shots.js` 导入可选的引用标注）。
- Produces:
  - `interface BlueprintV1`（字段见 spec §5.1，含 `media` / `core.aspect_ratio` / `core.negative: NegativeConstraint[]` / `core.characters: Character[]` / `media_layer.video.total_duration_seconds` / `media_layer.video.shots: Shot[]`）
  - `interface Character`（`id`/`name?`/`appearance_anchors`/`outfit?`/`props?`/`distinctive?`/`reference_slots?`/`variant?`/`continuity_lock?`）
  - `interface Shot`（`beat`/`shot_size?`/`camera_angle?`/`camera?`/`action?`/`dialogue?`/`audio_focus?`/`music?`/`duration_seconds?`/`who?`/`remark?`）
  - `interface NegativeConstraint`（`target`/`attribute?`/`severity?: 'soft'|'hard'`）
  - `interface StyleRef`（`base?`/`theme?`/`palette?`）
  - `function validateBlueprint(bp: unknown): { ok: true; value: BlueprintV1 } | { ok: false; errors: string[] }` —— 校验必填（`media`、`core.concept`）、类型、`aspect_ratio` 枚举（`16:9|9:16|1:1|4:3|3:4`）、`total_duration_seconds` 范围（4–15，视频时）、`shots` 非空数组。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/blueprint/schema.test.ts
import { describe, expect, it } from 'vitest'
import { validateBlueprint } from '../../../src/pe-framework/blueprint/schema.js'

describe('validateBlueprint', () => {
  it('accepts a minimal valid image blueprint', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'image',
      core: { concept: '黄昏荒原的剑客', aspect_ratio: '16:9', negative: [] },
      media_layer: { image: { lighting_detail: '黄金时刻' } },
    })
    expect(r.ok).toBe(true)
  })
  it('rejects missing concept', () => {
    const r = validateBlueprint({ schema_version: 1, media: 'video', core: {} })
    expect(r.ok).toBe(false)
    expect((r as { errors: string[] }).errors.join()).toContain('concept')
  })
  it('rejects bad aspect_ratio', () => {
    const r = validateBlueprint({ schema_version: 1, media: 'image', core: { concept: 'x', aspect_ratio: '5:7' } })
    expect(r.ok).toBe(false)
  })
  it('rejects video total_duration outside 4-15', () => {
    const r = validateBlueprint({
      schema_version: 1, media: 'video',
      core: { concept: 'x' },
      media_layer: { video: { total_duration_seconds: 30, shots: [{ beat: 'a' }] } },
    })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/blueprint/schema.test.ts`
Expected: FAIL——`validateBlueprint` 不存在（module not found）。

- [ ] **Step 3: 实现 `schema.ts`**

按 spec §5.1 定义全部接口与 `validateBlueprint`（纯函数；`Array.isArray` / `typeof` 判定；错误信息含字段路径，如 `core.concept must be a non-empty string`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/blueprint/schema.test.ts`
Expected: 4 个用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/blueprint/schema.ts tests/pe-framework/blueprint/schema.test.ts
git commit -m "feat(prompt-master): blueprint IR schema + validateBlueprint (spec §5)"
```

---

### Task 3: Envelope 加 `next_action` + `repair_hints`（失败语义）

**Files:**
- Modify: `src/pe-framework/render/envelope.ts`
- Modify: `src/tools/prompt-compile.ts`（merge extraGates 后重算 `next_action`）
- Test: `tests/plugin/envelope-next-action.test.ts`（新建）

**Interfaces:**
- Consumes: `StageResult`（`pipeline/types.js`）、`AuditGate`（`types.js`）。
- Produces: `function computeNextAction(stage: StageResult, opts?: { repairHints?: Array<{ field: string; fix: string }>; repaired?: boolean }): 'retry_input' | 'auto_repair' | 'manual' | 'advisory_only' | 'ok'`；Envelope 顶层加 `next_action` 与可选 `repair_hints`。

**判定规则（修正版，消除死分支）**：
- `stage.ok` 为 true 且无 advisories → `'ok'`
- `stage.ok` 为 true 但有 advisories → `'advisory_only'`
- 非 ok 且 `opts.repaired === true`（引擎 Level 1/2 已实际修复过）→ `'auto_repair'`
- 非 ok 且有 `loop_exhausted:true` advisory → `'manual'`
- 非 ok 含 critical 契约闸门（rule ∈ {max_shots, parse_request, duration_range, ref_count, field_order, cut_timestamps, char_budget}）→ `'retry_input'`（附 repair_hints）
- 其余非 ok → `'manual'`（无法自动归因）

- [ ] **Step 1: 写失败测试**

```ts
// tests/plugin/envelope-next-action.test.ts
import { describe, expect, it } from 'vitest'
import { computeNextAction } from '../../src/pe-framework/render/envelope.js'

function stage(ok: boolean, gates: Array<{ rule: string; severity: string }>, advisories: string[]) {
  return { ok, gates, advisories, assumptions: [], result: {}, targetSlotHint: 't2v.prompt' } as any
}

describe('computeNextAction', () => {
  it('ok + no advisories → ok', () => {
    expect(computeNextAction(stage(true, [], []))).toBe('ok')
  })
  it('ok + advisories → advisory_only', () => {
    expect(computeNextAction(stage(true, [], ['joy_extra_filtered']))).toBe('advisory_only')
  })
  it('critical contract gate (max_shots) → retry_input with repair hint', () => {
    const s = stage(false, [{ rule: 'max_shots', severity: 'critical' }], [])
    expect(computeNextAction(s, { repairHints: [{ field: 'duration_seconds', fix: '改为 15（总时长）' }] })).toBe('retry_input')
  })
  it('non-ok but repaired=true → auto_repair', () => {
    const s = stage(false, [{ rule: 'parse_request', severity: 'critical' }], [])
    expect(computeNextAction(s, { repaired: true })).toBe('auto_repair')
  })
  it('loop_exhausted advisory + non-ok → manual', () => {
    const s = stage(false, [{ rule: 'shot_execution', severity: 'important' }], ['loop_exhausted:true'])
    expect(computeNextAction(s)).toBe('manual')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/envelope-next-action.test.ts`
Expected: FAIL——`computeNextAction` 不存在。

- [ ] **Step 3: 实现 `computeNextAction` 并接入 Envelope**

在 `envelope.ts` 导出纯函数，按「判定规则（修正版）」实现（见上）。`assembleEnvelope` 增加 `next_action`（由调用方传 `computeNextAction(stage, { repairHints, repaired })` 的结果）与透传 `repair_hints`；`repaired` 由 author/compile 调用方在 Level 1/2 实际修复后置 true（Task 10）。

- [ ] **Step 4: 跑测试确认通过 + 现有 Envelope 测试不回归**

Run: `npx vitest run tests/plugin/envelope-next-action.test.ts tests/plugin/audit-report.test.ts`
Expected: 新用例 PASS；现有 `audit-report.test.ts` 全绿（`serializeReport` 输出新增字段不影响既有断言——如受影响，同步更新该测试期望，字段顺序保持稳定）。

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/render/envelope.ts tests/plugin/envelope-next-action.test.ts
git commit -m "feat(prompt-master): Envelope next_action + repair_hints (spec §11)"
```

---

### Task 4: 方言包能力声明 + preflight 约束表（约束前置）

**Files:**
- Create: `src/pe-framework/dialect/package.ts`（方言包类型 + h3/anima 实例）
- Modify: `src/pe-framework/dialect/h3.ts`（`registerH3Dialect` 挂能力声明）
- Modify: `src/pe-framework/dialect/anima.ts`（`registerAnimaDialect` 挂能力声明）
- Test: `tests/pe-framework/dialect/package.test.ts`（新建）

**Interfaces:**
- Consumes: `getDialect`（`registry.js`）。
- Produces:
  - `interface DialectPackage`（`capabilities: { native_negative, supports_audio, supports_dialogue, camera_axes, media_targets, aspect_ratios, duration_range, max_shots_formula?, max_prompt_chars, budget_quality_cap }` + `constraints: { validate(input: unknown): string[] }` + `aesthetics: { forbidden_words, few_shot_examples, style_hints }` + `license?: { id, url, territory_restrictions? }`）
  - `function getDialectPackage(target: 'anima'|'h3'): DialectPackage | undefined` —— 从注册表方言的 `capabilities`/`constraints`/`aesthetics`/`license` 字段读取（未声明 → undefined）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/dialect/package.test.ts
import { describe, expect, it } from 'vitest'
import { getDialectPackage } from '../../../src/pe-framework/dialect/package.js'
import '../../../src/pe-framework/dialect/h3.js'
import '../../../src/pe-framework/dialect/anima.js'

describe('dialect package declarations', () => {
  it('h3 declares capabilities from official constants', () => {
    const p = getDialectPackage('h3')!
    expect(p.capabilities.native_negative).toBe(false)
    expect(p.capabilities.duration_range).toEqual([4, 15])
    expect(p.capabilities.max_prompt_chars).toBe(7000)
    expect(p.capabilities.max_shots_formula).toBe('1 + floor((duration - 1) / 3)')
    expect(p.license?.id).toContain('MiniMax-H3')
  })
  it('anima declares native_negative true', () => {
    const p = getDialectPackage('anima')!
    expect(p.capabilities.native_negative).toBe(true)
  })
  it('unknown dialect → undefined', () => {
    expect(getDialectPackage('flux')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/dialect/package.test.ts`
Expected: FAIL——`getDialectPackage` 不存在。

- [ ] **Step 3: 实现 `package.ts` + 挂载到 h3/anima 方言**

在 `DialectContract`（`contract.ts`）上增加可选字段 `capabilities?` / `constraints?` / `aesthetics?` / `license?`；h3 方言常量从 `schema/h3-shots.ts`（`MIN_DURATION_SECONDS`/`MAX_DURATION_SECONDS`/`MAX_PROMPT_CHARS`/`MAX_SHOT_FORMULA`）与 `audit/budget.ts`（`STAGE_QUALITY_CAPS`）提取；license 从 `assets/knowledge/minimax-h3-prompt/manifest.json` 的 `license` 字段。`getDialectPackage` 从 `getDialect(target)` 读这些字段。
**contractGatesH3 落点（澄清）**：现有 `contractGatesH3(stage, shots, refs): AuditGate[]` 在 `audit/rules-h3.ts:247`（被 `dialect/h3.ts:333` 与 `tools/prompt-audit.ts:50` 引用）。**不迁移代码**——`DialectPackage.constraints.validate` 定义为对该函数的薄封装（`validate: (input) => contractGatesH3(input.stage, input.shots, input.refs ?? [])`），方言包在 `h3.ts` 注册时组装；audit 层与 prompt-audit 继续直接引用原函数，零改动、无重复实现。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/dialect/package.test.ts tests/pe-framework/dialect/h3-register.test.ts tests/pe-framework/dialect/anima-register.test.ts`
Expected: 新用例 PASS；现有注册测试全绿（只加字段不改既有行为）。

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/dialect/package.ts src/pe-framework/dialect/contract.ts src/pe-framework/dialect/h3.ts src/pe-framework/dialect/anima.ts tests/pe-framework/dialect/package.test.ts
git commit -m "feat(prompt-master): dialect package capabilities + constraints + license (spec §9)"
```

---

### Task 5: `prompt_compile` 增加 `preflight_only`（先验约束零 LLM）

**Files:**
- Modify: `src/tools/prompt-compile.ts`
- Test: `tests/plugin/compile-preflight.test.ts`（新建）

**Interfaces:**
- Consumes: `getDialectPackage`（Task 4）、`normalizeH3Input`（`dialect/h3.js`，已存在）。
- Produces: `prompt_compile` 新参数 `preflight_only?: boolean`——为 true 时不调 runStage 编译，仅对输入（shots/scenario form）跑 `constraints.validate`，返回 `{ ok, audit: { passed, gates } }`（无 result），Envelope 带 `next_action`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/plugin/compile-preflight.test.ts
import { describe, expect, it } from 'vitest'
import { registerCompileTool } from '../../src/tools/prompt-compile.js'
import { stubCtx, runTool } from './helpers.js'

const def = () => registerCompileTool(stubCtx() as any)

describe('prompt_compile preflight_only', () => {
  it('catches max_shots violation without compiling', async () => {
    const v = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'h3', preflight_only: true,
      shots: { duration_seconds: 5, shots: [{ what: 'a' }, { what: 'b' }, { what: 'c' }] },
    })))
    expect(v.ok).toBe(false)
    expect(v.audit.gates.some((g: any) => g.rule === 'max_shots')).toBe(true)
    expect(v.next_action).toBe('retry_input')
  })
  it('passes preflight for valid input with no result body', async () => {
    const v = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'h3', preflight_only: true,
      shots: { duration_seconds: 10, shots: [{ what: 'a' }, { what: 'b' }, { what: 'c' }] },
    })))
    expect(v.ok).toBe(true)
    expect(v.result).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/compile-preflight.test.ts`
Expected: FAIL——`preflight_only` 参数不被识别（现有 execute 忽略它）。

- [ ] **Step 3: 实现 preflight 分支**

在 `prompt-compile.ts` 的 `execute` 中：参数 schema 加 `preflight_only`；当 `preflight_only === true` 时，h3 分支对 `shots`/`scenario form` 调 `contractGatesH3`（或 `getDialectPackage(target).constraints.validate`）返回 gates，组装 `{ ok, audit:{passed, gates}, advisories: [], next_action: computeNextAction(...) }`，**不执行 compile/budget**。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/plugin/compile-preflight.test.ts tests/plugin/compile-h3.test.ts`
Expected: 新用例 PASS；现有 compile-h3 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/tools/prompt-compile.ts tests/plugin/compile-preflight.test.ts
git commit -m "feat(prompt-master): prompt_compile preflight_only — zero-LLM constraint check (spec #3)"
```

---

### Task 6: 最小风格库 v0（8 风格 + conformity）+ 蓝图存储

**Files:**
- Create: `src/pe-framework/enrichment/style.ts`
- Create: `src/pe-framework/blueprint/repo.ts`
- Test: `tests/pe-framework/enrichment/style.test.ts` + `tests/pe-framework/blueprint/repo.test.ts`（新建）

**Interfaces:**
- Consumes: 无（style 纯数据）；`repo` 消费 `settings` namespace（经 `ctx` 注入，测试用 `stubCtx({ settings })`）。
- Produces:
  - `interface StyleTemplate { id: string; name: string; base?: string; theme?: string; palette?: string; prompt_fragments: { image: string; video: string }; applies_to: string[]; negative_hints: string[] }`
  - `const MINIMAL_STYLES: StyleTemplate[]`（8 个：写实电影/游戏 CG/赛璐璐/厚涂/赛博朋克/和风/废土/暗黑史诗；`prompt_fragments` 来自现有 `expand_cinematic`/`expand_photographer` 的 system prompt 提取的具体名词片段，不用空泛词）
  - `function applyStyle(bp: BlueprintV1, styleId: string, conformity: number): BlueprintV1` —— 把风格 fragment 并入 `core.style` 与 `media_layer` 对应字段；conformity=0 全按模板，=1 仅注入 style 引用不注入片段。
  - `function createBlueprintRepo(ctx): { save(id: string, bp: BlueprintV1): void; load(id: string): BlueprintV1 | undefined; list(): string[] }` —— 复用 `settings` namespace `prompt-master-custom-profiles` 的形状扩展（`blueprints: Record<string, string>`，JSON 序列化）。

- [ ] **Step 1: 写失败测试（style + repo 各一）**

```ts
// tests/pe-framework/enrichment/style.test.ts
import { describe, expect, it } from 'vitest'
import { MINIMAL_STYLES, applyStyle } from '../../../src/pe-framework/enrichment/style.js'
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'

const bp: BlueprintV1 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } }

describe('minimal style library', () => {
  it('has exactly 8 styles with non-empty fragments', () => {
    expect(MINIMAL_STYLES).toHaveLength(8)
    for (const s of MINIMAL_STYLES) {
      expect(s.prompt_fragments.image.length).toBeGreaterThan(0)
      expect(s.prompt_fragments.video.length).toBeGreaterThan(0)
    }
  })
  it('applyStyle at conformity 0 injects base style', () => {
    const out = applyStyle(bp, 'cinematic_real', 0)
    expect(out.core.style?.base).toContain('写实')
  })
  it('applyStyle unknown id returns unchanged', () => {
    const out = applyStyle(bp, 'nope', 0.6)
    expect(out).toBe(bp)
  })
})
```

```ts
// tests/pe-framework/blueprint/repo.test.ts
import { describe, expect, it } from 'vitest'
import { createBlueprintRepo } from '../../../src/pe-framework/blueprint/repo.js'

function stubSettings() {
  let data: Record<string, string> = {}
  return {
    get: () => ({ ...data }),
    update: async (p: object) => { data = { ...data, ...(p as any) } },
    replace: async (s: object) => { data = { ...(s as any) } },
  } as any
}

describe('blueprint repo', () => {
  it('round-trips save/load', () => {
    const repo = createBlueprintRepo({ settings: stubSettings() } as any)
    const bp = { schema_version: 1, media: 'image', core: { concept: 'x', negative: [] } }
    repo.save('b1', bp as any)
    expect(repo.load('b1')?.core.concept).toBe('x')
    expect(repo.list()).toContain('b1')
  })
  it('load missing → undefined', () => {
    const repo = createBlueprintRepo({ settings: stubSettings() } as any)
    expect(repo.load('missing')).toBeUndefined()
  })
  it('incremental edit: load → change one field → save (spec §5.3 增量修改前提)', () => {
    const repo = createBlueprintRepo({ settings: stubSettings() } as any)
    const bp = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', aspect_ratio: '16:9', negative: [] }, media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } } }
    repo.save('fight', bp as any)
    const loaded = repo.load('fight')!
    loaded.core.aspect_ratio = '9:16'          // 只改一个字段
    loaded.media_layer.video!.shots = loaded.media_layer.video!.shots.slice(0, 2)  // 删一镜
    repo.save('fight', loaded)
    const after = repo.load('fight')!
    expect(after.core.aspect_ratio).toBe('9:16')
    expect(after.media_layer.video!.shots).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/enrichment/style.test.ts tests/pe-framework/blueprint/repo.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `style.ts` 与 `repo.ts`**

`style.ts`：8 个模板具体名词化（例：`cinematic_real` → `prompt_fragments.video: 'IMAX 胶片质感，Panavision C 系 35mm f4，伦勃朗光，黄昏黄金时刻，青橙色彩分级'`）；`applyStyle` 依 conformity 注入。
`repo.ts`：`createBlueprintRepo(ctx)` 用 `ctx.settings` 的 get/update/replace，namespace 内 `blueprints` 表（沿用 `prompt-master-custom-profiles` 的 `z.dict` 模式），`load` 时 JSON.parse 失败返回 undefined。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/enrichment/style.test.ts tests/pe-framework/blueprint/repo.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/enrichment/style.ts src/pe-framework/blueprint/repo.ts tests/pe-framework/enrichment/style.test.ts tests/pe-framework/blueprint/repo.test.ts
git commit -m "feat(prompt-master): minimal style library v0 (8 styles + conformity) + blueprint repo (spec §7.2 §5.3)"
```

---

### Task 7: 美学扩展引擎（v0→v1 基础美学规则 + 具体性自检 + 电影摄影词库）

**Files:**
- Create: `src/pe-framework/enrichment/engine.ts`
- Create: `src/pe-framework/aesthetics/check.ts`
- Create: `src/pe-framework/aesthetics/lexicon.ts`（电影摄影词库，spec §7.3）
- Test: `tests/pe-framework/enrichment/engine.test.ts` + `tests/pe-framework/aesthetics/check.test.ts` + `tests/pe-framework/aesthetics/lexicon.test.ts`（新建）

**Interfaces:**
- Consumes: `BlueprintV1`（Task 2）、`MINIMAL_STYLES`/`applyStyle`（Task 6）、`complete`（`llm/complete.js`，已存在：`complete(ctx, {provider, model, system, user, maxTokens, temperature, signal}) → {text}`）。
- Produces:
  - `function enrichBlueprint(ctx, route: { provider: string; model: string }, v0: BlueprintV1, opts: { styleId?: string; conformity?: number; missing?: string[] }): Promise<{ blueprint: BlueprintV1; expansions: string[] }>` —— LLM 扩展（具体名词化 + ROI 补全 + 负向补全），返回改写记录 `expansions[]`（spec §5.2-6 可审计）。
  - `function checkConcreteness(bp: BlueprintV1): { pass: boolean; issues: string[] }` —— 禁空泛词扫描（`cinematic/beautiful/amazing/stunning/epic/大气/高级` 等）+ 含可感知名词比例下限。
  - `function checkFidelity(original: string, bp: BlueprintV1): { pass: boolean; missingEntities: string[] }` —— 保真守卫（spec §6）：用户原文核心实体（中英名词短语）必须出现在蓝图任意字段；缺失即意图丢失，返回缺失实体列表。纯函数。
  - `const CINEMA_LEXICON: { shots: string[]; lenses: string[]; camera_moves: string[]; lighting: string[]; grading: string[]; composition: string[] }` —— 电影摄影词库（spec §7.3 结构化数据，非 LLM prompt）：景别/焦段/运镜/光线/色彩分级/构图，从调研二词表与现有 `expand_cinematic` profile 提取，每条为可感知名词短语。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/aesthetics/check.test.ts
import { describe, expect, it } from 'vitest'
import { checkConcreteness } from '../../../src/pe-framework/aesthetics/check.js'

describe('checkConcreteness', () => {
  it('flags empty vague words', () => {
    const r = checkConcreteness({ schema_version: 1, media: 'image', core: { concept: 'beautiful amazing 高级感', negative: [] } } as any)
    expect(r.pass).toBe(false)
    expect(r.issues.length).toBeGreaterThan(0)
  })
  it('passes concrete nouns', () => {
    const r = checkConcreteness({ schema_version: 1, media: 'image', core: { concept: '黄昏荒原上的银发剑客，Panavision 35mm，伦勃朗光', negative: [] } } as any)
    expect(r.pass).toBe(true)
  })
})
```

```ts
// tests/pe-framework/enrichment/engine.test.ts
import { describe, expect, it } from 'vitest'
import { enrichBlueprint } from '../../../src/pe-framework/enrichment/engine.js'
import { textStream } from '../../plugin/helpers.js'

const ctx = {
  llm: { async *stream() { for (const c of textStream('{"core":{"concept":"黄昏荒原上的剑客","negative":[{"target":"现代元素"}]}}')) yield c } },
} as any

describe('enrichBlueprint', () => {
  it('returns expanded blueprint + expansions audit trail', async () => {
    const v0 = { schema_version: 1, media: 'video', core: { concept: '剑客决斗', negative: [] }, media_layer: { video: { total_duration_seconds: 10, shots: [{ beat: '对峙' }] } } } as any
    const out = await enrichBlueprint(ctx, { provider: 'p', model: 'm' }, v0, { styleId: 'cinematic_real', conformity: 0.6 })
    expect(out.blueprint.core.concept.length).toBeGreaterThan(0)
    expect(Array.isArray(out.expansions)).toBe(true)
  })
})
```

```ts
// tests/pe-framework/aesthetics/lexicon.test.ts
import { describe, expect, it } from 'vitest'
import { CINEMA_LEXICON } from '../../../src/pe-framework/aesthetics/lexicon.js'

describe('cinema lexicon', () => {
  it('has non-empty structured categories with concrete terms', () => {
    for (const key of ['shots', 'lenses', 'camera_moves', 'lighting', 'grading', 'composition'] as const) {
      expect(CINEMA_LEXICON[key].length).toBeGreaterThan(3)
      for (const term of CINEMA_LEXICON[key]) expect(term.length).toBeGreaterThan(1)
    }
  })
})
```

```ts
// tests/pe-framework/aesthetics/fidelity.test.ts
import { describe, expect, it } from 'vitest'
import { checkFidelity } from '../../../src/pe-framework/aesthetics/check.js'

describe('checkFidelity (保真守卫)', () => {
  it('passes when user entities survive into blueprint', () => {
    const r = checkFidelity('银发剑客在黄昏荒原决斗', { schema_version: 1, media: 'video', core: { concept: '银发剑客黄昏荒原决斗', negative: [] } } as any)
    expect(r.pass).toBe(true)
  })
  it('flags when a user entity is dropped', () => {
    const r = checkFidelity('银发剑客在黄昏荒原决斗', { schema_version: 1, media: 'video', core: { concept: '两个武士打斗', negative: [] } } as any)
    expect(r.pass).toBe(false)
    expect(r.missingEntities.join()).toContain('银发剑客')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/aesthetics/check.test.ts tests/pe-framework/aesthetics/lexicon.test.ts tests/pe-framework/aesthetics/fidelity.test.ts tests/pe-framework/enrichment/engine.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `check.ts` / `lexicon.ts` / `engine.ts`**

`check.ts`：禁词表 + 具体名词判定（含 CJK 长度 + 数字 + 已知词表）+ `checkFidelity`（抽取原文中英名词短语 → 蓝图字段全文包含性检查），纯函数。
`lexicon.ts`：`CINEMA_LEXICON` 结构化词库（景别 CU/MCU/MS/FS/WS、焦段 24/35/85/135mm、运镜 dolly/pan/tracking/orbit/crane/handheld、光线 黄金时刻/伦勃朗光/体积光/三点布光、色彩分级 青橙/低饱和/漂白、构图 三分法/对称/负空间/前景引导）。
`engine.ts`：构造扩展 persona（spec §7.1 规则文本：具体名词化/禁空泛词/ROI 顺序「光影>主体特征>运镜」/负向推断/角色锚点补全），把 `CINEMA_LEXICON` 关键类目注入 persona 作为候选词；经 `complete` 让 LLM 只输出**增量 JSON patch**（`{set: {...}, additions: {...}, expansions: [...]}`），应用 patch 到 v0 → v1；`expansions` 从 LLM 返回收集（无则用 `missing` 生成占位记录）。patch 应用失败 → 返回 v0 + `expansions: ['enrichment_failed:fallback_to_v0']`（不抛错）。v1 产出后**必须过 `checkConcreteness` + `checkFidelity`**——任一失败 → 追加 advisory 进 `expansions`（如 `concreteness_failed:...`）但不阻断（保真缺失记录在 expansions 供上层处理）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/pe-framework/enrichment/engine.test.ts tests/pe-framework/aesthetics/check.test.ts tests/pe-framework/aesthetics/lexicon.test.ts tests/pe-framework/aesthetics/fidelity.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/enrichment/engine.ts src/pe-framework/aesthetics/check.ts src/pe-framework/aesthetics/lexicon.ts tests/pe-framework/enrichment/engine.test.ts tests/pe-framework/aesthetics/check.test.ts tests/pe-framework/aesthetics/lexicon.test.ts tests/pe-framework/aesthetics/fidelity.test.ts
git commit -m "feat(prompt-master): aesthetics enrichment engine + concreteness/fidelity checks + cinema lexicon (spec §7 §13 §6)"
```

---

### Task 8: 方言投影器（IR → slots/shots，deterministic）

**Files:**
- Create: `src/pe-framework/blueprint/project.ts`
- Test: `tests/pe-framework/blueprint/project.test.ts`（新建）

**Interfaces:**
- Consumes: `BlueprintV1`/`Character`/`Shot`/`NegativeConstraint`（Task 2）、`H3ShotsInput`（`schema/h3-shots.js`）、`AnimaSlots`（`dialect/anima.js`）。
- Produces:
  - `function projectToH3(bp: BlueprintV1): H3ShotsInput` —— **无 lang 参数**：蓝图语言由分析器/扩展器按方言 output_lang 产出（spec §5.2-4 语言策略），投影器不做翻译；H3 蓝图即中文。
  - `function projectToAnima(bp: BlueprintV1): AnimaSlots` —— Anima 蓝图即英文 tag（由分析器产出）。
  - 负向三档：`native_negative=true` 方言映射到对应字段；无 native（H3）→ 把 `severity:'soft'` 的负向**正向改写**进 `what` 末句（例 `{target:'文字',attribute:'字幕'}` → 首镜 what 追加「无字幕纯净画面」）+ 返回 advisory 标记（`projectAdvisories: string[]` 一并导出）；`hard` 类在投影前由调用方过滤（本函数遇 hard → throw `BlueprintHardNegativeError`）。
  - 角色 `Shot.who`（角色 id）→ `<Subject N>`：按 `Character.reference_slots` 顺序或 references 顺序编号映射；`continuity_lock` 角色锚点强制注入每个涉及镜头的 `what` 首句。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/blueprint/project.test.ts
import { describe, expect, it } from 'vitest'
import { projectToH3, projectToAnima, projectAdvisories } from '../../../src/pe-framework/blueprint/project.js'
import type { BlueprintV1 } from '../../../src/pe-framework/blueprint/schema.js'

const h3Bp: BlueprintV1 = {
  schema_version: 1, media: 'video',
  core: {
    concept: '剑客决斗', aspect_ratio: '16:9',
    characters: [{ id: 'c1', name: '银发剑客', appearance_anchors: ['银白长发', '灰色披风', '反手持刀'], continuity_lock: true }],
    scene: { environment: '黄昏荒原' }, emotion: '紧张', composition: ['三分法'],
    negative: [{ target: '字幕', severity: 'soft' }, { target: '血腥', severity: 'hard' }],
  },
  media_layer: {
    video: {
      total_duration_seconds: 15,
      shots: [
        { beat: '对峙', shot_size: 'MS', camera: 'dolly', who: ['c1'], audio_focus: '风声', music: '低鼓' },
        { beat: '交锋', shot_size: 'CU', who: ['c1'] },
        { beat: '决胜', shot_size: 'WS', who: ['c1'] },
      ],
    },
  },
}

describe('projectToH3', () => {
  it('maps duration to total and preserves 3 shots', () => {
    const s = projectToH3(h3Bp)
    expect(s.duration_seconds).toBe(15)
    expect(s.shots).toHaveLength(3)
  })
  it('injects continuity-locked anchors into every shot what', () => {
    const s = projectToH3(h3Bp)
    for (const shot of s.shots) expect(shot.what).toContain('银白长发')
  })
  it('soft negative → positive rewrite + advisory; hard → throws', () => {
    expect(() => projectToH3(h3Bp)).toThrow(/hard negative/)
  })
})

describe('projectToAnima', () => {
  it('maps anchors to appearance + negative to exclusions', () => {
    const s = projectToAnima({ ...h3Bp, media: 'image', negative: [{ target: '字幕', severity: 'soft' }] } as any)
    expect(s.appearance).toContain('银白长发')
    expect(s.exclusions).toContain('字幕')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/blueprint/project.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `project.ts`**

按 spec §8.1/§8.2 映射表实现纯函数。H3 的 `what` 组装：`beat + 景别/运镜 + 动作 + continuity 锚点首句 + soft 负向改写末句`（复用 `dialect/h3.js` 的 `buildShotLines` 不适用——本函数直接产 `H3ShotsInput`，让现有 compileH3 继续做时间戳/字段渲染）。`projectAdvisories` 导出为独立模块级数组（每次投影重置）或随返回值——采用**返回值**：`projectToH3` 返回 `{ shots: H3ShotsInput; advisories: string[] }`？——注意保持签名简单：`projectToH3` 返回 `H3ShotsInput`，soft 负向改写已内嵌进 `what`；advisory 文案通过导出的 `lastProjectAdvisories(): string[]` 读取（内部数组，投影时清空）。测试只断言主签名。

- [ ] **Step 4: 跑测试确认通过 + 用投影产物跑现有 golden（兼容性验证）+ 投影器快照**

Run: `npx vitest run tests/pe-framework/blueprint/project.test.ts tests/fidelity/golden-integrity.test.ts`
Expected: 新用例 PASS；golden 完整性测试不受影响。
同时在 `project.test.ts` 加**投影快照回归**（spec §8.3 防漂移）：`expect(JSON.stringify(projectToH3(fightBp))).toMatchSnapshot()`——首次跑生成快照，之后每次变更需显式 `vitest -u` 更新，防止投影映射意外漂移。

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/blueprint/project.ts tests/pe-framework/blueprint/project.test.ts
git commit -m "feat(prompt-master): blueprint → dialect projector with negative tiers + continuity lock (spec §8)"
```

---

### Task 9: 意图分析器升级（意图 → 蓝图 v0 + missing + 澄清接口）

**Files:**
- Create: `src/pe-framework/blueprint/analyzer.ts`
- Modify: `src/pe-framework/intent/subagent-provider.ts`（蓝图 persona/schema）
- Test: `tests/pe-framework/blueprint/analyzer.test.ts`（新建）

**Interfaces:**
- Consumes: `createSubagentIntentProvider`（`intent/subagent-provider.js`）、`BlueprintV1`/`validateBlueprint`（Task 2）。
- Produces:
  - `const BLUEPRINT_PERSONA: string`（spec §6 规则文本：产出蓝图 v0、保留事实、标记 missing、多模态标签稳定）
  - `const BLUEPRINT_SCHEMA: string`（蓝图 JSON 骨架 + 输出规则）
  - `function analyzeIntent(ctx, route, input: string, opts: { refs?: unknown[]; clarify?: 'ask'|'auto' }): Promise<{ blueprint: BlueprintV1; missing: string[]; clarify_questions?: string[] }>` —— 经子代理产出蓝图 JSON → `validateBlueprint` 校验 → 计算 `missing`（为空字段/未填充维度）→ `clarify:'ask'` 且有关键缺失时返回 `clarify_questions`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pe-framework/blueprint/analyzer.test.ts
import { describe, expect, it } from 'vitest'
import { analyzeIntent } from '../../../src/pe-framework/blueprint/analyzer.js'
import { textStream } from '../../plugin/helpers.js'

const v0Json = JSON.stringify({
  schema_version: 1, media: 'video',
  core: { concept: '打斗 CG 动画', negative: [] },
  media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
})

describe('analyzeIntent', () => {
  it('returns validated blueprint + missing list', async () => {
    const ctx = { llm: { async *stream() { for (const c of textStream(v0Json)) yield c } } } as any
    const r = await analyzeIntent(ctx, { provider: 'p', model: 'm' }, '三镜头打斗CG', { clarify: 'auto' })
    expect(r.blueprint.media).toBe('video')
    expect(Array.isArray(r.missing)).toBe(true)
    expect(r.clarify_questions).toBeUndefined()
  })
  it('clarify=ask with missing key dims returns clarify_questions', async () => {
    const ctx = { llm: { async *stream() { for (const c of textStream(v0Json)) yield c } } } as any
    const r = await analyzeIntent(ctx, { provider: 'p', model: 'm' }, '一个场景', { clarify: 'ask' })
    // v0Json 无 style → 关键缺失 → 产出澄清问题
    expect(r.clarify_questions?.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/pe-framework/blueprint/analyzer.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `analyzer.ts` + 蓝图 persona/schema**

复用 `createSubagentIntentProvider(ctx)` 的 one-shot 子代理 seam（继承父路由）；`analyzeIntent` 内部构造 `AuthorIntentRequest` 形状（`{target:'h3', input, persona: BLUEPRINT_PERSONA, schema: BLUEPRINT_SCHEMA, round:0}`）调 provider → 取文本 JSON → `validateBlueprint` → 计算 missing（spec §6：关键维度 = style/media/negative 边界；次要 = 光影/构图/细节）→ `clarify:'ask'` 且有关键缺失时把缺失映射为 `clarify_questions`（每个问题 = 「缺少 <维度>：请选择/补充」）→ **调用 `checkFidelity(input, blueprint)` 把丢失实体并入 `missing`**（保真守卫，spec §6）→ 返回。

- [ ] **Step 4: 跑测试确认通过 + 现有 intent 测试不回归**

Run: `npx vitest run tests/pe-framework/blueprint/analyzer.test.ts tests/pe-framework/intent/subagent-provider.test.ts`
Expected: 新用例 PASS；现有子代理 provider 测试全绿（BLUEPRINT_* 为新增导出，不改 DEFAULT_*）。

- [ ] **Step 5: Commit**

```bash
git add src/pe-framework/blueprint/analyzer.ts src/pe-framework/intent/subagent-provider.ts tests/pe-framework/blueprint/analyzer.test.ts
git commit -m "feat(prompt-master): intent analyzer → blueprint v0 with missing/clarify (spec §6)"
```

---

### Task 10: `prompt_author` 接入蓝图管线 + 三级增量修正

**Files:**
- Modify: `src/tools/prompt-author.ts`
- Modify: `src/pe-framework/blueprint/project.ts`（导出增量修正辅助）
- Test: `tests/plugin/author-blueprint.e2e.test.ts`（新建）

**Interfaces:**
- Consumes: `analyzeIntent`（Task 9）、`enrichBlueprint`（Task 7）、`projectToH3`/`projectToAnima`（Task 8）、`computeNextAction`（Task 3）、现有 `runDraftThroughStage`。
- Produces: `prompt_author` 新参数 `style_id?: string`、`conformity?: number`、`clarify?: 'ask'|'auto'`、`blueprint_id?: string`（**增量修改入口**：传蓝图 id 时跳过 analyzeIntent，从 repo load 蓝图直接走扩展→投影，实现「取回旧蓝图改一字段重投影」）；execute 流程改为：`(analyzeIntent 或 repo.load) → enrichBlueprint → project → runStage → 三级修正`：
  - **Level 1 确定性预修**（零 LLM）：`projectToH3` 前用 `getDialectPackage('h3').constraints` 对 `total_duration_seconds`/shots 数做合法化（duration 越界→取最近合法值并记 `repair_hints`；shots 超 `max_shots`→建议合并/加时长）。纯函数 `preflightRepair(bp): { bp: BlueprintV1; repairs: string[] }`（放 `project.ts`）。Level 1 触发修复 → `repaired = true`。
  - **Level 2 LLM 结构化修复**（≤1 次）：runStage 后 critical 仍在 → 用 `analyzeIntent` 同一 provider 传结构化 findings（`{gates:[{rule,severity,field,position,fix}]}`）让 LLM 只改蓝图失败字段 → 重投影 → 重 runStage。Level 2 触发 → `repaired = true`。
  - **Level 3**：仍失败 → `next_action='manual'` + `loop_exhausted:true` advisory。
  - **修正轮次语义（澄清）**：`MAX_CORRECTIONS=2` 保留为「总修正尝试上限」（Level 1 确定性预修不计入——它零 LLM 且必然收敛；Level 2 LLM 修复计入，最多 2 次尝试）；Level 2 实际执行次数 ≤2，超出走 Level 3。
  - Envelope 带 `next_action`、`repair_hints`、`observability.expansions`、`observability.repairs`。

- [ ] **Step 1: 写失败测试（注入 provider 的 e2e）**

```ts
// tests/plugin/author-blueprint.e2e.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { registerAuthorTool, setAuthorIntentProvider } from '../../src/tools/prompt-author.js'
import { createBlueprintRepo } from '../../src/pe-framework/blueprint/repo.js'
import { stubCtx, runTool, textStream } from './helpers.js'
import type { AuthorIntentFn } from '../../src/tools/prompt-author.js'

// 注入蓝图 provider：第一轮产出 v0，后续轮只补 duration
const fakeProvider: AuthorIntentFn = async (req: any) => {
  if (req.round === 0) return {
    blueprint: {
      schema_version: 1, media: 'video',
      core: { concept: '三镜头打斗CG', negative: [] },
      media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
    } as any, missing: ['style'],
  }
  return {} as any
}

describe('prompt_author blueprint pipeline', () => {
  beforeEach(() => setAuthorIntentProvider(fakeProvider as any))
  afterEach(() => setAuthorIntentProvider(null))

  it('runs analyze→enrich→project→stage and returns ok envelope with next_action', async () => {
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', input: '三镜头打斗CG', style_id: 'cinematic_real' })))
    expect(v.next_action).toBeDefined()
    expect(v.audit).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin/author-blueprint.e2e.test.ts`
Expected: FAIL——`prompt_author` 尚未接受 `blueprint` 形状的 intent 产出（现有 `normalizeDraftToInput` 只认 slots/shots）。

- [ ] **Step 3: 实现蓝图管线接入**

在 `prompt-author.ts`：`AuthorDraft` 扩展可选 `blueprint?: BlueprintV1` + `missing?: string[]`；`normalizeDraftToInput` 增加 `blueprint` 分支（先 `enrichBlueprint` 再 `projectTo*`）；`execute` 参数加 `style_id/conformity/clarify/blueprint_id`；`blueprint_id` 传入时从 repo `load` 蓝图、跳过 `analyzeIntent`；三级修正循环替代现有 `while` 修正（修正轮次语义见上——Level 1 不计入 MAX_CORRECTIONS，Level 2 ≤2 次）；`preflightRepair` 在投影前调用并收集 `repair_hints`；`repaired` 在 Level 1/2 任一触发时置 true 传给 `computeNextAction`。Envelope 组装含 `next_action`（Task 3）与 `observability.expansions/repairs`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run tests/plugin/author-blueprint.e2e.test.ts tests/plugin/author-e2e.test.ts tests/plugin/author-shell.test.ts`
Expected: 新用例 PASS；现有 author e2e/shell 全绿（旧 `slots`/`shots` 直传路径保留向后兼容——`AuthorDraft.blueprint` 缺省时走原逻辑）。

在 `author-blueprint.e2e.test.ts` 增加**增量修改用例**（spec §5.3 交付标准 6）：
```ts
// 预存蓝图到 repo（stub settings 作为 repo 后端），再传 blueprint_id 走增量路径
function settingsRepo() {
  const store: Record<string, string> = {}
  return {
    settings: {
      get: () => ({ ...store }),
      async update(p: Record<string, string>) { Object.assign(store, p) },
      async replace(s: Record<string, string>) { Object.assign(store, s) },
    },
  }
}

describe('prompt_author blueprint_id incremental path', () => {
  it('reload by blueprint_id skips analyzeIntent (provider not called)', async () => {
    const { settings } = settingsRepo()
    const repo = createBlueprintRepo({ settings } as any)
    repo.save('fight-15s', {
      schema_version: 1, media: 'video',
      core: { concept: '三镜头打斗CG', aspect_ratio: '9:16', negative: [] },
      media_layer: { video: { total_duration_seconds: 15, shots: [{ beat: '对峙' }, { beat: '交锋' }, { beat: '决胜' }] } },
    } as any)

    let providerCalls = 0
    const countingProvider: AuthorIntentFn = async (req: any) => { providerCalls++; return {} as any }
    setAuthorIntentProvider(countingProvider as any)

    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') }) as any
    ctx.settings = settings
    const def = registerAuthorTool(ctx, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', blueprint_id: 'fight-15s' })))

    expect(providerCalls).toBe(0)              // 跳过 analyzeIntent
    expect(v.next_action).toBeDefined()
    setAuthorIntentProvider(null)
  })
})
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/prompt-author.ts src/pe-framework/blueprint/project.ts tests/plugin/author-blueprint.e2e.test.ts
git commit -m "feat(prompt-master): prompt_author blueprint pipeline + 3-tier incremental repair + next_action (spec §4 §12 §15)"
```

---

### Task 11: 契约级 eval 回归集（事故案例 + 中文多分镜）

**Files:**
- Create: `tests/eval/blueprint-eval.test.ts`
- Create: `tests/eval/fixtures/fight-cg-intent.json`

**Interfaces:**
- Consumes: 全链（analyze→enrich→project→runStage），`setAuthorIntentProvider` 注入。
- Produces: eval 集成测试——用上次会话同款用户输入「3 个分镜×5 秒打斗 CG」，断言：
  1. 无 CJK `shot_execution` 误报（gates 里该 rule 缺席或非 critical）
  2. `duration_seconds` 语义正确（=15 总时长，3 shots 通过 max_shots）
  3. `next_action` 非 `manual`（可自动完成）
  4. LLM provider 调用 ≤3 次（stub 计数）

- [ ] **Step 1: 写 eval 测试**

```ts
// tests/eval/blueprint-eval.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { registerAuthorTool, setAuthorIntentProvider } from '../../src/tools/prompt-author.js'
import { stubCtx, runTool } from '../plugin/helpers.js'
import type { AuthorIntentFn } from '../../src/tools/prompt-author.js'
import fightIntent from './fixtures/fight-cg-intent.json'

let calls = 0
const fakeProvider: AuthorIntentFn = async (req: any) => {
  calls++
  if (req.round === 0) return { blueprint: (fightIntent as any).v0, missing: ['style'] }
  return { blueprint: (fightIntent as any).v0, missing: [] }
}

describe('eval: fight CG case (session-34706f38 regression)', () => {
  beforeEach(() => { calls = 0; setAuthorIntentProvider(fakeProvider as any) })
  afterEach(() => { setAuthorIntentProvider(null) })

  it('completes with no CJK false positive, correct duration, non-manual next_action, ≤3 LLM calls', async () => {
    const ctx = stubCtx({ stream: textStream('{"set":{},"additions":{},"expansions":[]}') })
    const def = registerAuthorTool(ctx as any, { temperature: 0.7 })
    const v = JSON.parse(String(await runTool(ctx, def, { target: 'h3', input: '3个分镜每个5秒的打斗CG动画', style_id: 'cinematic_real' })))
    const shotExec = v.audit.gates.filter((g: any) => g.rule === 'shot_execution')
    expect(shotExec.every((g: any) => g.severity !== 'critical')).toBe(true)
    expect(v.next_action).not.toBe('manual')
    expect(calls).toBeLessThanOrEqual(3)
  })
})
```

`tests/eval/fixtures/fight-cg-intent.json`：`{"v0": {"schema_version":1,"media":"video","core":{"concept":"电影写实级 CG 打斗动画：冷兵器刀剑对决","aspect_ratio":"16:9","negative":[],"characters":[{"id":"c1","name":"青年武者","appearance_anchors":["黑发","深色布衣","长刀"]},{"id":"c2","name":"银发剑客","appearance_anchors":["银白长发","灰色披风","反手持刀"]}]},"media_layer":{"video":{"total_duration_seconds":15,"shots":[{"beat":"对峙","who":["c1","c2"]},{"beat":"交锋","who":["c1","c2"]},{"beat":"决胜","who":["c1"]}]}}}`

- [ ] **Step 2: 跑测试——初始可能 FAIL（见 Step 3 说明）**

Run: `npx vitest run tests/eval/blueprint-eval.test.ts`
Expected: 依赖 Task 10 完成；Task 10 后运行应为 PASS。若因 enrichment mock 返回空 patch 导致投影 `what` 不完整而审计失败，检查 `fixtures` 的 `v0` 是否满足「每个 shot 的 what 由投影器从 beat 组装出非空正文」——投影器需保证 `what` 非空（beat 兜底）。

- [ ] **Step 3: 调整 fixture / 投影器保证通过**

确保投影器在 `action` 为空时用 `beat` 作为 `what` 正文兜底（Task 8 实现时即含此逻辑）。跑 `npx vitest run tests/eval/blueprint-eval.test.ts` → PASS。

- [ ] **Step 4: Commit**

```bash
git add tests/eval/blueprint-eval.test.ts tests/eval/fixtures/fight-cg-intent.json
git commit -m "test(prompt-master): blueprint eval regression — fight CG case, CJK no false positive, ≤3 LLM calls (spec §13 §17)"
```

---

### Task 12: 工具路由收敛 + persona/duration 显式化 + AGENTS.md 联动

**Files:**
- Modify: `src/tools/prompt-author.ts`（description 更新：全链入口 + 新参数说明）
- Modify: `src/pe-framework/blueprint/analyzer.ts`（persona 文本补 duration 语义）
- Modify: `src/tools/prompt-compile.ts`（description 注明 preflight_only 用法）
- Modify: `AGENTS.md`（错误恢复表更新为读 `next_action`；H3 prompt 路由说明「3 镜×5s → 传总时长 15」）
- Test: `tests/plugin/author-shell.test.ts`（补充 description 断言，防漂移）

**Interfaces:**
- Consumes: 无新模块。
- Produces: 工具描述与 persona 中的 duration 语义显式化（spec §5.2-1「三处显式化」）、AGENTS.md 错误恢复快速表新增 `next_action` 列。

- [ ] **Step 1: 更新 `prompt_author` description（含 duration 语义 + 新参数）**

`description` 追加：`创作蓝图流水线：分析意图→美学扩展→方言投影→审计；h3 的 duration_seconds 指视频总时长（如 3 个 5 秒分镜请传总时长 15，shots 数 ≤ max_shots）。可选 style_id/conformity/clarify。失败时读取 next_action 决定重试/人工。`

- [ ] **Step 2: persona 文本补 duration 语义**

`BLUEPRINT_PERSONA` 规则追加：`4. 蓝图 media_layer.video.total_duration_seconds 指视频总时长（官方契约 4–15s），不是每镜时长；用户说「3 个分镜每个 5 秒」→ total=15，shots=3。`

- [ ] **Step 3: `prompt_compile` description 注明 preflight_only**

`description` 追加：`preflight_only=true 时不编译，仅做方言约束校验（零 LLM），用于先验边界再投 prompt_author。`

- [ ] **Step 3b: intent 子代理瘦身（spec §14）**

在 `src/pe-framework/intent/subagent-provider.ts` 的 `createSubagentIntentProvider` 中：蓝图模式（`AuthorIntentRequest` 带 `blueprint` 目标）时，注入**最小 system**——去掉技能目录/工具说明噪音（子代理 trace 显示它曾纠结「要不要调 skill」），system 只含：`你是一个创作蓝图分析引擎。只输出 JSON，不要调用任何工具，不要输出任何解释。` 实现为 `BLUEPRINT_SUBAGENT_SYSTEM` 常量，蓝图请求走它、旧 slots/shots 请求走原 persona（向后兼容）。断言：新增 `tests/pe-framework/intent/slim-system.test.ts` 检查 `BLUEPRINT_SUBAGENT_SYSTEM` 不含 `skill`/`tool` 关键词。

- [ ] **Step 4: 更新 `AGENTS.md` 错误恢复快速表**

`audit critical gates` 行更新为：`看 Envelope 的 next_action：retry_input→按 repair_hints 改入参；auto_repair→引擎已修，检查 observability.repairs；manual→人工接手（loop_exhausted）。`

- [ ] **Step 5: 补 description 防漂移断言**

在 `tests/plugin/author-shell.test.ts` 增加：`expect(def.description).toContain('total')`（或改为 `toContain('总时长')`，按最终文案）。

- [ ] **Step 6: 全量回归 + commit**

Run: `npx vitest run`
Expected: 全部 PASS（含 12 个任务新增测试 + 既有 golden/parity 全绿）。
Commit:
```bash
git add src/tools/prompt-author.ts src/pe-framework/blueprint/analyzer.ts src/tools/prompt-compile.ts src/pe-framework/intent/subagent-provider.ts AGENTS.md tests/plugin/author-shell.test.ts tests/pe-framework/intent/slim-system.test.ts
git commit -m "docs(prompt-master): tool routing + duration semantics explicit + intent subagent slim system + AGENTS.md next_action linkage (spec §14 §5.2)"
```

---

## Self-Review（计划 vs spec）

**Spec 覆盖检查**：
- §5 蓝图 schema/校验 → Task 2 ✅
- §5.2-1 duration 显式化 → Task 12 ✅；§5.2-3 负向三档 → Task 8 ✅；§5.2-5 角色引用解析 → Task 8 ✅；§5.2-6 保真-扩展边界 → Task 7（expansions 审计）+ Task 9（保真守卫在 analyzeIntent 内）✅
- §6 意图分析器/澄清 → Task 9 ✅
- §7 扩展引擎/风格库/conformity → Task 6 + Task 7 ✅
- §8 投影器 → Task 8 ✅
- §9 方言包/preflight → Task 4 + Task 5 ✅
- §10 审计语义分层 + CJK → Task 1 ✅
- §11 Envelope next_action → Task 3 ✅
- §12 三级增量修正 → Task 10 ✅
- §13 eval → Task 11 + Task 7 check ✅
- §14 工具面收敛 → Task 12 ✅
- §15 LLM 预算 → Task 10（Level 2 限 1 次）+ Task 11 断言 ≤3 ✅
- §16 测试策略 → 各任务 TDD + Task 11 eval ✅
- §17 Phase 1 交付标准 → Task 10 交付标准 1-4、Task 11 验证、Task 6 交付标准 5（风格库）、Task 6 repo 交付标准 6（蓝图存储）✅

**占位符扫描**：无 TBD/TODO；所有代码步骤含真实代码。✅
**类型一致性**：`BlueprintV1`/`Character`/`Shot`/`NegativeConstraint`/`H3ShotsInput`/`AnimaSlots` 在各任务间签名一致；`computeNextAction`、`getDialectPackage`、`analyzeIntent`、`enrichBlueprint`、`projectToH3`、`preflightRepair` 均有定义任务与消费任务匹配。✅

**二轮自审修复记录**（对照用户「是否有遗漏和不明确」逐项补齐）：
- 保真守卫 `checkFidelity` → Task 7（新测试 fidelity.test.ts）+ Task 9（analyzeIntent 调用）✅
- 电影摄影词库 `CINEMA_LEXICON` → Task 7（新文件 lexicon.ts + 测试）✅
- 增量修改工作流 `blueprint_id` 路径 → Task 6 repo 用例 + Task 10 e2e 用例 ✅
- 语言策略定案（蓝图语言跟随方言 output_lang，投影器零翻译）→ spec §5.2-4 + Task 8 签名去掉 lang 参数 ✅
- `computeNextAction` auto_repair 死分支 → 改为 `opts.repaired` 事实驱动（Task 3 测试同步）✅
- intent 子代理瘦身 `BLUEPRINT_SUBAGENT_SYSTEM` → Task 12 Step 3b + slim-system.test.ts ✅
- 修正轮次语义澄清（Level 1 不计入、Level 2 ≤2、MAX_CORRECTIONS=2 为总上限）→ Task 10 ✅
- contractGatesH3 落点（薄封装不迁移）→ Task 4 澄清 ✅
- 投影器快照回归 → Task 8 Step 4（toMatchSnapshot）✅

## 执行观察项（Phase 1 进行中，成员上报记录）

> 本节仅记录执行期发现，**不改变已批准的任务语义**；每项在 Phase 1 收尾时评估。

| # | 观察项 | 来源 | 处置建议 |
|---|---|---|---|
| O1 | 计划 Task 1 将整条 `shot_execution` rule 降级 important，使确定性的「空镜内容」判定（空 what）也变非阻断——spec §10 语义/确定性分层的粒度取舍 | reviewer t13 | 后续计划修订时评估：把「空镜内容」确定性子类拆回 critical（独立 gate），语义「无新信息」子类保持 important |
| O2 | 全量 vitest 有 3 个既有失败（anima-catalog / anima-compile / catalog-search 的 overlay-status 断言，期望 'unavailable' 得 'available'），**双重独立证实与本次实现无关**（engineer stash 对照 + reviewer 导入图分析：3 测试均不 import 本次改动文件） | engineer t1 + reviewer t13 | 属既有测试基建/路径注入残留问题，Phase 1 收尾后单独排查（不在本计划范围） |
| O3 | Task 1 测试示例 `zhShots` 字符串闭合引号笔误（反引号），engineer 按唯一可行解读修正为单引号，计划文档已同步修正 | engineer t1 | 已修复（commit 7f13393），后续任务引用示例时以修正后为准 |
| O4 | 计划 Task 3 Files 的「Modify prompt-compile.ts（merge extraGates 后重算 next_action）」接线在 t3 契约中被排除（避免与 t5 in-scope 冲突），且 t5 原契约仅覆盖 preflight 分支、t10 仅覆盖 author → normal 编译路径 Envelope 一度无 next_action（assembleEnvelope L96 仅在 nextAction 传入时输出该字段） | engineer t3 范围问题 | 已指派 t5 顺带完成：stageToEnvelope 内调 computeNextAction(stage) 传第 5 参（anima/h3 双路径），compile-preflight.test.ts 加 normal 路径用例 |
| O5 | 计划 Task 2 自带 4 用例未覆盖 validateBlueprint 的 media 非法值、video.shots 空数组两条校验规则（计划级测试缺口） | reviewer t14 | Phase 1 收尾时补这两条测试（非阻断，校验逻辑本身已实现且正确） |
| O6 | contractGatesH3 将「shots 超 max_shots」标为 rule='parse_request'（contracts.py parseRequest 族名），与计划 Task 5 验收期望的 rule='max_shots' 不一致；engineer 在 preflight 分支做最小归一化（detail 含 'exceed the maximum' 的 parse_request → max_shots），不改 contractGatesH3（其被 dialect/h3.ts + prompt-audit.ts 消费，改动会触发计划外连锁变更） | engineer t5 + captain 裁决 | **captain 已裁决接受**：归一化满足计划验收、对齐 ruleForMessage 命名、匹配条件精确（仅 shots 超限类）、最小可逆；记入观察项供 Phase 1 收尾评估是否统一 contractGatesH3 标签 |
| O7 | t6（commit b3bc533）跨 in-scope 修改 t2 的 schema.ts：core.characters/scene/style/emotion/composition 改可选（negative 保持必填）。**captain 已裁决接受**：spec §6「蓝图字段可空+缺失标记」与 §5.1 注释「可空」支持，且计划 Task 6 fixture 只给 {concept, negative} 与严格接口冲突（TS2740）属计划内部不一致，放宽是最小忠实修正、宽松方向 t7-t10 零破坏。注意：t14 已审查 schema 的必填版，本变更后 schema 最终形态需 t18 顺带复核 | engineer t6 + captain 裁决 | t18 审查时顺带复核可选化与 spec §6 一致（negative 仍必填）；t7-t10 fixture 需与可选化兼容 |
| O8 | spec §8.1 映射表要求 emotion 表达（core.emotion）进 H3 输出，但投影器 what 组装（计划 Step 3）不含 emotion → emotion 无 H3 投影路径（spec/计划映射空白） | reviewer t19 | **已修复**（commit e1a15dc，captain 验收审计发现 A）：projectToH3 的 what 组装按 spec §8.1 ROI 顺序补入 scene.lighting（高 ROI）+ emotion（低 ROI），新增测试 + 快照更新；同时补了 scene.lighting 在 H3 侧此前同样丢失的问题 |
| O9 | spec §8.1 映射表 `media_layer.video.audio → overall_soundscape`：投影器仅映射 audio_focus→ambient，未处理 video.audio 全局声景（投影层丢弃；compileH3 的 soundscapeOf 只从 shots[].ambient 派生） | reviewer t19 | 指派 t10：把 media_layer.video.audio 并入首镜 ambient（无首镜时丢弃并记 advisory），使全局声景经 compileH3 派生进入 overall_soundscape，满足 spec §8.1 |
| O10 | enrichBlueprint 内 checkFidelity 以 v0.core.concept 为原文参照（计划签名无用户原文参数所致）——原文代理弱于用户原始描述 | reviewer t20 | Phase 1 收尾评估：t10 若可传用户原文给 fidelity 可强化保真检查（当前 v0.concept 已含用户原词压缩，代理可接受） |
| O11 | 计划 Task 7 词库示例 grading 每类仅 3 词，而计划自带测试要求每类 ≥4——engineer 按 spec §7.3 词表补齐至 ≥4（ECU/ELS/50mm/侧逆光/色温/高光暖调/阴影冷调/画中画均可溯源 spec）；禁词表扩展（电影感/氛围感/唯美）在 spec §7.1「等」+ persona 例意图内。**reviewer 已裁决接受**，两处均为计划自冲突的最小忠实解法 | reviewer t20 | 已接受，无需动作（t20 PASS） |
| O12 | 计划 Task 9 Step 3 要求 analyzeIntent 经 createSubagentIntentProvider 子代理 seam 调 provider 并 Modify subagent-provider.ts（蓝图 persona/schema），但测试（Step 1）用无 subagents 的 {llm:{stream}} stub ctx——测试与实现指示自相矛盾。engineer 实现走 complete(ctx.llm.stream)（BLUEPRINT_* 在 analyzer.ts 导出），**captain 已裁决接受**（忠实测试形态、功能目标达成）。但 subagent-provider.ts 蓝图分支存在真实缺口（parseIntentJson 仅认 anima/h3，blueprint target 会 throw「未知 target」），已并入 Task 12 Step 3b 补充职责：蓝图模式走 BLUEPRINT_SUBAGENT_SYSTEM + 产出 blueprint + 新旧请求兼容测试 | engineer t9 + captain 裁决 | t12 落实蓝图分支；t21 审查基准需知（engineer 的 complete 路径非偏离） |
| O13 | t22 F2（clarify 参数）修复后：AuthorIntentRequest.clarify + intentBase 透传已接通（参数抵达 intent 层、analyzer 消费逻辑就绪），但生产 provider（subagent 蓝图模式 / defaultIntent）均未读 req.clarify 产出 clarify_questions（grep 证实）——属计划 Task 9/12 未明示的延伸，**captain 裁决选 A**（接受 Phase 1 管道接通） | reviewer t26 | Phase 1 收尾评估：Phase 2 在 subagent 蓝图模式接 req.clarify → analyzeIntent opts.clarify 产出 clarify_questions 端到端闭环 |

## 执行交接

Plan 保存于 `docs/2026-09-07-blueprint-ir-implementation.md`。两种执行方式：

**1. Subagent-Driven（推荐）** —— 每任务派一个全新子代理，任务间评审，快速迭代
**2. Inline Execution** —— 本会话按 executing-plans 批量执行，检查点评审

选哪种？
