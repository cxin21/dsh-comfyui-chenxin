### Task 3: B1 鎺ュ叆 minimax 鍦烘櫙锛堝绾﹀０鏄?+ generate 灏佽锛?
**Files:**
- Modify: `src/pe-framework/schema/scenes.ts`锛堝満鏅?catalog 鏉＄洰鍔犲彲閫?`outputContract`锛沠ull_reference 涓?director_segments 鍦烘櫙澹版槑濂戠害锛?- Modify: `src/tools/minimax-scenario.ts`锛堝満鏅甫濂戠害鏃?complete 鍚庤蛋 continueUntilComplete锛涙棩蹇楁墦鐐癸級
- Test: `tests/plugin/minimax-continue.test.ts`锛堟柊澧烇紝mock complete 涓嶅彂鐪熻姹傗€斺€?*娉ㄦ剰**锛歮inimax_scenario 鐜版湁娴嬭瘯 mock 鐨勬槸 ctx.llm.stream锛坈omplete 搴曞眰锛夛紝缁啓澶氳疆 = 澶氭 stream锛宮ock 闇€鎸夎皟鐢ㄦ搴忚繑鍥炴埅鏂?缁啓涓ゆ锛?
**Interfaces:**
- Consumes: `continueUntilComplete`锛圱ask 2锛夛紱`complete(ctx, opts)`锛堢幇鏈夛級锛涚幇鏈夊満鏅?catalog 缁撴瀯锛坮ead `src/pe-framework/schema/scenes.ts` 纭鏉＄洰褰㈢姸鍚庡姞瀛楁锛?- Produces: 鍦烘櫙鏉＄洰鏂板彲閫夊瓧娈?`outputContract?: OutputContract`锛沵inimax_scenario 鍦ㄥ甫濂戠害鍦烘櫙涓婄殑缁啓琛屼负

- [ ] **Step 1: read scenes.ts 纭鍦烘櫙鏉＄洰绫诲瀷涓?full_reference/director_segments 鏉＄洰锛涚‘璁?minimax-scenario.ts 鐨?complete 璋冪敤鐐?*

- [ ] **Step 2: 鍐欏け璐ユ祴璇?*

```ts
// tests/plugin/minimax-continue.test.ts
// mock ctx.llm.stream锛氱涓€娆¤皟鐢ㄨ繑鍥炲崐鎴叚娈碉紙finish=max-tokens chunk锛夛紝绗簩娆¤繑鍥炰綑涓嬫锛坒inish=stop锛?// 鏂█锛歮inimax_scenario 杩斿洖鐨?Envelope result.text 鍚叏閮ㄥ叚娈碉紱advisories 鎴栨棩蹇楀惈缁啓杞
// 锛坢ock 妯″紡鍙傝€?tests/plugin/minimax.test.ts 鐜版湁 stream mock 鍐欐硶鈥斺€攔ead 鍚庡鐢級
```
锛堟祴璇曚唬鐮佷互鐜版湁 minimax.test.ts 鐨?mock 妯″紡涓哄噯缂栧啓鈥斺€擳ask 3 鎵ц鑰呭厛 read 璇ユ枃浠躲€傛柇瑷€鐐癸細鍚堝苟鍚庡叚娈甸綈鍏ㄣ€乺ounds鈮?銆傦級

- [ ] **Step 3: scenes.ts 濂戠害澹版槑**

```ts
// 鍦烘櫙鏉＄洰绫诲瀷鍔狅細outputContract?: OutputContract锛坕mport from '../continue/contract.js'锛?// full_reference 鏉＄洰锛氬叚娈?fields锛圱ask 2 娴嬭瘯閲岀殑 sixSegment 琛ㄢ€斺€斿瓧娈?key 涓?compileH3 杈撳嚭瀹為檯娈靛悕鏍稿锛宺ead src/pe-framework/dialect/h3.ts 鐨?build_ref2va_text 娈靛悕瀹氱锛?// director_segments 鏉＄洰锛歡roupSeparator: /={3,}\s*鎻愮ず璇嶇粍\s*(\d+)\s*={3,}/, expectedGroups: (ff) => Number(ff?.segment_count ?? 4)
```
> **濂戠害瀛楁鍚嶄互瀹為檯妯℃澘涓哄噯**锛歍ask 3 鎵ц鑰呭繀椤?read `src/pe-framework/dialect/h3.ts` 涓叚娈电殑瀹為檯鑻辨枃娈靛悕锛坰ubject_definitions/summary/retention_analysis/detailed_description/overall_soundscape/non_diegetic_music锛夊苟璁?patterns 涓庝箣閫愬瓧瀵归綈鈥斺€旇繖鏄绾︽湁鏁堟€х殑鏍广€?
- [ ] **Step 4: minimax-scenario.ts 鎸傛帴**

```ts
// complete 璋冪敤鍚庯細
const contract = scenario.outputContract
let text = rawText, rounds = 0
if (contract) {
  const outcome = await continueUntilComplete({
    contract, initialText: text, finishKind: finish.kind, seed: { system, userText: user, outputLang: 'zh' },
    generate: async (req) => {
      const g = await complete(ctx, { provider, model, system: req.system, user: req.user, maxTokens, temperature: config.temperature, signal: exec.signal })
      return { text: g.text, finishKind: g.finish.kind }
    },
    signal: exec.signal,
    onContinue: (n, max) => ctx.logger?.info?.(`[prompt-master] continue round=${n}/${max}`),
  })
  text = outcome.text; rounds = outcome.rounds
  ctx.logger?.info?.(`[prompt-master] minimax_scenario 鈫?continue complete=${outcome.complete} rounds=${rounds}`)
}
```
> **B0 鎺ュ叆**锛氭澶?temperature 宸插湪 Task 1 鎺?applyCapabilities鈥斺€斾繚鎸併€?
- [ ] **Step 5: 娴嬭瘯 + 鍏ㄩ噺 + 鏋勫缓 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/schema/scenes.ts plugins/prompt-master/src/tools/minimax-scenario.ts plugins/prompt-master/tests/plugin/minimax-continue.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): wire continue engine into minimax scenarios (contract-declared)"
```

---

