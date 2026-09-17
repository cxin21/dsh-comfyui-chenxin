### Task 5: B3 杈撳嚭鍑€鍖栭摼锛堥€氱敤灞傦級

**Files:**
- Create: `src/pe-framework/sanitize/model-specific.ts`
- Modify: `src/tools/prompt-reverse.ts`銆乣src/tools/prompt-expand.ts`锛坰anitizeModelSpecific 鍓嶇疆锛?- Test: `tests/pe-framework/sanitize/model-specific.test.ts`

**Interfaces:**
- Consumes: `getCapabilities`/`inferModelFamily`锛圱ask 1锛夛紱`sanitizeLevel: 'generic'`
- Produces: `export function sanitizeModelSpecific(text: string, ctx: { family: ModelFamily; outputLang: string }): string`

- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// tests/pe-framework/sanitize/model-specific.test.ts
import { describe, expect, it } from 'vitest'
import { sanitizeModelSpecific } from '../../../src/pe-framework/sanitize/model-specific.js'

describe('sanitizeModelSpecific', () => {
  it('sanitizeLevel none 鈫?unchanged (deepseek)', () => {
    const src = '<think>internal</think>杈撳嚭鏂囨湰'
    expect(sanitizeModelSpecific(src, { family: 'deepseek', outputLang: 'zh' })).toBe(src)
  })

  it('strips think tags for generic family', () => {
    expect(sanitizeModelSpecific('<think>reasoning</think>姝ｆ枃鍐呭', { family: 'qwen-vl', outputLang: 'zh' })).toBe('姝ｆ枃鍐呭')
  })

  it('extracts polished tail (last marker wins)', () => {
    const src = '鍒濈鍐呭\n娑﹁壊涓庣簿绠€:\n鏈€缁堢簿淇枃鏈?
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe('鏈€缁堢簿淇枃鏈?)
  })

  it('strips instruction echo lines', () => {
    const src = '杩欏紶鍥剧墖灞曠ず浜嗕竴涓コ瀛‐n瀹為檯鐨勬弿杩板唴瀹?
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).not.toContain('杩欏紶鍥剧墖')
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toContain('瀹為檯鐨勬弿杩板唴瀹?)
  })

  it('normal output untouched (negative case)', () => {
    const src = '涓€浣嶇┛绾㈣鐨勫皯濂崇珯鍦ㄦū鑺辨爲涓嬶紝闃冲厜鏌斿拰'
    expect(sanitizeModelSpecific(src, { family: 'qwen-vl', outputLang: 'zh' })).toBe(src)
  })
})
```

- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇**

```ts
// src/pe-framework/sanitize/model-specific.ts
import { getCapabilities, type ModelFamily } from '../model-capabilities/index.js'

const THINK_RE = /<think>[\s\S]*?<\/think>/gi
const THINK_UNCLOSED_RE = /<think>[\s\S]*$/i
const THINK_ZH_RE = /鎬濊€僛锛?][\s\S]*?(?=\n|$)/g
const TAIL_MARKERS = ['娑﹁壊涓庣簿绠€:', '绮剧畝鍚?', '鏈€缁堣緭鍑?', 'Final polished caption:', 'Polished:', '鏈€缁堢瓟妗?', '浼樺寲鍚?', 'Refined:']
const ECHO_LINE_RE = /^(杩欏紶鍥剧墖|杩欐槸|鎴戦渶瑕亅鍏抽敭璇嶆瀯鎬潀鏁村悎|缁勫悎鎴恷绮剧畝骞朵紭鍖東绛旀[:锛歖)/ 

function stripThinkingTags(text: string): string {
  return text.replace(THINK_RE, '').replace(THINK_UNCLOSED_RE, '').replace(THINK_ZH_RE, '').trim()
}
function extractPolishedTail(text: string): string {
  let lastIdx = -1; let lastLen = 0
  for (const marker of TAIL_MARKERS) {
    const idx = text.lastIndexOf(marker)
    if (idx > lastIdx) { lastIdx = idx; lastLen = marker.length }
  }
  if (lastIdx === -1) return text
  const tail = text.slice(lastIdx + lastLen).trim()
  return tail.length >= 2 ? tail : text
}
function stripInstructionEchoLines(text: string): string {
  return text.split('\n').filter((line) => !ECHO_LINE_RE.test(line.trim())).join('\n').trim()
}

export function sanitizeModelSpecific(text: string, ctx: { family: ModelFamily; outputLang: string }): string {
  const caps = getCapabilities(ctx.family)
  if (caps.sanitizeLevel !== 'generic') return text
  let out = stripThinkingTags(text)
  out = extractPolishedTail(out)
  out = stripInstructionEchoLines(out)
  return out
}
```

- [ ] **Step 4: 纭閫氳繃 + 鎸傛帴**

prompt-reverse.ts / prompt-expand.ts锛歚complete()` 杩斿洖鍚庛€乻anitizeFinalCaption锛坮everse锛?杩斿洖锛坋xpand锛変箣鍓嶏細
```ts
const family = inferModelFamily(route.provider, route.model)
text = sanitizeModelSpecific(text, { family, outputLang: lang })
```
鏃ュ織锛歚sanitize family=${family} changed=${before !== after}`銆?
- [ ] **Step 5: 鍏ㄩ噺 + 鏋勫缓 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/sanitize/model-specific.ts plugins/prompt-master/src/tools plugins/prompt-master/tests/pe-framework/sanitize/model-specific.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): model-family output sanitize pipeline (generic level)"
```

---

