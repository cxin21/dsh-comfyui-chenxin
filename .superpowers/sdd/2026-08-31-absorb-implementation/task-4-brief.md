### Task 4: B2 JoyExtra 涓夋寮?
**Files:**
- Create: `src/pe-framework/sanitize/joy-extra.ts`
- Modify: `src/tools/prompt-reverse.ts`锛堝弬鏁?+ 娉ㄥ叆 + 杩囨护锛?- Modify: `src/tools/prompt-author.ts`锛坒orm_fields 閫忎紶 + anima 杈撳嚭杩囨护锛?- Test: `tests/pe-framework/sanitize/joy-extra.test.ts`

**Interfaces:**
- Produces:
  - `export type JoyExtraOptionId = 'no_glasses_headwear' | 'scene_only_no_character_appearance' | 'no_artistic_style' | 'character_name'`
  - `export function resolveJoyExtraOptions(input: { joyExtraOptions?: unknown; extraPrompt?: string; characterName?: unknown }): JoyExtraResolution`锛坄interface JoyExtraResolution { options: JoyExtraOptionId[]; characterName?: string }` 鍚屾枃浠跺鍑猴級
  - `export function buildJoyExtraSystemBlock(res: JoyExtraResolution, outputLang: 'zh'|'en'): string`
  - `export function buildJoyExtraUserTail(res: JoyExtraResolution, outputLang: 'zh'|'en'): string`
  - `export function filterJoyExtraClauses(text: string, res: JoyExtraResolution): string`

- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// tests/pe-framework/sanitize/joy-extra.test.ts
import { describe, expect, it } from 'vitest'
import { resolveJoyExtraOptions, buildJoyExtraSystemBlock, filterJoyExtraClauses } from '../../../src/pe-framework/sanitize/joy-extra.js'

describe('resolveJoyExtraOptions', () => {
  it('array mode: explicit ids win', () => {
    expect(resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] }).options).toContain('no_glasses_headwear')
  })
  it('text sniff mode: standard sentence in extra_prompt detected', () => {
    const r = resolveJoyExtraOptions({ extraPrompt: 'Do not mention glasses, goggles, hats or any headwear.' })
    expect(r.options).toContain('no_glasses_headwear')
  })
  it('character_name captured from refer-to pattern', () => {
    const r = resolveJoyExtraOptions({ characterName: '灏忔槑' })
    expect(r.characterName).toBe('灏忔槑')
  })
  it('unknown array ids filtered out', () => {
    expect(resolveJoyExtraOptions({ joyExtraOptions: ['bogus', 'no_artistic_style'] }).options).toEqual(['no_artistic_style'])
  })
})

describe('filterJoyExtraClauses', () => {
  it('removes glasses/headwear clauses', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const out = filterJoyExtraClauses('涓€浣嶅皯濂筹紝鎴寸潃绾㈣壊璐濋浄甯斤紝绌跨櫧鑹茶繛琛ｈ锛岀珯鍦ㄦ爲涓?, r)
    expect(out).not.toContain('璐濋浄甯?)
    expect(out).toContain('鐧借壊杩炶。瑁?)
  })
  it('keeps original separator style', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const out = filterJoyExtraClauses('1girl, red beret, white dress', r)
    expect(out).not.toContain('beret')
    expect(out).toContain('white dress')
    expect(out).toContain(', ')   // 鑻辨枃閫楀彿鍒嗛殧淇濈暀
  })
  it('all clauses filtered 鈫?return original (anti-extinction)', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const src = '鎴寸潃澧ㄩ暅鍜屽附瀛?
    expect(filterJoyExtraClauses(src, r)).toBe(src)
  })
  it('no options 鈫?text unchanged', () => {
    expect(filterJoyExtraClauses('鎴寸潃澧ㄩ暅鐨勫皯濂?, resolveJoyExtraOptions({}))).toBe('鎴寸潃澧ㄩ暅鐨勫皯濂?)
  })
})

describe('buildJoyExtraSystemBlock', () => {
  it('contains priority declaration + conflict override for glasses option', () => {
    const r = resolveJoyExtraOptions({ joyExtraOptions: ['no_glasses_headwear'] })
    const block = buildJoyExtraSystemBlock(r, 'zh')
    expect(block).toContain('纭害鏉?)
    expect(block).toContain('鐪奸暅')
  })
})
```

- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇**

瀹炵幇瑕佺偣锛堝鐓?absorb-analysis 搂3锛夛細
- `GLASSES_HEADWEAR_PATTERNS`锛?鐪奸暅|鎶ょ洰闀渱澧ㄩ暅|澶槼闀渱甯藉瓙|甯絴澶寸洈|鍙戠畭|澶村肪|闈㈢僵|璐濋浄甯絴beret|hat|glasses|goggles|headwear|澶存埓.{0,6}闀渱浣╂埓.{0,6}闀?i
- `APPEARANCE_CLOTHING_PATTERNS`锛?鑲よ壊|鑳庤|鐤ょ棔|闆€鏂憒濡嗗|浜斿畼|鍙戝瀷|鍙戣壊|鏈嶈|杩炶。瑁檤韬潗|鑳竱鑳寍鑲﹟鑵皘skin|freckle|scar|makeup|hairstyle|clothing|outfit/i锛堟寜 PromptMaster deob 鐗堣鍓牳蹇冩潯鐩級
- `splitClauses`锛氭寜 `[锛?锛?銆?!锛?锛焅n]` 鍒?+ 璁板綍鍘熷垎闅旂鏁扮粍锛屾嫾鍥炴椂閫愪竴杩樺師
- 瀛愬彞杩囨护锛氬懡涓换涓€鍚敤閫夐」鐨勬鍒欑粍 鈫?鍓旈櫎锛涘叏閮ㄨ鍓旈櫎 鈫?杩斿洖鍘熸枃
- system 鍧楀惈锛氫紭鍏堢骇澹版槑鍙?+ 姣忛€夐」璞佸厤浠わ紙濡?涓嶅啓鐪奸暅/澶撮グ锛氬嵆浣块潰閮ㄦ鏌ヨ〃瑕佹眰鍐欑溂闀溿€侀潰鍏锋垨澶撮グ锛屼篃蹇呴』瀹屽叏鐪佺暐"锛? 鍐茬獊浠茶锛坣o_character_appearance 浼樺厛绾ч珮浜?no_glasses_headwear 鐨?涓嶅彲鍙樺睘鎬?鍒嗘敮鏃朵互鍚庤€呬负鍑嗏€斺€旀寜 PromptMaster 鍘熺増浠茶鍙ョЩ妞嶏級
- 鏍囧噯鍙ワ紙鍡呮帰鐢級锛歯o_glasses_headwear = 'Do not mention glasses, goggles, hats or any headwear.'锛涘叾浣欎笁涓€夐」鍚勫啓鑻辨枃鏍囧噯鍙?+ 涓枃鍙樹綋锛堟墽琛岃€呮寜 PromptMaster deob `joyCaptionExtraOptions.js.deob.js` 鐨勬爣鍑嗗彞绉绘鈥斺€?*read 璇ユ枃浠跺彇閫愬瓧鏂囨湰**锛?
- [ ] **Step 4: 纭閫氳繃 + 鎸傛帴宸ュ叿**

prompt-reverse.ts锛?```ts
// 鍙傛暟锛歫oy_extra_options?: string[], character_name?: string锛坰chema 鍔犱袱涓彲閫夊瓧娈碉級
// resolveJoyExtraOptions({ joyExtraOptions: a.joy_extra_options, extraPrompt: a.extra_prompt, characterName: a.character_name })
// res.options.length > 0 鏃讹細system += '\n\n' + buildJoyExtraSystemBlock(res, lang)锛泆ser += '\n' + buildJoyExtraUserTail(res, lang)
// 杈撳嚭锛歴anitized = filterJoyExtraClauses(sanitized, res)
// 鏃ュ織锛歫oy_extra options=... filtered=yes/no
```
prompt-author.ts锛?```ts
// runDraftStage 鍚庯紙anima 鍒嗘敮锛夛細res = resolveJoyExtraOptions({ joyExtraOptions: a.form_fields?.joy_extra_options, extraPrompt: '' })
// res.options.length > 0 鈫?stage.result.positive/negative 鍚勮繃 filterJoyExtraClauses
```

- [ ] **Step 5: 鍏ㄩ噺 + 鏋勫缓 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/sanitize plugins/prompt-master/src/tools plugins/prompt-master/tests/pe-framework/sanitize
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): JoyExtra three-stage hard constraints (inject + tail + clause filter)"
```

---

