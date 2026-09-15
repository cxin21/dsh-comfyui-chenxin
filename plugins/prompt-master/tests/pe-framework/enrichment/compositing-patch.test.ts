import { describe, expect, it } from 'vitest'
import { prunePatchPaths, COMPOSITING_SET_ALLOWED, COMPOSITING_ADDITIONS_ALLOWED } from '../../../src/pe-framework/enrichment/engine.js'

describe('prunePatchPaths (spec §4)', () => {
  it('allowed leaf kept, forbidden leaf dropped with count', () => {
    const patch = { core: { scene: { lighting_idea: 'keep', environment: 'drop' } }, mood: 'keep', concept: 'drop' }
    const n = prunePatchPaths(patch, COMPOSITING_SET_ALLOWED)
    expect(n).toBe(2)
    expect((patch.core.scene as Record<string, unknown>).lighting_idea).toBe('keep')
    expect(patch.mood).toBe('keep')
    expect(patch.concept).toBeUndefined()
    expect((patch.core.scene as Record<string, unknown>).environment).toBeUndefined()
  })
  it('prefix descent: allowed deeper path keeps intermediate nodes', () => {
    const patch = { core: { scene: { lighting_idea: 'x' } } }
    expect(prunePatchPaths(patch, COMPOSITING_SET_ALLOWED)).toBe(0)
  })
  it('whole-branch drop when nothing under prefix allowed', () => {
    const patch = { subjects: [{ id: 'S1' }] }
    expect(prunePatchPaths(patch, COMPOSITING_SET_ALLOWED)).toBe(1)
  })
  it('additions whitelist: style_hints kept, concept dropped', () => {
    const patch = { core: { style_hints: ['a'], concept: 'drop' } }
    expect(prunePatchPaths(patch, COMPOSITING_ADDITIONS_ALLOWED)).toBe(1)
    expect((patch.core as Record<string, unknown>).style_hints).toEqual(['a'])
  })
  it('empty object leaf is a no-op (not counted)', () => {
    const patch = { core: { scene: {} }, mood: 'x' }
    expect(prunePatchPaths(patch, COMPOSITING_SET_ALLOWED)).toBe(0)
  })
})
