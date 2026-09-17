### Task 7: G1 catalog_relations 宸ュ叿 + G7 鏌ヨ鎵╁睍

**Files:**
- Create: `src/tools/catalog-relations.ts`
- Modify: `src/plugin/index.ts`锛堟敞鍐屾柊宸ュ叿锛?- Modify: `src/pe-framework/dialect/anima-catalog.ts`锛圕atalogQueryOptions 鎵?mode 鍗曢€?categories/sources + applyRelationOverlay 鍗囩骇涓虹湡瀹?overlay 鍒悕璇诲彇锛?- Test: `tests/plugin/catalog-relations.test.ts` + `tests/pe-framework/dialect/anima-catalog.test.ts`锛堝崟妯″紡杩藉姞锛?
**Interfaces:**
- Consumes: Task 6 鐨?relations.ts 鍏ㄥ锛沗classifyTag`
- Produces:
  - 宸ュ叿 `catalog_relations`锛坅ctions: submit/list/accept/reject/status锛?  - `CatalogQueryOptions.mode` 鎵╀负 `'auto'|'exact'|'canonical'|'alias'|'fuzzy'`锛涙柊澧?`categories?: string[]`銆乣sources?: string[]`
  - `searchCatalog` 鍦?auto/exact 绾ц仈鍚庤拷鍔?overlay accepted 鍒悕鍛戒腑锛坅lias 绾э紝canonical 淇濇姢锛?- [ ] **Step 1: 澶辫触娴嬭瘯**
- [ ] **Step 2-4: 瀹炵幇 + 閫氳繃**锛坈atalog-relations 宸ュ叿鐨?action dispatch 鍙傜収 profile-list.ts 妯″紡锛涘崟妯″紡 SQL 澶嶇敤 exactQuery 妯℃澘锛沷verlay 鍛戒腑缁?`applyRelationOverlay` 鐨勭湡瀹炲寲鈥斺€攔ead 鐜版湁澹冲嚱鏁板悗鍗囩骇锛?- [ ] **Step 5: 鍏ㄩ噺锛坓olden 涓嶅姩锛? 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G1 catalog_relations tool + G7 single-mode/category query"
```

---

