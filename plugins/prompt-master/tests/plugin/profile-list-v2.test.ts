// profile_list v2 集成：enable/sort 经 overrides namespace 持久化往返 + import 重铸（Task 7 spec §7.1）
import { describe, expect, it } from 'vitest'
import { registerProfileListTool } from '../../src/tools/profile-list.js'
import { registerOverridesNamespace, type OverridesApi } from '../../src/pe-framework/profiles/storage-v2.js'
import { stubCtx, runTool } from './helpers.js'
import type { Context } from '@deepseek-ai/cordis'

const cfg = { temperature: 0.7 }

function makeScope() {
  let store: Record<string, string> = {}
  return {
    store,
    scope: {
      get: () => store,
      update: async (p: object) => { Object.assign(store, (p as any).customProfiles) },
      replace: async (s: object) => {
        const next = (s as any).customProfiles ?? {}
        for (const k of Object.keys(store)) delete store[k]
        Object.assign(store, next)
      },
    },
  }
}

/** 内存版 settings register，供 registerOverridesNamespace 使用（最小表面） */
function makeOverridesNamespace() {
  let section: { builtinOverrides: Record<string, { enabled: boolean; sort?: number }> } = { builtinOverrides: {} }
  const fakeCtx = {
    settings: {
      register: (_ns: unknown, _schema: unknown) => ({
        get: () => section,
        update: async (patch: object) => { section = { ...section, ...(patch as object) } as typeof section },
        replace: async (s: object) => { section = s as typeof section },
      }),
    },
  }
  const api: OverridesApi = registerOverridesNamespace(fakeCtx as unknown as Context)
  return { api, section: () => section }
}

function makeTool() {
  const ctx = stubCtx()
  const ms = makeScope()
  const ns = makeOverridesNamespace()
  const tool = registerProfileListTool(ctx as any, cfg, { scope: ms.scope, overrides: ns.api } as any)
  return { ctx, scope: ms, ns, tool }
}

describe('profile_list enable/sort round-trip', () => {
  it('enable=false persists override; merged list excludes that builtin', async () => {
    const { ns, tool } = makeTool()
    const id = 'pe_expand_natural'
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'enable', id, enabled: false })))
    expect(r.enabled).toBe(false)
    expect(ns.section().builtinOverrides[id]).toEqual({ enabled: false })
    const list = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
    expect(list.profiles.map((p: any) => p.id)).not.toContain(id)
    expect(list.profiles.length).toBeGreaterThan(0)
  })

  it('re-enable restores the builtin; unknown builtin id rejected', async () => {
    const { ns, tool } = makeTool()
    const id = 'pe_expand_natural'
    await runTool(null as never, tool as never, { action: 'enable', id, enabled: false })
    await runTool(null as never, tool as never, { action: 'enable', id, enabled: true })
    expect(ns.section().builtinOverrides[id]).toEqual({ enabled: true })
    await expect(runTool(null as never, tool as never, { action: 'enable', id: 'pe_ghost', enabled: false })).rejects.toThrow(/不存在/)
  })

  it('sort persists order; merged list re-orders builtins by override sort', async () => {
    const { ns, tool } = makeTool()
    const list0 = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
    const firstTwo: string[] = list0.profiles.filter((p: any) => !p.id.startsWith('pe_custom_')).slice(0, 2).map((p: any) => p.id)
    const reversed = [...firstTwo].reverse()
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'sort', ids: reversed })))
    expect(r.ids).toEqual(reversed)
    expect(ns.section().builtinOverrides[reversed[0]]).toEqual({ enabled: true, sort: 0 })
    expect(ns.section().builtinOverrides[reversed[1]]).toEqual({ enabled: true, sort: 1 })
    const list1 = JSON.parse(String(await runTool(null as never, tool as never, { action: 'list' })))
    const orderedIds = list1.profiles.map((p: any) => p.id)
    expect(orderedIds.indexOf(reversed[0])).toBeLessThan(orderedIds.indexOf(reversed[1]))
  })

  it('sort rejects unknown builtin id', async () => {
    const { tool } = makeTool()
    await expect(runTool(null as never, tool as never, { action: 'sort', ids: ['pe_ghost'] })).rejects.toThrow(/不存在/)
  })
})

describe('profile_list import / validate_import / export', () => {
  it('validate_import reports pass without persisting', async () => {
    const { scope, tool } = makeTool()
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'validate_import', profile: { name: 'X', kind: 'expand', systemPrompt: 's' } })))
    expect(r.ok).toBe(true)
    expect(Object.keys(scope.store).length).toBe(0)
  })

  it('validate_import reports failure with reason for bad payload', async () => {
    const { tool } = makeTool()
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'validate_import', profile: { name: 'X', kind: 'bogus', systemPrompt: 's' } })))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/kind/)
  })

  it('import recasts id to pe_custom_* and persists into customProfiles', async () => {
    const { scope, tool } = makeTool()
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { name: 'X', kind: 'expand', systemPrompt: 's' } })))
    expect(r.ok).toBe(true)
    expect(r.id).toMatch(/^pe_custom_/)
    const stored = JSON.parse(scope.store[r.id])
    expect(stored.builtin).toBe(false)
    expect(stored.createdAt).toBeGreaterThan(0)
    // 重铸后的 id 不与任何内置 id 冲突
    expect(r.id.startsWith('pe_custom_')).toBe(true)
  })

  it('import rejects payload carrying a builtin id (collision contract)', async () => {
    const { scope, tool } = makeTool()
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { id: 'pe_expand_natural', name: 'X', kind: 'expand', systemPrompt: 's' } })))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/冲突/)
    expect(Object.keys(scope.store).length).toBe(0)
  })

  it('import rejects missing systemPrompt with ok=false and no persistence', async () => {
    const { scope, tool } = makeTool()
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'import', profile: { name: 'X', kind: 'expand' } })))
    expect(r.ok).toBe(false)
    expect(Object.keys(scope.store).length).toBe(0)
  })

  it('export returns wire format with profile payload', async () => {
    const { tool } = makeTool()
    const r = JSON.parse(String(await runTool(null as never, tool as never, { action: 'export', id: 'pe_expand_natural' })))
    expect(r.format).toBe('prompt-master-prompt-engineering')
    expect(r.profile.id).toBe('pe_expand_natural')
  })

  it('export of unknown id throws', async () => {
    const { tool } = makeTool()
    await expect(runTool(null as never, tool as never, { action: 'export', id: 'pe_ghost' })).rejects.toThrow(/not found/i)
  })
})
