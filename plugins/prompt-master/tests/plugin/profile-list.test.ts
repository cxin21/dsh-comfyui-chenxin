import { describe, expect, it, vi } from 'vitest'
import { registerProfileListTool, profileTargets } from '../../src/tools/profile-list.js'
import { stubCtx, runTool } from './helpers.js'

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

describe('profile_list', () => {
  it('lists builtin profiles + taxonomy (no llm)', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list' })))
    expect(v.profiles.length).toBeGreaterThan(0)
    expect(v.taxonomy).toBeTruthy()
    expect(ctx.llm.calls.length).toBe(0)
  })

  it('filters by kind and query', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list', kind: 'reverse' })))
    expect(v.profiles.every((p: any) => p.kind === 'reverse')).toBe(true)
  })

  it('saves a custom profile via scope then clears cache', async () => {
    const ctx = stubCtx()
    const { scope, store } = makeScope()
    const spy = vi.spyOn(await import('../../src/resolver/profiles/index.js'), 'clearProfileCache')
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'save', id: 'my_prof', profile: { name: 'My', kind: 'expand' } })))
    expect(JSON.parse(store['my_prof']).builtin).toBe(false)
    expect(spy).toHaveBeenCalled()
  })

  it('rejects deleting builtin profiles', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    await expect(runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'delete', id: 'pe_expand_natural' })).rejects.toThrow(/内置/)
  })
})

describe('profile_list target filter (A18 derivation)', () => {
  it('profileTargets derivation table', () => {
    expect(profileTargets({ kind: 'expand', outputFormat: 'minimax', tags: [] })).toEqual(['h3'])
    expect(profileTargets({ kind: 'reverse', outputFormat: 'sd_tags', tags: [] })).toEqual(['sd', 'danbooru'])
    expect(profileTargets({ kind: 'reverse', outputFormat: 'danbooru_tags', tags: [] })).toEqual(['sd', 'danbooru'])
    expect(profileTargets({ kind: 'reverse', outputFormat: 'prose', tags: ['Anima3'] })).toEqual(['anima'])
    expect(profileTargets({ kind: 'expand', outputFormat: 'prose', tags: [] })).toEqual(['generic'])
  })

  it('list target=h3 returns only minimax-outputFormat profiles (real 10)', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list', target: 'h3' })))
    expect(v.profiles.length).toBe(10)
    expect(v.profiles.every((p: any) => p.outputFormat === 'minimax')).toBe(true)
  })

  it('list target=sd|danbooru returns sd/danbooru-tags profiles (real 13)', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    const v = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list', target: 'danbooru' })))
    expect(v.profiles.length).toBe(13)
    expect(v.profiles.every((p: any) => ['sd_tags', 'danbooru_tags'].includes(p.outputFormat))).toBe(true)
  })

  it('no-target returns all builtins (compat); list target=anima has 0 builtin (anima via custom tags)', async () => {
    const ctx = stubCtx()
    const { scope } = makeScope()
    await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'save', id: 'my_anima', profile: { name: 'Anima', kind: 'reverse', tags: ['Anima3'] } })
    const all = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list' })))
    expect(all.profiles.length).toBe(56)
    const anima = JSON.parse(String(await runTool(ctx, registerProfileListTool(ctx as any, cfg, { scope } as any), { action: 'list', target: 'anima' })))
    expect(anima.profiles.length).toBe(0)
    expect(profileTargets({ kind: 'reverse', outputFormat: 'prose', tags: ['Anima3'] })).toEqual(['anima'])
  })
})