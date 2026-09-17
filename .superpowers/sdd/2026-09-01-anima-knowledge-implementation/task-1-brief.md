### Task 1: G4 catalog 鍙ユ焺鍒锋柊 + 閲嶆柊瀵硅处

**Files:**
- Modify: `src/pe-framework/dialect/anima-catalog.ts`锛坉b() 鍔?mtime 妫€娴嬶紱鏂板 `lastManifestCheck()`锛?- Test: `tests/pe-framework/dialect/anima-catalog-refresh.test.ts`锛堟柊澧烇級

**Interfaces:**
- Consumes: 鐜版湁 `verifyManifestOnce()`/`assertAnimaCatalog`/`catalogPath`/`closeCatalog`
- Produces:
  - `export function lastManifestCheck(): { ok: boolean; reason?: string } | undefined`锛坲ndefined = 鏈璐﹁繃锛?  - db() 鎵撳紑鏃讹細statSync mtime 涓庣紦瀛樹笉鍚?鈫?close + `_manifestChecked=false` + 閲嶅紑 + 閲嶆柊瀵硅处

- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// tests/pe-framework/dialect/anima-catalog-refresh.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCatalogPath, closeCatalog, classifyTag, lastManifestCheck } from '../../../src/pe-framework/dialect/anima-catalog.js'

// fixture锛氭渶灏?sqlite 鏃犳硶寰掓墜寤衡€斺€旂敤鐪熷疄 catalog 鍓湰澶ぇ锛?// 鏀圭敤 mtime 璇箟娴嬭瘯锛歴etCatalogPath 鎸囧悜鍚屼竴鐪熷疄搴擄紝浠呴獙璇?lastManifestCheck 瀛樺湪涓斿舰鐘舵纭紱
// mtime 鍙樺寲 鈫?reopen 鐨勮涓虹敤 vi.mock('node:fs') 鐨?statSync 闂撮殧妗╂祴璇曪紙瑙?Step 3 璇存槑锛夈€?describe('G4 catalog refresh', () => {
  it('lastManifestCheck shape', () => {
    setCatalogPath(undefined)  // 鍥炶惤榛樿锛堢湡瀹炲簱锛?    classifyTag('1girl')       // 瑙﹀彂棣栧紑 + 瀵硅处
    const s = lastManifestCheck()
    expect(s).toBeDefined()
    expect(typeof s!.ok).toBe('boolean')
  })
})
```
> mtime鈫抮eopen 鐨勮涓烘祴璇曠敤 `vi.mock` 鎷︽埅 `node:fs` 鐨?statSync 杩斿洖鍙彉 mtime锛堜袱娈靛紡锛氶娆?m1锛宑lassifyTag 鍚庢敼 m2锛屽啀 classifyTag 鏂█ db 琚噸寮€鈥斺€斿彲閫氳繃 spy close 璋冪敤鎴?manifest 閲嶅璐?warn 瑙﹀彂瑙傚療锛夈€傛墽琛岃€呬互銆岃兘纭畾鎬ф柇瑷€銆嶄负鍑嗙紪鍐欙紱鑻?mock node:sqlite + statSync 杩囦簬鑴嗗急锛岄檷绾т负銆屽鍑?`_testOnlyState()` 杩斿洖 {_db 瀛樺湪鎬? _lastMtimeMs}銆嶅唴閮ㄦ帰閽堟柇瑷€锛堝厑璁革紝娉ㄦ槑锛夈€?
- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇**

```ts
// anima-catalog.ts 鏀瑰姩鐐癸紙淇濈暀鐜版湁鍏ㄩ儴瀵煎嚭锛夛細
let _lastMtimeMs = 0
let _lastManifest: { ok: boolean; reason?: string } | undefined

export function lastManifestCheck() { return _lastManifest }

function verifyManifestOnce(): void {
  if (_manifestChecked) return
  _manifestChecked = true
  const r = assertAnimaCatalog()
  _lastManifest = r.ok ? { ok: true } : { ok: false, reason: r.reason }
  if (!r.ok) console.warn(`[prompt-master] ${r.reason}锛氳祫浜т笌 golden 鍩虹嚎涓嶅悓锛岃 re-run fidelity capture`)
}

function db(): DatabaseSync {
  const path = catalogPath()
  let mtime = 0
  try { mtime = statSync(path).mtimeMs } catch { /* 鎵撳紑鍓嶇己澶辩敱 assert 鎶?*/ }
  if (_db && mtime !== _lastMtimeMs) {
    _db.close(); _db = null
    _manifestChecked = false       // 閲嶆柊瀵硅处
  }
  if (!_db) {
    verifyManifestOnce()
    _db = new DatabaseSync(path, { readOnly: true })
    _lastMtimeMs = mtime
  }
  return _db
}
```

- [ ] **Step 4: 閫氳繃 + 鍏ㄩ噺 + 鎻愪氦**

Run: `npx vitest run tests/pe-framework/dialect/anima-catalog-refresh.test.ts` 鈫?PASS锛沗npm run build` exit 0锛涘叏閲忕豢
```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/dialect/anima-catalog.ts plugins/prompt-master/tests/pe-framework/dialect/anima-catalog-refresh.test.ts
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G4 catalog handle refresh on mtime change + manifest re-check"
```

---

