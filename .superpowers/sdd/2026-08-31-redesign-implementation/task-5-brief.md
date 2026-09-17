# Task 5 Brief: anima / h3 注册为方言模块（normalize 收敛重复）

## 背景
方案 A 第 5 个任务：把现有 anima/h3 的编译/审计能力包装成 `DialectContract` 注册进注册表（Task 3），并把散落在 3 个工具里的 `inferH3Stage`/`toRefs`/`toReferences` 收敛为 `normalizeH3Input` 单点 + 新增 `validateAnimaSlots`。Task 4 的 `runStage` 已就绪。**本任务不改 tools/*.ts**（那是 Task 6）——只建方言侧 + plugin/index.ts 顶部 import 副作用注册。

## 工作目录
`C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\plugins\prompt-master`

## 全局约束
- 测试 `npx vitest run <file>`；构建 `npm run build`；git 根 `C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin`
- 纯函数零日志
- **不能破坏现有导出**：compileAnima/auditAnima（anima.ts）、compileH3（h3.ts）、auditH3Full/contractGatesH3（rules-h3.ts）等被 Task 6 前的工具使用，签名不动
- 注册用 Task 3 接口：`registerDialect(contract)`；重复注册 throw（plugin/index.ts 只 import 一次，无风险；但测试里 `__resetDialectsForTests()` 后重新 register）

## Files
- Modify: `src/pe-framework/intent/subagent-provider.ts`（拆 per-target persona/schema 常量，DEFAULT_* 保留兜底）
- Modify: `src/pe-framework/dialect/anima.ts`（新增 validateAnimaSlots + registerAnimaDialect + ANIMA_PERSONA/ANIMA_SCHEMA）
- Modify: `src/pe-framework/dialect/h3.ts`（新增 normalizeH3Input + registerH3Dialect + H3_PERSONA/H3_SCHEMA）
- Modify: `src/plugin/index.ts`（顶部 import 两个方言模块触发副作用注册）
- Test: `tests/pe-framework/dialect/anima-register.test.ts`、`tests/pe-framework/dialect/h3-register.test.ts`

## Consumes
- `registerDialect`/`DialectContract`/`__resetDialectsForTests`（Task 3，`./registry.js`；DialectContract 从 registry.js re-export 或 contract.js 直接 import 均可）
- 现有：`compileAnima`/`auditAnima`（anima.ts 内）、`compileH3`（h3.ts 内）、`auditH3Full`/`contractGatesH3`（`../audit/rules-h3.js`）、`buildH3Budget`（`../audit/budget.js`）、`AnimaSlots`（anima.ts）、`H3ShotsInput`/`Reference`（`../schema/h3-shots.js`）
- runStage 的调用约定（Task 4）：`d.normalize(input, {stage, scenarioId, formFields})` → `{error?, value?, stage?, references?}`；`d.compile(value, {variant, stage})`；`d.audit(compiled, {stage, references, shots, variant})`；`d.budget?(compiled, {stage, references})`

## Step A: 拆分 intent 常量（subagent-provider.ts）

现状 L174 `DEFAULT_PERSONA`（含 anima/h3 两条规则的统一 persona）与 L187 `DEFAULT_SCHEMA`（含 anima/h3 两段 JSON）。拆分：
```ts
// 顶部（模块内可见即可，不必导出给外部——方言文件 import 它们）
export const ANIMA_PERSONA = `…原 DEFAULT_PERSONA 中 target=anima 相关的规则文本…`
export const H3_PERSONA = `…target=h3 相关规则文本…`
export const ANIMA_SCHEMA = `…原 DEFAULT_SCHEMA 的 "anima" 键整段…`
export const H3_SCHEMA = `…原 DEFAULT_SCHEMA 的 "h3" 键整段…`
// DEFAULT_PERSONA/DEFAULT_SCHEMA 保留原值（兜底路径 subagentIntent 的 opts.persona ?? DEFAULT 不变）
```
拆分原则：语义等价——ANIMA_PERSONA = 原 persona 里"若 target=anima 产出 slots"的规则 + 公共规则；H3 同理。**DEFAULT_* 不删**（现有 subagent-provider 测试依赖其行为）。

## Step B: h3.ts 新增 normalizeH3Input + registerH3Dialect

```ts
import { registerDialect } from './registry.js'
import { contractGatesH3, auditH3Full } from '../audit/rules-h3.js'
import { buildH3Budget } from '../audit/budget.js'
import type { H3ShotsInput, Reference } from '../schema/h3-shots.js'
import type { DialectContract } from './contract.js'
import { H3_PERSONA, H3_SCHEMA } from '../intent/subagent-provider.js'

/** stage 推断 + references 规范化（从 prompt-author.ts inferH3Stage/toRefs 与 prompt-compile.ts 收敛；Task 6 删除工具侧副本） */
export function normalizeH3Input(
  input: unknown,
  opts: { stage?: string; scenarioId?: string; formFields?: unknown },
): { error?: string; value?: H3ShotsInput; stage?: string; references?: Reference[] } {
  const shots = (input as { shots?: H3ShotsInput } | undefined)?.shots
  if (!shots || !Array.isArray(shots.shots) || shots.shots.length === 0) {
    return { error: 'intent 未产出 shots 结构' }
  }
  const formRefs = Array.isArray((opts.formFields as Record<string, unknown> | undefined)?.references)
    ? ((opts.formFields as Record<string, unknown>).references as unknown[]) : []
  const refs = Array.isArray(shots.references) ? shots.references : []
  const references = (refs.length > 0 ? refs : formRefs) as Reference[]
  // 优先级与现 prompt-author.ts inferH3Stage 一致：显式 stage > references 存在 > scenarioId==='full_reference' > t2va
  const stage = opts.stage || (references.length > 0 ? 'ref2va' : opts.scenarioId === 'full_reference' ? 'ref2va' : 't2va')
  return { value: shots, stage, references }
}

export function registerH3Dialect(): void {
  const contract: DialectContract<H3ShotsInput, { text: string; text_zh: string }> = {
    id: 'h3',
    label: 'MiniMax-H3',
    auditOnlyOk: true,
    normalize: (input, opts) => normalizeH3Input(input, opts),
    compile: (shots, opts) => compileH3(shots, { stage: (opts.stage as 't2va' | 'ref2va') ?? 't2va' }),
    audit: (compiled, ctx) => {
      const stage = ctx.stage as 't2va' | 'ref2va'
      const shots = ctx.shots as H3ShotsInput
      const gates = [
        ...contractGatesH3(stage, shots, ctx.references ?? []),
        ...auditH3Full(compiled.text, { stage, duration: shots.duration_seconds, shotCount: shots.shots.length }, ctx.references),
      ]
      return { gates, assumptions: [] }
    },
    budget: (compiled, ctx) => buildH3Budget(ctx.stage as string, compiled.text, ctx.references ?? []),
    targetSlotHint: 't2v.prompt',
    intent: { persona: H3_PERSONA, schema: H3_SCHEMA },
  }
  registerDialect(contract)
}
```
> **read 核实**现有 `compileH3` 签名（可能 `{stage}` 更宽）、`contractGatesH3(stage, shots, references)`、`auditH3Full(text, {stage,duration,shotCount}, references)`、`buildH3Budget(stage, text, refs)` 的实际参数——以现有签名为准适配（勿改它们的签名）。`toRefs` 的宽高数字规范化逻辑在现 prompt-author.ts（`width/height` 取 number 否则 null）——normalizeH3Input 里 references 若需同样规范化，把该映射搬进来（read 现 prompt-author.ts `toRefs` 对齐）。

## Step C: anima.ts 新增 validateAnimaSlots + registerAnimaDialect

```ts
import { registerDialect } from './registry.js'
import type { DialectContract } from './contract.js'
import { ANIMA_PERSONA, ANIMA_SCHEMA } from '../intent/subagent-provider.js'

const ANIMA_SLOT_KEYS = new Set(['count_gender','character','appearance','clothing','pose_action','expression','camera','scene','detail_mood'])

/** composition.py _coerce_brief 移植：槽位键白名单 + 类型校验（narrative string、其余 string[]） */
export function validateAnimaSlots(slots: unknown): string | undefined {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'anima 需要 slots 对象'
  const s = slots as Record<string, unknown>
  for (const k of Object.keys(s)) {
    if (k === 'narrative') { if (typeof s[k] !== 'string') return 'narrative 需为 string'; continue }
    if (!ANIMA_SLOT_KEYS.has(k)) return `未知槽位: ${k}`
    if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== 'string')) return `槽位 ${k} 需为 string[]`
  }
  return undefined
}

export function registerAnimaDialect(): void {
  const contract: DialectContract<Record<string, unknown>, { positive: string; negative: string }> = {
    id: 'anima',
    label: 'Anima',
    auditOnlyOk: true,
    normalize: (input) => {
      const slots = (input as { slots?: Record<string, unknown> } | undefined)?.slots
      const err = validateAnimaSlots(slots)
      if (err) return { error: err }
      return { value: slots as Record<string, unknown> }
    },
    compile: (slots, opts) => {
      const variant = (opts.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
      return compileAnima(slots as AnimaSlots, { variant })
    },
    audit: (compiled, ctx) => {
      const variant = (ctx.variant as 'base' | 'aesthetic' | 'turbo') ?? 'base'
      const slots = ctx.shots as unknown as AnimaSlots   // runStage 传 norm.value 进 ctx.shots（见 Task 4 行为 4——ctx.shots = 归一化 value）
      return { gates: auditAnima(compiled.positive, compiled.negative, { variant, slots }) }
    },
    targetSlotHint: 't2i.prompt',
    intent: { persona: ANIMA_PERSONA, schema: ANIMA_SCHEMA },
  }
  registerDialect(contract)
}
```
> **关键接线核实**：read `src/pe-framework/pipeline/runStage.ts` 确认 audit ctx 传的是什么（它传 `shots: norm.value`——即归一化后的 slots）。anima.audit 需要 slots（auditAnima 的 `{variant, slots}` 签名——read 现有 auditAnima 确认）与 variant。**variant 传递链**：PipelineInput.variant → runStage 是否透传给 audit ctx？Task 4 的 runStage 实现里 audit ctx = `{stage, references, shots, variant}`——read 核实 variant 是否真的在里面；若没有，给 runStage 补 `variant: input.variant`（一行，属本任务允许的最小内核修补，报告里注明）。

## Step D: plugin/index.ts 顶部注册

```ts
// 顶部（其他 import 旁）：
import '../pe-framework/dialect/anima.js'
import '../pe-framework/dialect/h3.js'
```
两个文件底部模块级执行 `registerAnimaDialect()` / `registerH3Dialect()`（副作用）。

## Step E: 测试

```ts
// tests/pe-framework/dialect/h3-register.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
import { normalizeH3Input, registerH3Dialect } from '../../../src/pe-framework/dialect/h3.js'

describe('H3 dialect registration', () => {
  beforeEach(() => { __resetDialectsForTests(); registerH3Dialect() })

  it('registers h3 with targetSlotHint t2v.prompt and auditOnlyOk', () => {
    const d = getDialect('h3')
    expect(d?.targetSlotHint).toBe('t2v.prompt')
    expect(d?.auditOnlyOk).toBe(true)
  })

  it('normalizeH3Input infers ref2va when references present', () => {
    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }], references: [{ who: 'x', image: 'p' }] } }, {})
    expect(r.stage).toBe('ref2va')
  })

  it('normalizeH3Input infers t2va when no references', () => {
    const r = normalizeH3Input({ shots: { duration_seconds: 8, shots: [{ what: 'a' }] } }, {})
    expect(r.stage).toBe('t2va')
  })

  it('normalizeH3Input error on missing shots', () => {
    expect(normalizeH3Input({}, {})?.error).toBeTruthy()
  })
})
```
```ts
// tests/pe-framework/dialect/anima-register.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { __resetDialectsForTests, getDialect } from '../../../src/pe-framework/dialect/registry.js'
import { registerAnimaDialect, validateAnimaSlots } from '../../../src/pe-framework/dialect/anima.js'

describe('Anima dialect registration', () => {
  beforeEach(() => { __resetDialectsForTests(); registerAnimaDialect() })

  it('registers anima with targetSlotHint t2i.prompt', () => {
    expect(getDialect('anima')?.targetSlotHint).toBe('t2i.prompt')
  })

  it('validateAnimaSlots rejects unknown key', () => {
    expect(validateAnimaSlots({ bogus_key: ['x'] })).toContain('bogus_key')
  })

  it('validateAnimaSlots rejects non-string-array slot', () => {
    expect(validateAnimaSlots({ appearance: 'long hair' })).toContain('string[]')
  })

  it('validateAnimaSlots accepts valid slots', () => {
    expect(validateAnimaSlots({ count_gender: ['1girl'], narrative: '描述' })).toBeUndefined()
  })
})
```

## Step F: 验证 + 提交

1. 两测试文件 PASS
2. `npm run build` exit 0
3. 全量 `npx vitest run` 绿（293 + 8 = ~301；**特别关注** anima/h3 相关现有测试与 registry.test.ts——plugin/index.ts 若被 registry.test.ts import 会触发副作用注册，与 __resetDialectsForTests 交互需无冲突）
4. Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework plugins/prompt-master/src/plugin/index.ts plugins/prompt-master/tests/pe-framework
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): register anima/h3 dialects (normalize converges stage/references)"
```

## 验收
- 8 新测试绿；全量绿；build 0
- getDialect('anima')/getDialect('h3') 在 plugin import 后非 undefined
- normalizeH3Input/validateAnimaSlots 是唯一实现（工具侧副本 Task 6 才删，但新代码不再复制第二份）