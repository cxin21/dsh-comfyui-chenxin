### Task 6: B4 濯掍綋韬唤鏄犲皠锛圫 瀛愰泦锛?
**Files:**
- Create: `src/pe-framework/media/identity.ts`
- Modify: `src/tools/prompt-reverse.ts`锛堝鍥炬椂娉ㄥ叆澹版槑鍧楋級
- Test: `tests/pe-framework/media/identity.test.ts`

**Interfaces:**
- Consumes: `ImageBlock`锛坉sh-llm 绫诲瀷锛夛紱`collectRecentImages`锛坧rompt-reverse.ts 鐜版湁锛?- Produces:
  - `export interface TaggedMedia { n: number; tag: string }`
  - `export function enumerateTaggedMedia(count: number): TaggedMedia[]`
  - `export function buildIdentityDeclarations(media: TaggedMedia[], outputLang: 'zh' | 'en'): string`

- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// tests/pe-framework/media/identity.test.ts
import { describe, expect, it } from 'vitest'
import { enumerateTaggedMedia, buildIdentityDeclarations } from '../../../src/pe-framework/media/identity.js'

describe('enumerateTaggedMedia', () => {
  it('tags are consecutive 1-based <Picture N>', () => {
    expect(enumerateTaggedMedia(3)).toEqual([
      { n: 1, tag: '<Picture 1>' }, { n: 2, tag: '<Picture 2>' }, { n: 3, tag: '<Picture 3>' },
    ])
  })
  it('zero media 鈫?empty', () => {
    expect(enumerateTaggedMedia(0)).toEqual([])
  })
})

describe('buildIdentityDeclarations', () => {
  it('multi-image 鈫?declaration block with do-not-swap header', () => {
    const decl = buildIdentityDeclarations(enumerateTaggedMedia(2), 'zh')
    expect(decl).toContain('<Picture 1>')
    expect(decl).toContain('<Picture 2>')
    expect(decl).toContain('涓嶈娣锋穯')   // do-not-swap 璇箟
  })
  it('single image 鈫?empty string (no injection)', () => {
    expect(buildIdentityDeclarations(enumerateTaggedMedia(1), 'zh')).toBe('')
  })
})
```

- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇**

```ts
// src/pe-framework/media/identity.ts
export interface TaggedMedia { n: number; tag: string }

export function enumerateTaggedMedia(count: number): TaggedMedia[] {
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, tag: `<Picture ${i + 1}>` }))
}

export function buildIdentityDeclarations(media: TaggedMedia[], outputLang: 'zh' | 'en'): string {
  if (media.length < 2) return ''
  const lines = media.map((m) => outputLang === 'en' ? `${m.tag} = image #${m.n}` : `${m.tag} = 绗?${m.n} 寮犲浘`)
  const header = outputLang === 'en'
    ? 'Identity mapping 鈥?do not swap identities:'
    : '韬唤鏄犲皠 鈥?涓嶈娣锋穯瀵瑰簲鍏崇郴锛?
  return `${header}\n${lines.join('\n')}`
}
```

- [ ] **Step 4: 纭閫氳繃 + 鎸傛帴 prompt-reverse**

```ts
// collectRecentImages 涔嬪悗锛坕mages.length >= 2 鍒嗘敮锛夛細
const media = enumerateTaggedMedia(images.length)
const declarations = buildIdentityDeclarations(media, (String(a.output_lang || 'zh') === 'en' ? 'en' : 'zh'))
if (declarations) {
  blocks.unshift({ type: 'text', text: declarations })   // 澹版槑鍧楃疆浜庡獟浣撳潡涔嬪墠
}
// 鏃ュ織锛歮ulti-image identity declarations injected (n=${images.length})
```

- [ ] **Step 5: 鍏ㄩ噺 + 鏋勫缓 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/media plugins/prompt-master/src/tools/prompt-reverse.ts plugins/prompt-master/tests/pe-framework/media
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): multi-image identity mapping declarations (S subset)"
```

---

