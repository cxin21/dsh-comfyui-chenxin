import { describe, expect, it } from 'vitest'
import { applySemanticPatch } from '../../../src/pe-framework/compositing/enrich.js'
import type { SemanticBlueprint } from '../../../src/pe-framework/blueprint/semantic-schema.js'

const V0: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'lantern light' },
    style_hints: ['flat cel shading'] },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal', negative_hints: [],
}

describe('applySemanticPatch additions 追加语义（spec §4，自我复审修正）', () => {
  it('additions 数组追加而非覆盖：V0 原项保留', () => {
    const raw = JSON.stringify({ set: {}, additions: { core: { style_hints: ['muted palette'] } } })
    const r = applySemanticPatch(V0, raw)
    expect(r.v1.core.style_hints).toEqual(['flat cel shading', 'muted palette'])
  })
  it('additions 数组去重：重复项不重复追加', () => {
    const raw = JSON.stringify({ set: {}, additions: { core: { style_hints: ['flat cel shading'] } } })
    const r = applySemanticPatch(V0, raw)
    expect(r.v1.core.style_hints).toEqual(['flat cel shading'])
  })
  it('mood 字符串增量追加（未包含才加）', () => {
    const raw = JSON.stringify({ set: {}, additions: { mood: 'quiet tension' } })
    const r = applySemanticPatch(V0, raw)
    expect(r.v1.mood).toBe('nocturnal, quiet tension')
  })
  it('mood 已包含的细节不重复追加', () => {
    const raw = JSON.stringify({ set: {}, additions: { mood: 'nocturnal' } })
    const r = applySemanticPatch(V0, raw)
    expect(r.v1.mood).toBe('nocturnal')
  })
  it('set 路径仍为覆盖语义（lighting_idea 替换）', () => {
    const raw = JSON.stringify({ set: { core: { scene: { lighting_idea: 'moonless glow' } } } })
    const r = applySemanticPatch(V0, raw)
    expect(r.v1.core.scene.lighting_idea).toBe('moonless glow')
  })
})
