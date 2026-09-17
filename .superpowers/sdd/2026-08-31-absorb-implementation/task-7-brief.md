### Task 7: B5 鍙屽眰瀛樺偍 + 瀵煎叆瀵煎嚭

**Files:**
- Create: `src/pe-framework/profiles/storage-v2.ts`
- Modify: `src/plugin/index.ts`锛堟敞鍐?overrides namespace + 浼犲叆宸ュ叿锛?- Modify: `src/tools/profile-list.ts`锛坅ction 鎵╁睍锛歟nable/sort/export/import/validate_import锛沴ist 鏀?merged锛?- Test: `tests/pe-framework/profiles/storage-v2.test.ts` + `tests/plugin/profile-list-v2.test.ts`

**Interfaces:**
- Consumes: `ctx.settings.register`锛堝凡楠岃瘉锛夛紱鐜版湁 `getDefaultBuiltinProfiles`/customProfiles 娉ㄥ叆婧愶紙`src/resolver/profiles/{index,source}.ts`锛夛紱鐜版湁 ProfileScope
- Produces:
  - `export interface BuiltinOverride { enabled: boolean; sort?: number }`
  - `export function registerOverridesNamespace(ctx: Context): { get(): Record<string, BuiltinOverride>; set(id: string, o: BuiltinOverride | null): Promise<void>; all(): Record<string, BuiltinOverride> }`
  - `export function listProfilesMerged(builtins: PEProfile[], custom: PEProfile[], overrides: Record<string, BuiltinOverride>): PEProfile[]`
  - `export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown>`锛坕d 鈫?`pe_custom_+randomUUID()`锛屾椂闂存埑閲嶇疆锛?  - `export function validateImportPayload(payload: unknown, builtinIds: string[]): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string }`

- [ ] **Step 1: 鍐欏け璐ユ祴璇曪紙绾嚱鏁板眰锛?*

```ts
// tests/pe-framework/profiles/storage-v2.test.ts
import { describe, expect, it } from 'vitest'
import { listProfilesMerged, recastImportedProfile, validateImportPayload } from '../../../src/pe-framework/profiles/storage-v2.js'

const builtins = [
  { id: 'pe_a', name: 'A', kind: 'reverse', sort: 1 },
  { id: 'pe_b', name: 'B', kind: 'expand', sort: 2 },
]
const custom = [{ id: 'pe_custom_x', name: 'X', kind: 'expand', sort: 5 }]

describe('listProfilesMerged', () => {
  it('disabled builtin excluded', () => {
    const r = listProfilesMerged(builtins, custom, { pe_a: { enabled: false } })
    expect(r.map((p) => p.id)).not.toContain('pe_a')
    expect(r.map((p) => p.id)).toContain('pe_b')
  })
  it('override sort re-orders', () => {
    const r = listProfilesMerged(builtins, custom, { pe_b: { enabled: true, sort: 0 } })
    expect(r[0].id).toBe('pe_b')
  })
  it('stale override pointing to nonexistent builtin ignored', () => {
    const r = listProfilesMerged(builtins, [], { pe_ghost: { enabled: false } })
    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b'])
  })
  it('custom profiles merged after builtins (sort ordered)', () => {
    const r = listProfilesMerged(builtins, custom, {})
    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b', 'pe_custom_x'])
  })
})

describe('validateImportPayload', () => {
  it('rejects builtin id collision', () => {
    const r = validateImportPayload({ id: 'pe_a', name: 'X', kind: 'expand', systemPrompt: 's' }, ['pe_a'])
    expect(r.ok).toBe(false)
  })
  it('rejects missing systemPrompt', () => {
    expect(validateImportPayload({ name: 'X', kind: 'expand' }, []).ok).toBe(false)
  })
  it('rejects bad kind', () => {
    expect(validateImportPayload({ name: 'X', kind: 'bogus', systemPrompt: 's' }, []).ok).toBe(false)
  })
  it('accepts valid single profile', () => {
    const r = validateImportPayload({ name: 'X', kind: 'expand', systemPrompt: 's' }, [])
    expect(r.ok).toBe(true)
  })
})

describe('recastImportedProfile', () => {
  it('recasts id to pe_custom_+uuid and resets timestamps', () => {
    const out = recastImportedProfile({ id: 'pe_old', name: 'X', kind: 'expand', systemPrompt: 's', createdAt: 1, updatedAt: 1 })
    expect(out.id).toMatch(/^pe_custom_/)
    expect(out.id).not.toBe('pe_old')
    expect(out.createdAt).not.toBe(1)
  })
})
```

- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇**

```ts
// src/pe-framework/profiles/storage-v2.ts
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface BuiltinOverride { enabled: boolean; sort?: number }
export interface OverridesSection { builtinOverrides: Record<string, BuiltinOverride> }

/** 娉ㄥ唽鍐呯疆瑕嗙洊灞?namespace锛坰pec 搂7.1锛泂chemastery 鏃?.optional()鈥斺€旀棤 default 鍗冲彲閫夛級 */
export function registerOverridesNamespace(ctx: Context) {
  const scope = (ctx as any).settings.register('prompt-master-profile-overrides', z.object({
    builtinOverrides: z.dict(z.string(), z.object({ enabled: z.boolean(), sort: z.number() })),
  }))
  return {
    all: (): Record<string, BuiltinOverride> => (scope.get() as any)?.builtinOverrides ?? {},
    set: async (id: string, o: BuiltinOverride | null) => {
      const cur = (scope.get() as any)?.builtinOverrides ?? {}
      const next = { ...cur }
      if (o === null) delete next[id]; else next[id] = o
      await scope.update({ builtinOverrides: next })
    },
  }
}

export function listProfilesMerged<T extends { id: string; sort?: number }>(
  builtins: T[], custom: T[], overrides: Record<string, BuiltinOverride>,
): T[] {
  const out: T[] = []
  for (const b of builtins) {
    const o = overrides[b.id]
    if (o && o.enabled === false) continue
    out.push(o?.sort !== undefined ? { ...b, sort: o.sort } : b)
  }
  out.push(...custom)
  return out.sort((x, y) => (x.sort ?? 999) - (y.sort ?? 999) || String(x.id).localeCompare(String(y.id)))
}

const IMPORT_KINDS = new Set(['expand', 'reverse', 'train'])
export function validateImportPayload(payload: unknown, builtinIds: string[]): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'payload 闇€涓哄璞? }
  const p = payload as Record<string, unknown>
  const builtinIdsSet = new Set(builtinIds)
  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id'])) return { ok: false, reason: `id "${p['id']}" 涓庡唴缃啿绐侊紝瀵煎叆灏嗛噸閾?id` }
  if (typeof p['name'] !== 'string' || !(p['name'] as string).trim()) return { ok: false, reason: 'name 蹇呭～' }
  if (typeof p['kind'] !== 'string' || !IMPORT_KINDS.has(p['kind'])) return { ok: false, reason: `kind 闇€涓?expand|reverse|train锛屽緱鍒?${String(p['kind'])}` }
  if (typeof p['systemPrompt'] !== 'string' || !(p['systemPrompt'] as string).trim()) return { ok: false, reason: 'systemPrompt 蹇呭～' }
  return { ok: true, profile: p }
}

export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now()
  return { ...profile, id: `pe_custom_${randomUUID()}`, builtin: false, createdAt: now, updatedAt: now }
}
```
> PEProfile 鐨勫疄闄呭瓧娈碉紙read `src/resolver/types.js`锛夆€斺€擿createdAt/updatedAt` 鑻ヤ笉瀛樺湪浜庣被鍨嬪垯 recast 涓嶈杩欎袱閿紙浠ョ紪璇戜负鍑嗭級锛沗builtin` 瀛楁鍚岀悊鏍稿銆?
- [ ] **Step 4: profile_list 宸ュ叿鎵╁睍锛坅ction: enable/sort/export/import/validate_import锛沴ist 鏀?merged锛?*

```ts
// profile-list.ts 鐨?execute switch 鍔犲垎鏀紙read 鐜版湁 action 鍒嗘淳缁撴瀯鍚庢彃鍏ワ級锛?// enable: overrides.set(id, { enabled }) 鈥斺€?鍐呯疆 id 鏍￠獙锛坆uiltinIds 鍒楄〃浠?getDefaultBuiltinProfiles 鍙栵級
// sort: for (ids) overrides.set(id, { enabled: true, sort: idx })
// export: find profile (merged) 鈫?JSON.stringify({ format: 'prompt-master-prompt-engineering', profile })
// import: validateImportPayload(payload, builtinIds) 鈫?ok 鈫?recastImportedProfile 鈫?scope.update 瀛?customProfiles 鈫?杩斿洖鏂?id锛沠ail 鈫?serializeReport ok=false
// validate_import: validateImportPayload 鈫?浜鸿瘽缁撹锛堜笉钀界洏锛?// list: 鏀圭敤 listProfilesMerged(builtins, custom, overrides.all())
```
plugin/index.ts锛歚const overrides = registerOverridesNamespace(ctx)` 鈫?浼犲叆 registerProfileListTool 鐨勭幇鏈?options 瀵硅薄锛坄{ scope, overrides }`锛夈€?
- [ ] **Step 5: 娴嬭瘯 + 鍏ㄩ噺 + 鏋勫缓 + 鎻愪氦**

Run: `npx vitest run tests/pe-framework/profiles/storage-v2.test.ts tests/plugin/profile-list.test.ts tests/plugin/profile-list-v2.test.ts`锛堢幇鏈?profile-list.test.ts 闇€閫傞厤 list merged 璇箟鈥斺€攔ead 鍚庝慨锛?```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): two-layer profile storage + import/export with id recast"
```

---

