### Task 4: G2 segments/phaseStatus/metadata锛坈ompileAnima 鎵╁睍锛?
**Files:**
- Modify: `src/pe-framework/dialect/anima.ts`锛坈ompileAnima 杩斿洖鍊兼墿灞曪紱citations 琛?source 鏌ヨ锛?- Test: `tests/plugin/compile-anima.test.ts`锛堣拷鍔狅級+ `tests/fidelity/anima-brief-golden.test.ts`锛堝洖褰掔‘璁や笉鍙橈級

**Interfaces:**
- Consumes: 鐜版湁 compileAnima 鍐呴儴锛?c 寰幆鐨?base/slotName/citation锛夈€乣SLOT_ORDER`銆乻ources 琛?- Produces锛圕ompileAnimaResult 鏂板瀛楁锛?
  - `segments: Array<{ text: string; channel: 'positive'|'negative'; origin: 'policy'|'grounded'|'user-fuzzy'|'narrative'|'exclusion'; priority: number; slot?: string; citation?: AnimaCitation }>`
  - `phaseStatus: { policy: 'PASS'; grounding: 'PASS'|'ADVISORY'; composition: 'PASS'; inspection: 'PASS'|'ADVISORY' }`
  - `metadata: { variant: string; subject?: string }`
  - AnimaCitation 澧炲姞 `source?: string`锛坈itations 寤虹珛鏃?`SELECT s.value FROM sources s JOIN records r ON r.source_id=s.source_id WHERE r.record_id=?`鈥斺€?*鎵ц鑰呭厛 read 鐪熷疄搴?schema**锛歚PRAGMA table_info(sources)` 纭鍒楀悕锛?
- [ ] **Step 1: 澶辫触娴嬭瘯锛堣拷鍔犲埌 compile-anima.test.ts锛?*

```ts
it('G2: segments projection (origin/priority/slot provenance)', async () => {
    const ctx = stubCtx()
    const raw = JSON.parse(String(await runTool(ctx, def(), {
      target: 'anima',
      slots: { count_gender: ['1girl'], appearance: ['long hair'], narrative: '涓€娈垫弿杩?, exclusions: ['lowres'] },
    })))
    const segs = raw.result.segments as Array<{ text: string; channel: string; origin: string; priority: number; slot?: string }>
    expect(segs.filter((s) => s.origin === 'policy').length).toBeGreaterThan(0)      // quality 鍓嶇紑
    expect(segs.some((s) => s.origin === 'grounded' && s.slot === 'count_gender')).toBe(true)
    expect(segs.some((s) => s.origin === 'narrative' && s.channel === 'positive')).toBe(true)
    expect(segs.some((s) => s.origin === 'exclusion' && s.channel === 'negative')).toBe(true)
    expect(segs.every((s) => typeof s.priority === 'number')).toBe(true)
})

it('G2: phase_status four stages', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima', slots: { count_gender: ['1girl'] },
    })))
    expect(raw.result.phase_status).toEqual({ policy: 'PASS', grounding: 'PASS', composition: 'PASS', inspection: 'PASS' })
})

it('G2: metadata carries variant', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), {
      target: 'anima', slots: { count_gender: ['1girl'] }, variant: 'aesthetic',
    })))
    expect(raw.result.metadata).toEqual({ variant: 'aesthetic' })
})
```

- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇**

瑕佺偣锛?- 3c 寰幆鏀逛负鏀堕泦 `segments.push({ text, channel:'positive', origin, priority: base + tagIndex, slot: slotName, citation })`锛?a policy 娈?origin='policy' priority=100锛?b safety origin='policy' priority=99锛?d narrative origin='narrative' priority=2000锛?e exclusions channel='negative' origin='exclusion' priority=900
- `positive = segments.filter(channel==='positive').map(text).join(', ')`鈥斺€?*瀛楃涓叉嫾鎺ョ粨鏋滃繀椤讳笌鐜扮姸閫愬瓧鑺備竴鑷?*锛坓olden 闂搁棬锛夛紱negative 鍚岀悊
- phaseStatus锛歡rounding = citations 鏈?record_id 鈫?'PASS' else 'ADVISORY'锛沬nspection = gates.some(important+) 鈫?'ADVISORY' else 'PASS'
- metadata = { variant }
- citations.source锛歡roundSlotTags 鐨?citation 寤虹珛澶勮ˉ sources 鏌ヨ锛?*鍏?PRAGMA table_info(sources) 鏍稿疄鍒楀悕**锛涜嫢 sources 琛ㄦ棤 value 鍒楀垯鎸夊疄闄呭垪璋冩暣鎴?source 鐣?null 骞舵敞鏄庯級
- **娉ㄦ剰**锛歚validateAnimaSlots`锛圙6 椤哄甫锛夊 `subject` 鍔犮€屽彲閫?string銆嶆牎楠岋紱compileAnima metadata.subject = slots.subject

- [ ] **Step 4: 閫氳繃锛堥噸鐐癸細fidelity anima-brief-golden 13 鐢ㄤ緥蹇呴』鍏ㄧ豢鈥斺€攑ositive/negative 閫愬瓧鑺備笉鍙橈級**

- [ ] **Step 5: 鍏ㄩ噺 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect/anima.ts plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G2 author payload projection (segments/phase_status/citations.source/metadata)"
```

---

