### Task 1: B0 妯″瀷鑳藉姏鐭╅樀

**Files:**
- Create: `src/pe-framework/model-capabilities/families.ts`
- Create: `src/pe-framework/model-capabilities/capabilities.ts`
- Create: `src/pe-framework/model-capabilities/index.ts`锛坮e-export锛?- Modify: `src/tools/prompt-expand.ts`銆乣src/tools/prompt-reverse.ts`銆乣src/tools/minimax-scenario.ts`锛堟帴鍏?temperature 鍏滃簳锛?- Test: `tests/pe-framework/model-capabilities/model-capabilities.test.ts`

**Interfaces:**
- Produces:
  - `export type ModelFamily = 'deepseek' | 'glm' | 'qwen-vl' | 'qwen-text' | 'gemma' | 'openai' | 'generic'`
  - `export function inferModelFamily(provider: string, model: string): ModelFamily`
  - `export interface ModelCapabilities { family; proneToTruncation: boolean; sanitizeLevel: 'none'|'generic'; mediaTargets: ReadonlyArray<'image'|'video'|'mixed'>; lockedOutputLang?: 'zh'|'en'; defaultTemperature?: number; defaultTopP?: number }`
  - `export function getCapabilities(family: ModelFamily): ModelCapabilities`
  - `export function applyCapabilities<T extends { temperature?: number }>(caps: ModelCapabilities, params: T): T`
  - `export const FAMILY_RULES: Array<{ family: ModelFamily; modelPatterns: RegExp[]; providerPatterns?: RegExp[] }>`
  - `export const FAMILY_CAPABILITIES: Record<ModelFamily, ModelCapabilities>`

- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// tests/pe-framework/model-capabilities/model-capabilities.test.ts
import { describe, expect, it } from 'vitest'
import { inferModelFamily, getCapabilities, applyCapabilities, FAMILY_CAPABILITIES } from '../../../src/pe-framework/model-capabilities/index.js'

describe('inferModelFamily', () => {
  const cases: Array<[string, string, string]> = [
    ['deepseek-official', 'deepseek-v4-flash', 'deepseek'],
    ['deepseek-official', 'deepseek-r2', 'deepseek'],
    ['zhipu', 'glm-5.3-flash', 'glm'],
    ['zhipu', 'glm-4.5v', 'glm'],
    ['ollama', 'qwen3-vl-8b-instruct', 'qwen-vl'],
    ['ollama', 'Qwen3-VL-8B', 'qwen-vl'],           // 澶у皬鍐?杩炲瓧绗﹀彉浣?    ['openai', 'qwen3.5-27b', 'qwen-text'],          // qwen 闈?vl 鈫?qwen-text
    ['ollama', 'gemma4-12b', 'gemma'],
    ['openai', 'gpt-5', 'openai'],
    ['unknown-provider', 'mystery-model-9000', 'generic'],
    ['ollama', 'llama3', 'generic'],                 // 鏈敞鍐屽鏃?鈫?generic
  ]
  for (const [provider, model, expected] of cases) {
    it(`infer(${provider}, ${model}) 鈫?${expected}`, () => {
      expect(inferModelFamily(provider, model)).toBe(expected)
    })
  }
})

describe('capabilities table', () => {
  it('every family has a capabilities entry', () => {
    for (const family of Object.keys(FAMILY_CAPABILITIES)) {
      expect(FAMILY_CAPABILITIES[family as keyof typeof FAMILY_CAPABILITIES]).toBeTruthy()
    }
  })

  it('qwen-vl is prone to truncation and needs generic sanitize', () => {
    const caps = getCapabilities('qwen-vl')
    expect(caps.proneToTruncation).toBe(true)
    expect(caps.sanitizeLevel).toBe('generic')
    expect(caps.mediaTargets).toContain('image')
  })

  it('deepseek is clean (no truncation, no sanitize)', () => {
    const caps = getCapabilities('deepseek')
    expect(caps.proneToTruncation).toBe(false)
    expect(caps.sanitizeLevel).toBe('none')
  })
})

describe('applyCapabilities', () => {
  it('user-explicit temperature wins', () => {
    const caps = getCapabilities('qwen-vl')
    expect(applyCapabilities(caps, { temperature: 0.9 }).temperature).toBe(0.9)
  })

  it('family default fills undefined temperature', () => {
    const caps = getCapabilities('qwen-vl')
    const withDefault = { ...caps, defaultTemperature: 0.5 }
    expect(applyCapabilities(withDefault, { temperature: undefined }).temperature).toBe(0.5)
  })

  it('no default 鈫?temperature stays undefined', () => {
    const caps = getCapabilities('deepseek')   // deepseek 鏃?defaultTemperature
    expect(applyCapabilities(caps, { temperature: undefined }).temperature).toBeUndefined()
  })
})
```

- [ ] **Step 2: 杩愯纭澶辫触**

Run: `npx vitest run tests/pe-framework/model-capabilities/model-capabilities.test.ts`
Expected: FAIL锛堟ā鍧椾笉瀛樺湪锛?
- [ ] **Step 3: 瀹炵幇**

```ts
// src/pe-framework/model-capabilities/families.ts
export type ModelFamily = 'deepseek' | 'glm' | 'qwen-vl' | 'qwen-text' | 'gemma' | 'openai' | 'generic'

export interface FamilyRule { family: ModelFamily; modelPatterns: RegExp[]; providerPatterns?: RegExp[] }

/** 琛ㄩ┍鍔細鏂板鏃?= 鍔犱竴琛屻€傞『搴忓嵆浼樺厛绾э紙鍏堝尮閰嶅厛寰楋級銆?*/
export const FAMILY_RULES: FamilyRule[] = [
  { family: 'qwen-vl',  modelPatterns: [/qwen.*vl/i] },
  { family: 'qwen-text', modelPatterns: [/qwen/i] },
  { family: 'gemma',    modelPatterns: [/gemma/i] },
  { family: 'glm',      modelPatterns: [/^glm/i], providerPatterns: [/zhipu/i] },
  { family: 'deepseek', modelPatterns: [/deepseek/i] },
  { family: 'openai',   modelPatterns: [/^gpt/i, /^o\d/i], providerPatterns: [/^openai$/i] },
]

export function inferModelFamily(provider: string, model: string): ModelFamily {
  for (const rule of FAMILY_RULES) {
    if (rule.modelPatterns.some((re) => re.test(model))) return rule.family
    if (rule.providerPatterns?.some((re) => re.test(provider))) return rule.family
  }
  return 'generic'
}
```

```ts
// src/pe-framework/model-capabilities/capabilities.ts
import type { ModelFamily } from './families.js'

export interface ModelCapabilities {
  family: ModelFamily
  proneToTruncation: boolean
  sanitizeLevel: 'none' | 'generic'
  mediaTargets: ReadonlyArray<'image' | 'video' | 'mixed'>
  lockedOutputLang?: 'zh' | 'en'
  defaultTemperature?: number
  defaultTopP?: number
}

export const FAMILY_CAPABILITIES: Record<ModelFamily, ModelCapabilities> = {
  deepseek:   { family: 'deepseek', proneToTruncation: false, sanitizeLevel: 'none',    mediaTargets: ['image'] },
  glm:        { family: 'glm',      proneToTruncation: false, sanitizeLevel: 'none',    mediaTargets: ['image', 'video', 'mixed'] },
  'qwen-vl':  { family: 'qwen-vl',  proneToTruncation: true,  sanitizeLevel: 'generic', mediaTargets: ['image', 'video', 'mixed'], defaultTemperature: 0.5 },
  'qwen-text':{ family: 'qwen-text',proneToTruncation: true,  sanitizeLevel: 'generic', mediaTargets: [] },
  gemma:      { family: 'gemma',    proneToTruncation: true,  sanitizeLevel: 'generic', mediaTargets: ['image'] },
  openai:     { family: 'openai',   proneToTruncation: false, sanitizeLevel: 'none',    mediaTargets: ['image'] },
  generic:    { family: 'generic',  proneToTruncation: false, sanitizeLevel: 'none',    mediaTargets: [] },
}

export function getCapabilities(family: ModelFamily): ModelCapabilities {
  return FAMILY_CAPABILITIES[family] ?? FAMILY_CAPABILITIES.generic
}

/** 鍙～ undefined 瀛楁鈥斺€旂敤鎴锋樉寮忓€兼案杩滆耽 */
export function applyCapabilities<T extends { temperature?: number }>(caps: ModelCapabilities, params: T): T {
  return {
    ...params,
    ...(params.temperature === undefined && caps.defaultTemperature !== undefined
      ? { temperature: caps.defaultTemperature }
      : {}),
  }
}
```

```ts
// src/pe-framework/model-capabilities/index.ts
export * from './families.js'
export * from './capabilities.js'
```

- [ ] **Step 4: 杩愯纭閫氳繃**锛堝叏閮ㄧ敤渚?PASS锛涙敞鎰?`qwen3.5-27b` 鐢ㄤ緥鈥斺€擿/qwen/i` 鍛戒腑 qwen-text锛宍/qwen.*vl/i` 涓嶅懡涓級

- [ ] **Step 5: 鎺ュ叆涓変釜宸ュ叿鐨?temperature 鍏滃簳**

姣忎釜宸ュ叿锛坧rompt-expand/prompt-reverse/minimax-scenario锛夊湪 `resolveRoute(exec)` 涔嬪悗锛?```ts
import { inferModelFamily, getCapabilities, applyCapabilities } from '../pe-framework/model-capabilities/index.js'
// route 瑙ｆ瀽鍚庯細
const caps = getCapabilities(inferModelFamily(route.provider, route.model))
const effectiveParams = applyCapabilities(caps, { temperature: config.temperature })
// 鍚庣画 complete() 璋冪敤鐢?effectiveParams.temperature
```

- [ ] **Step 6: 鍏ㄩ噺鍥炲綊 + 鏋勫缓 + 鎻愪氦**

Run: `npm run build`锛坋xit 0锛夛紱`npx vitest run`锛堝叏缁匡級
Commit:
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/model-capabilities plugins/prompt-master/tests/pe-framework/model-capabilities plugins/prompt-master/src/tools
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): model capability matrix (family inference + defaults)"
```

---

