### Task 2: G3 browse/stats/verify锛坄anima-knowledge/`锛?
**Files:**
- Create: `src/pe-framework/anima-knowledge/browse.ts`
- Create: `src/pe-framework/anima-knowledge/verify.ts`
- Test: `tests/pe-framework/anima-knowledge/browse-verify.test.ts`

**Interfaces:**
- Consumes: `db()`/`normalizeTag`/`CatalogHit`锛坅nima-catalog.ts鈥斺€旈渶鎶?db/ftsQuery 瀵煎嚭鎴栫粡鍐呴儴 import锛?*鎵ц鑰呭厛 read anima-catalog.ts 瀹氬鍏ユ柟寮?*锛屽繀瑕佹椂鏂板 `export function queryCatalogInternal(sql, params)` 閬垮厤瀵煎嚭 _db锛?- Produces:
  - `export function browseCatalog(opts?: { category?: string; source?: string; limit?: number }): CatalogHit[]`
  - `export function catalogStats(): { records: number; names: number; ftsRows: number }`
  - `export interface VerifyCheck { name: string; ok: boolean; detail?: string }`
  - `export interface VerifyResult { ok: boolean; checks: VerifyCheck[] }`
  - `export function verifyCatalog(): VerifyResult`锛堚憼 checksum 鈶?COUNT(fts)==COUNT(names) 鈶?4 琛ㄥ瓨鍦?records/names/catalog_fts/sources锛?
- [ ] **Step 1: 澶辫触娴嬭瘯锛坒ixture锛氱湡瀹炲簱鍙璺?browse/stats/verify 鐨勬鍚戞柇瑷€ + mock/灏忓簱璺戝け璐ュ垎鏀級**

```ts
// tests/pe-framework/anima-knowledge/browse-verify.test.ts
// 姝ｅ悜锛堢湡瀹炲簱锛屽彧璇伙級锛歜rowse limit=3 鈫?3 hits 鍏ㄥ惈 usage_count锛泂tats 涓夎鏁?> 0 涓?records鈮?.37M 閲忕骇锛泇erifyCatalog().ok === true
// 澶辫触鍒嗘敮锛坱mp 灏忓簱 or mock锛夛細verifyCatalog 瀵圭己 FTS 琛?琛屾暟涓嶉綈 鈫?checks 鍚搴斿け璐ラ」
```
> 鐪熷疄搴撶殑 verify 姝ｅ悜璺戜竴娆?sha256 绉掔骇鈥斺€攙itest.config.ts 宸?30s 瓒呮椂锛屽彲鎺ュ彈銆傚け璐ュ垎鏀敤 tmp fixture锛圱ask 2 of redesign 宸叉湁 fixture 妯″紡鍙傝€?`tests/pe-framework/resources/manifest.test.ts`锛夈€?
- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇 鈫?Step 4: 閫氳繃**

- [ ] **Step 5: 鏋勫缓 + 鍏ㄩ噺 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/anima-knowledge plugins/prompt-master/tests/pe-framework/anima-knowledge
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G3 catalog browse/stats/verify deep checks"
```

---

