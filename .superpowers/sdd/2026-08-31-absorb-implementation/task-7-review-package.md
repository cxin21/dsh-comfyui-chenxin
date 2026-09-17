# Review package - fdaacff..672e2a7

## Commits
``````

## Stat
``` .../src/pe-framework/profiles/storage-v2.ts        |  73 +++++++++++
 plugins/prompt-master/src/plugin/index.ts          |   6 +-
 plugins/prompt-master/src/tools/profile-list.ts    |  87 +++++++++++--
 .../tests/pe-framework/profiles/storage-v2.test.ts |  54 ++++++++
 .../tests/plugin/profile-list-v2.test.ts           | 144 +++++++++++++++++++++
 .../prompt-master/tests/plugin/registry.test.ts    |   3 +-
 6 files changed, 354 insertions(+), 13 deletions(-)
```

## Full diff (-U10)
```diff --git a/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts b/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts
new file mode 100644
index 0000000..3b5f320
--- /dev/null
+++ b/plugins/prompt-master/src/pe-framework/profiles/storage-v2.ts
@@ -0,0 +1,73 @@
+// storage-v2 — 两层 profile 存储的纯函数层 + 内置覆盖 namespace（spec §7.1）
+// 内置层：只读 builtin profiles + settings 覆盖（enabled/sort）；自定义层：customProfiles（不变）。
+// 纯模块：不落日志（工具层记 action 摘要）。
+
+import { randomUUID } from 'node:crypto'
+import type { Context } from '@deepseek-ai/cordis'
+import z from '@deepseek-ai/schemastery'
+import { settingsNamespace } from '@deepseek-ai/dsh-settings'
+
+export interface BuiltinOverride { enabled: boolean; sort?: number }
+export interface OverridesSection { builtinOverrides: Record<string, BuiltinOverride> }
+
+export interface OverridesApi {
+  get(): Record<string, BuiltinOverride>
+  all(): Record<string, BuiltinOverride>
+  set(id: string, o: BuiltinOverride | null): Promise<void>
+}
+
+/**
+ * 注册内置覆盖层 namespace（spec §7.1）。
+ * schemastery 纪律：无 default 字段即 optional-by-default，绝不 .optional()。
+ */
+export function registerOverridesNamespace(ctx: Context): OverridesApi {
+  const ns = settingsNamespace('prompt-master-profile-overrides')
+  const scope = ctx.settings.register(ns, z.object({
+    builtinOverrides: z.dict(z.object({ enabled: z.boolean(), sort: z.number() })),
+  }))
+  const read = (): Record<string, BuiltinOverride> =>
+    (scope.get() as unknown as OverridesSection | undefined)?.builtinOverrides ?? {}
+  return {
+    get: read,
+    all: read,
+    set: async (id: string, o: BuiltinOverride | null) => {
+      const next = { ...read() }
+      if (o === null) delete next[id]
+      else next[id] = o
+      await scope.update({ builtinOverrides: next })
+    },
+  }
+}
+
+/** 合并读取：builtins 按 overrides 过滤/重排，custom 追加其后，整体按 sort（缺省 999）+ id 稳定排序。 */
+export function listProfilesMerged<T extends { id: string; sort?: number }>(
+  builtins: T[], custom: T[], overrides: Record<string, BuiltinOverride>,
+): T[] {
+  const out: T[] = []
+  for (const b of builtins) {
+    const o = overrides[b.id]
+    if (o && o.enabled === false) continue
+    out.push(o?.sort !== undefined ? { ...b, sort: o.sort } : b)
+  }
+  out.push(...custom)
+  return out.sort((x, y) => (x.sort ?? 999) - (y.sort ?? 999) || String(x.id).localeCompare(String(y.id)))
+}
+
+const IMPORT_KINDS = new Set(['expand', 'reverse', 'train'])
+
+export function validateImportPayload(payload: unknown, builtinIds: string[]): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string } {
+  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'payload 需为对象' }
+  const p = payload as Record<string, unknown>
+  const builtinIdsSet = new Set(builtinIds)
+  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id'])) return { ok: false, reason: `id "${p['id']}" 与内置冲突，导入将重铸 id` }
+  if (typeof p['name'] !== 'string' || !(p['name'] as string).trim()) return { ok: false, reason: 'name 必填' }
+  if (typeof p['kind'] !== 'string' || !IMPORT_KINDS.has(p['kind'])) return { ok: false, reason: `kind 需为 expand|reverse|train，得到 ${String(p['kind'])}` }
+  if (typeof p['systemPrompt'] !== 'string' || !(p['systemPrompt'] as string).trim()) return { ok: false, reason: 'systemPrompt 必填' }
+  return { ok: true, profile: p }
+}
+
+/** 导入重铸：id → pe_custom_+uuid，强制 builtin:false，时间戳重置（PEProfile.createdAt/updatedAt 存在，编译门通过）。 */
+export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown> {
+  const now = Date.now()
+  return { ...profile, id: `pe_custom_${randomUUID()}`, builtin: false, createdAt: now, updatedAt: now }
+}
diff --git a/plugins/prompt-master/src/plugin/index.ts b/plugins/prompt-master/src/plugin/index.ts
index bc7503b..e575503 100644
--- a/plugins/prompt-master/src/plugin/index.ts
+++ b/plugins/prompt-master/src/plugin/index.ts
@@ -3,20 +3,21 @@ import type { Context } from '@deepseek-ai/cordis'
 import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
 import { registerExpandTool } from '../tools/prompt-expand.js'
 import { registerReverseTool } from '../tools/prompt-reverse.js'
 import { registerMinimaxTool } from '../tools/minimax-scenario.js'
 import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
 import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
 import { registerCompileTool } from '../tools/prompt-compile.js'
 import { registerCatalogSearchTool } from '../tools/catalog-search.js'
 import { registerAuditTool } from '../tools/prompt-audit.js'
 import { setCustomProfileSource } from '../resolver/profiles/source.js'
+import { registerOverridesNamespace } from '../pe-framework/profiles/storage-v2.js'
 import '../pe-framework/dialect/anima.js'
 import '../pe-framework/dialect/h3.js'
 import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
 import { setPresetRoot } from '../pe-framework/resources/resolve.js'
 import { Config, type Config as ConfigShape } from './config.js'
 
 export const name = 'prompt-master'
 export const inject = ['tools', 'llm', 'settings', 'subagents']
 export { Config }
 
@@ -38,23 +39,26 @@ export function apply(ctx: Context, config: ConfigShape) {
 
   // 注入 resolver 自定义 profile 源（兼证 Task 9 契约）
   setCustomProfileSource(() =>
     Object.entries(profileScope.get()).map(([id, profileJson]) => ({ id, profileJson })),
   )
 
   // R2: 装入默认 Intent Provider（intent 走 DSH one-shot subagent；ownerCtx 一次性绑定；返回 AuthorIntentFn 单参）
   //     必须早于 author 工具注册/调用 → 在 ctx.effect 之前完成
   setAuthorIntentProvider(createDefaultIntentProvider(ctx))
 
+  // 内置覆盖层 namespace（Task 7 spec §7.1）→ 注入 profile_list 工具
+  const overrides = registerOverridesNamespace(ctx)
+
   ctx.effect(() => {
     const disposers: (() => void)[] = []
     disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
     disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
     disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
-    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope })))
+    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope, overrides })))
     disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
     disposers.push(ctx.tools.register(registerCompileTool(ctx)))
     disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
     disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
     return () => { for (const d of disposers) d() }
   }, 'prompt-master.tools')
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/src/tools/profile-list.ts b/plugins/prompt-master/src/tools/profile-list.ts
index 3909c86..05a7545 100644
--- a/plugins/prompt-master/src/tools/profile-list.ts
+++ b/plugins/prompt-master/src/tools/profile-list.ts
@@ -1,13 +1,14 @@
 import { defineTool } from '@deepseek-ai/dsh-tools'
-import { getDefaultBuiltinProfiles, filterProfilesByKind, searchProfiles, clearProfileCache } from '../resolver/profiles/index.js'
+import { getDefaultBuiltinProfiles, clearProfileCache } from '../resolver/profiles/index.js'
 import { getTaxonomyMeta } from '../resolver/taxonomy.js'
+import { listProfilesMerged, validateImportPayload, recastImportedProfile, type OverridesApi } from '../pe-framework/profiles/storage-v2.js'
 import type { Config } from '../plugin/config.js'
 import type { Context } from '@deepseek-ai/cordis'
 
 export interface ProfileScope {
   get(): Record<string, string>
   update(patch: object): Promise<void>
   replace(section: object): Promise<void>
 }
 
 export type ProfileTarget = 'anima' | 'h3' | 'sd' | 'danbooru' | 'mj' | 'generic'
@@ -17,47 +18,64 @@ export type ProfileTarget = 'anima' | 'h3' | 'sd' | 'danbooru' | 'mj' | 'generic
  * 推导：outputFormat='minimax' → h3；tags 含 'Anima'/'anima3' → anima；
  * outputFormat∈{sd_tags,danbooru_tags} → sd|danbooru；kind='train' 的训练配方按 outputFormat 归入对应变体；其余 → generic。
  */
 export function profileTargets(p: { kind: string; outputFormat: string; tags: string[] }): ProfileTarget[] {
   if (p.outputFormat === 'minimax') return ['h3']
   if ((p.tags ?? []).some((t) => /anima/i.test(t))) return ['anima']
   if (p.outputFormat === 'sd_tags' || p.outputFormat === 'danbooru_tags') return ['sd', 'danbooru']
   return ['generic']
 }
 
-export function registerProfileListTool(_ctx: Context, _config: Config, deps: { scope: ProfileScope }) {
-  const { scope } = deps
+export function registerProfileListTool(_ctx: Context, _config: Config, deps: { scope: ProfileScope; overrides?: OverridesApi }) {
+  const { scope, overrides } = deps
   return defineTool({
     name: 'profile_list',
-    description: '查询/保存/删除提示词 profile（内置 + 自定义）。list/search 查询，get 单查，save/delete 管理自定义 profile。',
+    description: '查询/保存/删除提示词 profile（内置 + 自定义）。list/search 查询，get 单查，save/delete 管理自定义 profile，enable/sort 管理内置覆盖，export/import/validate_import 导入导出。',
     parameters: {
-      action: { type: 'string', default: 'list', description: 'list|search|get|save|delete' },
+      action: { type: 'string', default: 'list', description: 'list|search|get|save|delete|enable|sort|export|import|validate_import' },
       kind: { type: 'string', default: '', description: 'list/search 时按 kind 过滤：expand/reverse/minimax' },
       query: { type: 'string', default: '', description: 'list/search 时按关键字搜索' },
       target: { type: 'string', default: '', description: 'list/search 时按推导 target 过滤：anima|h3|sd|danbooru|mj|generic（缺省不过滤）' },
-      id: { type: 'string', default: '', description: 'get/save/delete 的目标 profile id' },
-      profile: { type: 'object', description: 'save 时要保存的 profile 对象（将强制 id 并保存为 builtin:false）', default: {}, additionalProperties: true },
+      id: { type: 'string', default: '', description: 'get/save/delete/enable/export 的目标 profile id' },
+      profile: { type: 'object', description: 'save 时要保存的 profile 对象（将强制 id 并保存为 builtin:false）；import 时为导入 payload', default: {}, additionalProperties: true },
+      enabled: { type: 'boolean', default: true, description: 'enable 时目标内置 profile 的启用状态' },
+      ids: { type: 'array', description: 'sort 时按顺序排列的内置 profile id 列表', default: [] },
     },
     output: {
       schema: { type: 'string', description: 'JSON 字符串' },
       render: (_a, v) => [{ type: 'text', text: v }],
     },
-    async execute(args: { action?: string; kind?: string; query?: string; target?: string; id?: string; profile?: Record<string, unknown> }) {
+    async execute(args: { action?: string; kind?: string; query?: string; target?: string; id?: string; profile?: Record<string, unknown>; enabled?: boolean; ids?: unknown[] }) {
       const action = String(args.action || 'list').trim()
       if (action === 'list' || action === 'search') {
         const kind = String(args.kind || '').trim()
         const query = String(args.query || '').trim()
         const target = args.target != null ? String(args.target).trim() : ''
-        let profiles = getDefaultBuiltinProfiles()
-        if (kind) profiles = filterProfilesByKind(kind)
+        // 两层合并读取（spec §7.1）：getDefaultBuiltinProfiles 已含 custom 层，按 builtin 标记拆分后走 listProfilesMerged
+        const all = getDefaultBuiltinProfiles()
+        let profiles = listProfilesMerged(
+          all.filter((p) => p.builtin),
+          all.filter((p) => !p.builtin),
+          overrides?.all() ?? {},
+        )
+        if (kind) {
+          const k = kind
+          profiles = profiles.filter((p) => {
+            if (k === 'minimax') return !!p.minimaxScenarioId
+            return p.kind === k
+          })
+        }
         if (target) profiles = profiles.filter((p) => profileTargets(p).includes(target as ProfileTarget))
-        if (query) profiles = searchProfiles(query)
+        if (query) {
+          const q = query.toLowerCase()
+          profiles = profiles.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)))
+        }
         return JSON.stringify({
           profiles: profiles.map((p) => ({ id: p.id, name: p.name, category: p.category, description: p.description, kind: p.kind, outputFormat: p.outputFormat, tags: p.tags, target: profileTargets(p)[0] ?? undefined })),
           taxonomy: getTaxonomyMeta(),
         })
       }
       if (action === 'get') {
         const id = String(args.id || '').trim()
         if (!id) throw new Error('id is required for get action')
         const current = scope.get()
         if (current[id]) return JSON.stringify({ profile: JSON.parse(current[id]), custom: true })
@@ -81,14 +99,61 @@ export function registerProfileListTool(_ctx: Context, _config: Config, deps: {
         if (getDefaultBuiltinProfiles().find((p) => p.id === id && p.builtin)) {
           throw new Error(`${id} 是内置 profile，不能删除`)
         }
         const current = scope.get()
         const next = { ...current }
         delete next[id]
         await scope.replace({ customProfiles: next })
         clearProfileCache()
         return JSON.stringify({ id, message: `Profile ${id} 已删除` })
       }
+      if (action === 'enable') {
+        if (!overrides) throw new Error('overrides namespace 未注册，无法启用/停用内置 profile')
+        const id = String(args.id || '').trim()
+        if (!id) throw new Error('id is required for enable action')
+        const enabled = args.enabled !== false
+        if (!getDefaultBuiltinProfiles().some((p) => p.builtin && p.id === id)) {
+          throw new Error(`内置 profile 不存在: ${id}`)
+        }
+        await overrides.set(id, { enabled })
+        clearProfileCache()
+        return JSON.stringify({ id, enabled, message: `内置 profile ${id} 已${enabled ? '启用' : '停用'}` })
+      }
+      if (action === 'sort') {
+        if (!overrides) throw new Error('overrides namespace 未注册，无法排序内置 profile')
+        const ids = Array.isArray(args.ids) ? args.ids.map((x) => String(x).trim()).filter(Boolean) : []
+        if (!ids.length) throw new Error('ids is required for sort action')
+        const builtinIds = new Set(getDefaultBuiltinProfiles().filter((p) => p.builtin).map((p) => p.id))
+        for (const id of ids) {
+          if (!builtinIds.has(id)) throw new Error(`内置 profile 不存在: ${id}`)
+        }
+        for (let i = 0; i < ids.length; i++) {
+          await overrides.set(ids[i], { enabled: true, sort: i })
+        }
+        clearProfileCache()
+        return JSON.stringify({ ids, message: `已按给定顺序排序 ${ids.length} 个内置 profile` })
+      }
+      if (action === 'export') {
+        const id = String(args.id || '').trim()
+        if (!id) throw new Error('id is required for export action')
+        const all = getDefaultBuiltinProfiles()
+        const merged = listProfilesMerged(all.filter((p) => p.builtin), all.filter((p) => !p.builtin), overrides?.all() ?? {})
+        const p = merged.find((x) => x.id === id)
+        if (!p) throw new Error(`Profile not found: ${id}`)
+        return JSON.stringify({ format: 'prompt-master-prompt-engineering', profile: p })
+      }
+      if (action === 'import' || action === 'validate_import') {
+        const builtinIds = getDefaultBuiltinProfiles().filter((p) => p.builtin).map((p) => p.id)
+        const r = validateImportPayload(args.profile, builtinIds)
+        if (!r.ok) return JSON.stringify({ ok: false, action, reason: r.reason })
+        if (action === 'validate_import') return JSON.stringify({ ok: true, action, message: '导入 payload 校验通过（未落盘）' })
+        const recast = recastImportedProfile(r.profile)
+        const newId = String(recast['id'])
+        const current = scope.get()
+        await scope.update({ customProfiles: { ...current, [newId]: JSON.stringify(recast) } })
+        clearProfileCache()
+        return JSON.stringify({ ok: true, action: 'import', id: newId, message: `已导入为自定义 profile ${newId}` })
+      }
       throw new Error(`Unknown action: ${action}`)
     },
   })
 }
\ No newline at end of file
diff --git a/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts b/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts
new file mode 100644
index 0000000..f272605
--- /dev/null
+++ b/plugins/prompt-master/tests/pe-framework/profiles/storage-v2.test.ts
@@ -0,0 +1,54 @@
+import { describe, expect, it } from 'vitest'
+import { listProfilesMerged, recastImportedProfile, validateImportPayload } from '../../../src/pe-framework/profiles/storage-v2.js'
+
+const builtins = [
+  { id: 'pe_a', name: 'A', kind: 'reverse', sort: 1 },
+  { id: 'pe_b', name: 'B', kind: 'expand', sort: 2 },
+]
+const custom = [{ id: 'pe_custom_x', name: 'X', kind: 'expand', sort: 5 }]
+
+describe('listProfilesMerged', () => {
+  it('disabled builtin excluded', () => {
+    const r = listProfilesMerged(builtins, custom, { pe_a: { enabled: false } })
+    expect(r.map((p) => p.id)).not.toContain('pe_a')
+    expect(r.map((p) => p.id)).toContain('pe_b')
+  })
+  it('override sort re-orders', () => {
+    const r = listProfilesMerged(builtins, custom, { pe_b: { enabled: true, sort: 0 } })
+    expect(r[0].id).toBe('pe_b')
+  })
+  it('stale override pointing to nonexistent builtin ignored', () => {
+    const r = listProfilesMerged(builtins, [], { pe_ghost: { enabled: false } })
+    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b'])
+  })
+  it('custom profiles merged after builtins (sort ordered)', () => {
+    const r = listProfilesMerged(builtins, custom, {})
+    expect(r.map((p) => p.id)).toEqual(['pe_a', 'pe_b', 'pe_custom_x'])
+  })
+})
+
+describe('validateImportPayload', () => {
+  it('rejects builtin id collision', () => {
+    const r = validateImportPayload({ id: 'pe_a', name: 'X', kind: 'expand', systemPrompt: 's' }, ['pe_a'])
+    expect(r.ok).toBe(false)
+  })
+  it('rejects missing systemPrompt', () => {
+    expect(validateImportPayload({ name: 'X', kind: 'expand' }, []).ok).toBe(false)
+  })
+  it('rejects bad kind', () => {
+    expect(validateImportPayload({ name: 'X', kind: 'bogus', systemPrompt: 's' }, []).ok).toBe(false)
+  })
+  it('accepts valid single profile', () => {
+    const r = validateImportPayload({ name: 'X', kind: 'expand', systemPrompt: 's' }, [])
+    expect(r.ok).toBe(true)
+  })
+})
+
+describe('recastImportedProfile', () => {
+  it('recasts id to pe_custom_+uuid and resets timestamps', () => {
+    const out = recastImportedProfile({ id: 'pe_old', name: 'X', kind: 'expand', systemPrompt: 's', createdAt: 1, updatedAt: 1 })
+    expect(out.id).toMatch(/^pe_custom_/)
+    expect(out.id).not.toBe('pe_old')
+    expect(out.createdAt).not.toBe(1)
+  })
+})
diff --git a/plugins/prompt-master/tests/plugin/profile-list-v2.test.ts b/plugins/prompt-master/tests/plugin/profile-list-v2.test.ts
new file mode 100644
index 0000000..4eb156c
--- /dev/null
+++ b/plugins/prompt-master/tests/plugin/profile-list-v2.test.ts
@@ -0,0 +1,144 @@
+// profile_list v2 集成：enable/sort 经 overrides namespace 持久化往返 + import 重铸（Task 7 spec §7.1）
+import { describe, expect, it } from 'vitest'
+import { registerProfileListTool } from '../../src/tools/profile-list.js'
+import { registerOverridesNamespace, type OverridesApi } from '../../src/pe-framework/profiles/storage-v2.js'
+import { stubCtx, runTool } from './helpers.js'
+import type { Context } from '@deepseek-ai/cordis'
+
+const cfg = { temperature: 0.7 }
+
+function makeScope() {
+  let store: Record<string, string> = {}
+  return {
+    store,
+    scope: {
+      get: () => store,
+      update: async (p: object) => { Object.assign(store, (p as any).customProfiles) },
+      replace: async (s: object) => {
+        const next = (s as any).customProfiles ?? {}
+        for (const k of Object.keys(store)) delete store[k]
+        Object.assign(store, next)
+      },
+    },
+  }
+}
+
+/** 内存版 settings register，供 registerOverridesNamespace 使用（最小表面） */
+function makeOverridesNamespace() {
+  let section: { builtinOverrides: Record<string, { enabled: boolean; sort?: number }> } = { builtinOverrides: {} }
+  const fakeCtx = {
+    settings: {
+      register: (_ns: unknown, _schema: unknown) => ({
+        get: () => section,
+        update: async (patch: object) => { section = { ...section, ...(patch as object) } as typeof section },
+        replace: async (s: object) => { section = s as typeof section },
+      }),
+    },
+  }
+  const api: OverridesApi = registerOverridesNamespace(fakeCtx as unknown as Context)
+  return { api, section: () => section }
+}
+
+function makeTool() {
+  const ctx = stubCtx()
+  const ms = makeScope()
+  const ns = makeOverridesNamespace()
+  const tool = registerProfileListTool(ctx as any, cfg, { scope: ms.scope, overrides: ns.api } as any)
+  return { ctx, scope: ms, ns, tool }
+}
+
+describe('profile_list enable/sort round-trip', () => {
+  it('enable=false persists override; merged list excludes that builtin', async () => {
+    const { ns, tool } = makeTool()
+    const id = 'pe_expand_natural'
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'enable', id, enabled: false })))
+    expect(r.enabled).toBe(false)
+    expect(ns.section().builtinOverrides[id]).toEqual({ enabled: false })
+    const list = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
+    expect(list.profiles.map((p: any) => p.id)).not.toContain(id)
+    expect(list.profiles.length).toBeGreaterThan(0)
+  })
+
+  it('re-enable restores the builtin; unknown builtin id rejected', async () => {
+    const { ns, tool } = makeTool()
+    const id = 'pe_expand_natural'
+    await runTool(null as never, tool as never, { action: 'enable', id, enabled: false })
+    await runTool(null as never, tool as never, { action: 'enable', id, enabled: true })
+    expect(ns.section().builtinOverrides[id]).toEqual({ enabled: true })
+    await expect(runTool(null as never, tool as never, { action: 'enable', id: 'pe_ghost', enabled: false })).rejects.toThrow(/不存在/)
+  })
+
+  it('sort persists order; merged list re-orders builtins by override sort', async () => {
+    const { ns, tool } = makeTool()
+    const list0 = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
+    const firstTwo: string[] = list0.profiles.filter((p: any) => !p.id.startsWith('pe_custom_')).slice(0, 2).map((p: any) => p.id)
+    const reversed = [...firstTwo].reverse()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'sort', ids: reversed })))
+    expect(r.ids).toEqual(reversed)
+    expect(ns.section().builtinOverrides[reversed[0]]).toEqual({ enabled: true, sort: 0 })
+    expect(ns.section().builtinOverrides[reversed[1]]).toEqual({ enabled: true, sort: 1 })
+    const list1 = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
+    const orderedIds = list1.profiles.map((p: any) => p.id)
+    expect(orderedIds.indexOf(reversed[0])).toBeLessThan(orderedIds.indexOf(reversed[1]))
+  })
+
+  it('sort rejects unknown builtin id', async () => {
+    const { tool } = makeTool()
+    await expect(runTool(null as never, tool as never, { action: 'sort', ids: ['pe_ghost'] })).rejects.toThrow(/不存在/)
+  })
+})
+
+describe('profile_list import / validate_import / export', () => {
+  it('validate_import reports pass without persisting', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'validate_import', profile: { name: 'X', kind: 'expand', systemPrompt: 's' } })))
+    expect(r.ok).toBe(true)
+    expect(Object.keys(scope.store).length).toBe(0)
+  })
+
+  it('validate_import reports failure with reason for bad payload', async () => {
+    const { tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'validate_import', profile: { name: 'X', kind: 'bogus', systemPrompt: 's' } })))
+    expect(r.ok).toBe(false)
+    expect(r.reason).toMatch(/kind/)
+  })
+
+  it('import recasts id to pe_custom_* and persists into customProfiles', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { name: 'X', kind: 'expand', systemPrompt: 's' } })))
+    expect(r.ok).toBe(true)
+    expect(r.id).toMatch(/^pe_custom_/)
+    const stored = JSON.parse(scope.store[r.id])
+    expect(stored.builtin).toBe(false)
+    expect(stored.createdAt).toBeGreaterThan(0)
+    // 重铸后的 id 不与任何内置 id 冲突
+    expect(r.id.startsWith('pe_custom_')).toBe(true)
+  })
+
+  it('import rejects payload carrying a builtin id (collision contract)', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { id: 'pe_expand_natural', name: 'X', kind: 'expand', systemPrompt: 's' } })))
+    expect(r.ok).toBe(false)
+    expect(r.reason).toMatch(/冲突/)
+    expect(Object.keys(scope.store).length).toBe(0)
+  })
+
+  it('import rejects missing systemPrompt with ok=false and no persistence', async () => {
+    const { scope, tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { name: 'X', kind: 'expand' } })))
+    expect(r.ok).toBe(false)
+    expect(Object.keys(scope.store).length).toBe(0)
+  })
+
+  it('export returns wire format with profile payload', async () => {
+    const { tool } = makeTool()
+    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'export', id: 'pe_expand_natural' })))
+    expect(r.format).toBe('prompt-master-prompt-engineering')
+    expect(r.profile.id).toBe('pe_expand_natural')
+  })
+
+  it('export of unknown id throws', async () => {
+    const { tool } = makeTool()
+    await expect(runTool(null as never, tool as never, { action: 'export', id: 'pe_ghost' })).rejects.toThrow(/not found/i)
+  })
+})
diff --git a/plugins/prompt-master/tests/plugin/registry.test.ts b/plugins/prompt-master/tests/plugin/registry.test.ts
index 3778125..d9a4dd8 100644
--- a/plugins/prompt-master/tests/plugin/registry.test.ts
+++ b/plugins/prompt-master/tests/plugin/registry.test.ts
@@ -10,21 +10,22 @@ function stubCtx() {
         return () => {}
       },
     },
     llm: { stream: async function* () {} },
     subagents: {
       start: async () => ({ id: 'stub', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }),
     },
     agent: { options: {} },
     settings: {
       register(ns: string, schema: unknown) {
-        expect(ns).toBe('prompt-master-custom-profiles')
+        // Task 7 起注册两个 namespace：customProfiles + 内置覆盖层（profile-overrides）
+        expect(['prompt-master-custom-profiles', 'prompt-master-profile-overrides']).toContain(ns)
         expect(schema).toBeTruthy()
         return { get: () => ({ customProfiles: {} }), update: async () => {}, replace: async () => {} }
       },
     },
     effect(cb: any) { cb() },   // cordis 4 同步 effect（Task 2 已证）
   }
   return { ctx, registered }
 }
 
 describe('plugin registration', () => {
```
