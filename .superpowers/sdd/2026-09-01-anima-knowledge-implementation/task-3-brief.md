### Task 3: G5 candidate/闃堝€?advisory + G4 manifest 鍙锛坈atalog_search 鎵╁睍锛?
**Files:**
- Modify: `src/tools/catalog-search.ts`锛坔its 鎶曞奖 candidate锛涢《灞?advisory + manifest 鐘舵€侊級
- Test: `tests/plugin/catalog-search.test.ts`锛堣拷鍔犵敤渚嬶級

**Interfaces:**
- Consumes: `lastManifestCheck()`锛圱ask 1锛夛紱鐜版湁 searchCatalog
- Produces: catalog_search 杈撳嚭褰㈢姸鎵╁睍锛?  - `hits[].candidate: boolean`锛? match_type==='fuzzy'锛?  - 椤跺眰 `advisories?: string[]`锛坒uzzy 涓?usage_count<1000 鈫?'fuzzy_below_threshold: usage_count=N'锛?  - 椤跺眰 `manifest: { ok: boolean; reason?: string } | undefined`

- [ ] **Step 1: 澶辫触娴嬭瘯锛堣拷鍔犲埌鐜版湁 catalog-search.test.ts锛?*

```ts
it('G5: fuzzy hits carry candidate=true; canonical without', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 3 })))
    for (const h of raw.hits) expect(h.candidate).toBe(h.match_type === 'fuzzy')
})
it('G5: fuzzy_below_threshold advisory when usage_count < 1000', async () => {
    // 鐢ㄤ細瑙﹀彂 fuzzy 涓斾綆 usage 鐨?tag锛堟墽琛岃€呬粠 golden fixtures 鎵惧疄璇?tag锛涙垨鐩存帴鏂█ advisory 鏁扮粍瀛樺湪鎬ц涔夛級
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: 'silver hair', limit: 5 })))
    const lowUse = (raw.hits ?? []).some((h: any) => h.match_type === 'fuzzy' && (h.usage_count ?? 0) < 1000)
    if (lowUse) expect((raw.advisories ?? []).some((a: string) => a.includes('fuzzy_below_threshold'))).toBe(true)
})
it('G4: manifest status surfaced in output', async () => {
    const raw = JSON.parse(String(await runTool(stubCtx(), def(), { tag: '1girl' })))
    expect(raw.manifest).toBeDefined()
    expect(typeof raw.manifest.ok).toBe('boolean')
})
```

- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇锛坔its.map 鍔?candidate锛沘dvisories 鏁扮粍鏋勫缓锛沵anifest = lastManifestCheck()锛夆啋 Step 4: 閫氳繃**

- [ ] **Step 5: 鍏ㄩ噺 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/tools/catalog-search.ts plugins/prompt-master/tests/plugin/catalog-search.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G5 candidate/threshold advisory + G4 manifest visibility in catalog_search"
```

---

