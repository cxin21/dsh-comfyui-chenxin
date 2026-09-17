### Task 2: B1 缁啓寮曟搸锛坈ontract/inspect/merge/engine锛?
**Files:**
- Create: `src/pe-framework/continue/contract.ts`
- Create: `src/pe-framework/continue/inspect.ts`
- Create: `src/pe-framework/continue/merge.ts`
- Create: `src/pe-framework/continue/engine.ts`
- Create: `src/pe-framework/continue/index.ts`锛坮e-export锛?- Test: `tests/pe-framework/continue/continue-engine.test.ts`

**Interfaces:**
- Consumes: `FinishReason['kind']`锛坉sh-llm 绫诲瀷锛屽惈 'max-tokens'锛夛紱`complete(ctx, {provider, model, system?, user, maxTokens, temperature?, signal})`锛坙lm/complete.js 鐜版湁鈥斺€旂敱璋冪敤鏂瑰皝瑁呬负 generate锛?- Produces:
  - `export interface OutputFieldContract { key: string; patterns: RegExp[] }`
  - `export interface OutputContract { id: string; fields: OutputFieldContract[]; groupSeparator?: RegExp; expectedGroups?: (formFields: Record<string, unknown>) => number }`
  - `export interface StructureInspection { missing: string[]; complete: boolean }`
  - `export function inspectOutput(text: string, contract: OutputContract): StructureInspection`
  - `export function mergeContinuedText(previous: string, continued: string): string`
  - `export interface ContinueSeed { system?: string; userText: string; outputLang: 'zh' | 'en' }`
  - `export interface ContinueOutcome { text: string; rounds: number; complete: boolean; warnings: string[] }`
  - `export async function continueUntilComplete(params: { contract: OutputContract; initialText: string; finishKind: 'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'; seed: ContinueSeed; generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: 'stop'|'tool-calls'|'max-tokens'|'aborted'|'error' }>; maxRounds?: number; signal: AbortSignal; onContinue?: (round: number, maxRounds: number) => void }): Promise<ContinueOutcome>`

- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// tests/pe-framework/continue/continue-engine.test.ts
import { describe, expect, it } from 'vitest'
import { inspectOutput, type OutputContract } from '../../../src/pe-framework/continue/inspect.js'
import { mergeContinuedText } from '../../../src/pe-framework/continue/merge.js'
import { continueUntilComplete } from '../../../src/pe-framework/continue/engine.js'

const sixSegment: OutputContract = {
  id: 'minimax-full-reference',
  fields: [
    { key: 'subject_definitions', patterns: [/subject_definitions\s*[:锛歖/i] },
    { key: 'summary', patterns: [/summary\s*[:锛歖/i, /鎽樿\s*[:锛歖/] },
    { key: 'retention_analysis', patterns: [/retention_analysis\s*[:锛歖/i] },
    { key: 'detailed_description', patterns: [/detailed_description\s*[:锛歖/i] },
    { key: 'overall_soundscape', patterns: [/overall_soundscape\s*[:锛歖/i] },
    { key: 'non_diegetic_music', patterns: [/non_diegetic_music\s*[:锛歖/i] },
  ],
}

describe('inspectOutput', () => {
  it('complete text 鈫?complete=true, missing=[]', () => {
    const text = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    expect(inspectOutput(text, sixSegment)).toEqual({ missing: [], complete: true })
  })

  it('missing field reported as field:<key>', () => {
    const text = 'subject_definitions: X\nsummary: Y'   // 鍙湁 2/6
    const r = inspectOutput(text, sixSegment)
    expect(r.complete).toBe(false)
    expect(r.missing).toContain('field:retention_analysis')
  })

  it('label with empty body (<2 chars) counts as missing', () => {
    const text = 'subject_definitions: X\nsummary:\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    expect(inspectOutput(text, sixSegment).missing).toContain('field:summary')
  })
})

describe('mergeContinuedText', () => {
  it('model parrots full text 鈫?take continued only', () => {
    expect(mergeContinuedText('ABC', 'ABCDEF')).toBe('ABCDEF')
  })
  it('suffix-prefix overlap 12+ chars 鈫?dedupe join', () => {
    const prev = 'A'.repeat(200) + 'TAIL-COMMON-SEGMENT-XXXX'
    const cont = 'TAIL-COMMON-SEGMENT-XXXX' + 'B'.repeat(50)
    const merged = mergeContinuedText(prev, cont)
    expect(merged).toBe(prev + 'B'.repeat(50))
  })
  it('no overlap 鈫?newline join; strips greeting prefix', () => {
    expect(mergeContinuedText('AAA', '濂界殑锛孊BB')).toBe('AAA\nBBB')
  })
})

describe('continueUntilComplete', () => {
  const seed = { system: 'sys', userText: '鍐欏叚娈?, outputLang: 'zh' as const }

  it('no truncation + complete 鈫?returns immediately (rounds=0)', async () => {
    const full = 'subject_definitions: X\nsummary: Y\nretention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    let genCalls = 0
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: full, finishKind: 'stop', seed,
      generate: async () => { genCalls++; return { text: full, finishKind: 'stop' as const } },
      signal: new AbortController().signal,
    })
    expect(r.complete).toBe(true)
    expect(r.rounds).toBe(0)
    expect(genCalls).toBe(0)
  })

  it('max-tokens + incomplete 鈫?continues with accumulated text in user message', async () => {
    const part1 = 'subject_definitions: X\nsummary: Y'
    const cont = 'retention_analysis: Z\ndetailed_description: W\noverall_soundscape: A\nnon_diegetic_music: B'
    let capturedUser = ''
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: part1, finishKind: 'max-tokens', seed,
      generate: async (req) => { capturedUser = req.user; return { text: cont, finishKind: 'stop' as const } },
      signal: new AbortController().signal,
    })
    expect(r.complete).toBe(true)
    expect(r.rounds).toBe(1)
    expect(capturedUser).toContain('宸插啓鍑?)
    expect(capturedUser).toContain(part1)
    expect(r.text).toContain('subject_definitions')
    expect(r.text).toContain('non_diegetic_music')
  })

  it('abort mid-round 鈫?partial text + CONTINUE_ABORTED_PARTIAL warning', async () => {
    const ctl = new AbortController()
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: 'subject_definitions: X', finishKind: 'max-tokens', seed,
      generate: async (req) => {
        ctl.abort()
        return { text: 'summary: Y', finishKind: 'stop' as const }
      },
      signal: ctl.signal,
    })
    expect(r.complete).toBe(false)
    expect(r.warnings).toContain('CONTINUE_ABORTED_PARTIAL')
  })

  it('max rounds exhausted 鈫?INCOMPLETE_AFTER_MAX_ROUNDS', async () => {
    let n = 0
    const r = await continueUntilComplete({
      contract: sixSegment, initialText: 'x', finishKind: 'max-tokens', seed, maxRounds: 2,
      generate: async () => { n++; return { text: `chunk${n}`, finishKind: 'max-tokens' as const } },
      signal: new AbortController().signal,
    })
    expect(r.complete).toBe(false)
    expect(r.warnings).toContain('INCOMPLETE_AFTER_MAX_ROUNDS')
    expect(r.rounds).toBe(2)
  })
})
```

- [ ] **Step 2: 杩愯纭澶辫触**

- [ ] **Step 3: 瀹炵幇锛坰pec 搂3.1/3.2 閫愭潯锛?*

`contract.ts`锛氱被鍨嬪畾涔夛紙瑙?Interfaces锛夈€?`inspect.ts`锛?```ts
import type { OutputContract, StructureInspection } from './contract.js'
export function inspectOutput(text: string, contract: OutputContract): StructureInspection {
  const missing: string[] = []
  for (const f of contract.fields) {
    const hit = f.patterns.some((re) => re.test(text))
    if (!hit) { missing.push(`field:${f.key}`); continue }
    // 鏍囩浣撻潪绌烘鏌ワ細鍙栧懡涓爣绛句箣鍚庡埌涓嬩竴涓崲琛?涓嬩竴鏍囩鐨勬枃鏈
    for (const re of f.patterns) {
      const m = re.exec(text)
      if (m && m.index !== undefined) {
        const body = text.slice(m.index + m[0].length, text.indexOf('\n', m.index) === -1 ? undefined : text.indexOf('\n', m.index))
        if (body.trim().length < 2) { missing.push(`field:${f.key}`) }
        break
      }
    }
  }
  return { missing, complete: missing.length === 0 }
}
```
`merge.ts`锛?```ts
const GREETING = /^(濂界殑[锛?銆傦紒!]?|缁х画杈撳嚭[锛?]?|濡備笅[锛?]?)\s*/
export function mergeContinuedText(previous: string, continued: string): string {
  let cont = continued.replace(GREETING, '').trim()
  if (!cont) return previous
  if (cont.startsWith(previous.trim())) return cont          // 澶嶈
  // 鍚庣紑-鍓嶇紑閲嶅彔鎺㈡祴锛氱獥鍙?12..240
  const maxWin = Math.min(240, previous.length, cont.length)
  for (let win = maxWin; win >= 12; win--) {
    const tail = previous.slice(-win)
    const idx = cont.indexOf(tail)
    if (idx !== -1) return previous + cont.slice(idx + win)
  }
  return previous + '\n' + cont
}
```
`engine.ts`锛?```ts
import { inspectOutput } from './inspect.js'
import { mergeContinuedText } from './merge.js'
import type { OutputContract, ContinueSeed, ContinueOutcome } from './contract.js'

type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'

export async function continueUntilComplete(params: {
  contract: OutputContract
  initialText: string
  finishKind: FinishKind
  seed: ContinueSeed
  generate: (req: { system?: string; user: string }) => Promise<{ text: string; finishKind: FinishKind }>
  maxRounds?: number
  signal: AbortSignal
  onContinue?: (round: number, maxRounds: number) => void
}): Promise<ContinueOutcome> {
  const max = params.maxRounds ?? 3
  const warnings: string[] = []
  let text = params.initialText
  let finish = params.finishKind
  let rounds = 0
  while (rounds < max) {
    const inspection = inspectOutput(text, params.contract)
    const shouldContinue = !inspection.complete || finish === 'max-tokens'
    if (!shouldContinue) break
    params.signal.throwIfAborted()
    rounds++
    params.onContinue?.(rounds, max)
    const missingList = inspection.missing.length > 0 ? inspection.missing.join(', ') : '(缁撴瀯鏈煡锛屽彲鑳芥湁鏆楁埅鏂?'
    const instruction = params.seed.outputLang === 'en'
      ? `Already written (do NOT rewrite; continue from it): -----\n${text}\n-----\n\nMissing: ${missingList}. Continue from where it stops.`
      : `宸插啓鍑猴紙涓嶈閲嶅啓锛屽熀浜庡畠缁х画锛夛細-----\n${text}\n-----\n\n缂哄け鍐呭锛?{missingList}銆傝浠庣己澶卞缁х画杈撳嚭锛屼笉瑕侀噸澶嶅凡鏈夊唴瀹广€俙
    let piece: string
    try {
      const gen = await params.generate({ system: params.seed.system, user: instruction })
      piece = gen.text
      finish = gen.finishKind
    } catch (error) {
      if (text !== params.initialText) warnings.push('CONTINUE_ABORTED_PARTIAL')
      throw error
    }
    text = mergeContinuedText(text, piece)
    if (params.signal.aborted) { warnings.push('CONTINUE_ABORTED_PARTIAL'); return { text, rounds, complete: false, warnings } }
  }
  const final = inspectOutput(text, params.contract)
  if (!final.complete || finish === 'max-tokens') warnings.push('INCOMPLETE_AFTER_MAX_ROUNDS')
  return { text, rounds, complete: final.complete && finish !== 'max-tokens', warnings }
}
```
> 娉ㄦ剰 abort 璇箟锛歴ignal.throwIfAborted 鍦ㄨ疆棣栵紱generate 鍐呴儴 abort 鐢辫皟鐢ㄦ柟 signal 浼犳挱锛涜疆鍚?`signal.aborted` 妫€鏌ヨ繑鍥為儴鍒嗙粨鏋溿€俥ngine 鐨?contract import 璺緞浠ュ疄闄呮枃浠剁粍缁囦负鍑嗭紙contract.ts 瀛樼被鍨嬶級銆?
- [ ] **Step 4: 杩愯纭閫氳繃**

- [ ] **Step 5: 鏋勫缓 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/continue plugins/prompt-master/tests/pe-framework/continue
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): structure-aware continue engine (contract/inspect/merge)"
```

---

