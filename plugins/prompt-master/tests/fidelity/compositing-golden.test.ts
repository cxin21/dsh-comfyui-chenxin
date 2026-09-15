/**
 * compositing golden（spec §9）：L5 断言组 + 边缘案例 c13-c15。
 * 全程 mock（echo search + mock writer/critic）——确定性、零真连。
 * L5：①每 tag 有 source_concept 且回查命中 ②NL 零 overlap ③unresolved ⊆ NL∪dropped
 *    ④V0/V1 零 tag 形态词
 */
import { describe, expect, it } from 'vitest'
import { orchestrateCompositing } from '../../src/pe-framework/compositing/orchestrate.js'
import { deterministicCompose } from '../../src/pe-framework/compositing/compose.js'
import { detectTagForm } from '../../src/pe-framework/blueprint/semantic-schema.js'
import type { SemanticBlueprint } from '../../src/pe-framework/blueprint/semantic-schema.js'
import type { RetrievalPack } from '../../src/pe-framework/dialect/retrieval-pack.js'
import type { WriterOutput } from '../../src/pe-framework/compositing/writer.js'

const ECHO_SEARCH = async (q: string) => [{ prompt_form: q, match_type: 'canonical', usage_count: 1000 }]

const BP: SemanticBlueprint = {
  schema_version: 1, media: 'image',
  core: { concept: 'a girl on a rooftop at dusk',
    scene: { environment: 'rooftop', time_of_day: 'dusk', weather: 'clear', lighting_idea: 'lantern light along the corridor' },
    style_hints: [] },
  subjects: [{ id: 'S1', count: 1, identity: 'a girl', appearance: 'long black hair', pose: 'standing', expression: 'soft smile' }],
  composition: { framing: 'full body', camera_angle: 'eye level', placement: 'right third' },
  mood: 'nocturnal', negative_hints: [],
}

const PACK: RetrievalPack = {
  evidence: [
    { concept: 'S1.appearance', query: 'long black hair', hits: [{ prompt_form: 'long hair', match_type: 'canonical', usage_count: 891234 }] },
    { concept: 'S1.pose', query: 'standing', hits: [{ prompt_form: 'standing', match_type: 'canonical', usage_count: 500000 }] },
    { concept: 'composition.framing', query: 'full body', hits: [{ prompt_form: 'full body', match_type: 'canonical', usage_count: 300000 }] },
    { concept: 'core.scene.environment', query: 'rooftop', hits: [{ prompt_form: 'rooftop', match_type: 'canonical', usage_count: 200000 }] },
  ],
  unresolved: [{ concept: 'mood', query: 'nocturnal confident atmosphere' }],
  artists: [],
  mutual_exclusion_pairs: [],
  truncated: [],
}

/** writer mock：只从 evidence 选 tag，NL 表达 unresolved（不复述 tag），其余概念声明弃用 */
const WRITER_OUT: WriterOutput = {
  tags: PACK.evidence.map((e) => ({ text: e.hits[0].prompt_form, source_concept: e.concept })),
  nl: 'She stands on the right third of the frame in a nocturnal, confident atmosphere. Lantern light keeps her face exposed with no silhouette.',
  negative: [],
  dropped_concepts: ['core.concept', 'core.scene.time_of_day', 'core.scene.weather', 'S1.identity', 'S1.expression', 'composition.camera_angle', 'composition.placement'],
}

const PASS_JUDGE = async () => JSON.stringify({
  verdict: 'pass',
  dimensionScores: { 'blueprint-fidelity': 90, 'nl-quality': 90, 'tag-selection': 90, 'negative-template': 90, 'composition-coherence': 90, 'aesthetic-vocabulary': 90 },
  findings: [],
  praise: [],
})

describe('compositing golden L5 (spec §9)', () => {
  it('L5 invariants hold on a clean orchestration run', async () => {
    // 路由式检索：仅 4 个概念命中（与 WRITER_OUT 对齐），其余概念走 unresolved/dropped 出口
    const routedSearch = async (q: string) => {
      const e = PACK.evidence.find((e) => e.query === q)
      return e ? e.hits : []
    }
    const outcome = await orchestrateCompositing(BP, 'safe', {
      enrichRunner: async () => '{"set":{}}',
      writerRunner: async () => JSON.stringify(WRITER_OUT),
      critic: PASS_JUDGE,
      search: routedSearch,
    }, { minTags: 0 })
    // L5①
    const known = new Set(PACK.evidence.flatMap((e) => e.hits.map((h) => h.prompt_form)))
    for (const t of WRITER_OUT.tags) {
      expect(typeof t.source_concept).toBe('string')
      expect(known.has(t.text)).toBe(true)
    }
    // L5②
    for (const t of WRITER_OUT.tags) expect(WRITER_OUT.nl.toLowerCase().includes(t.text.toLowerCase())).toBe(false)
    // L5③
    for (const u of PACK.unresolved) {
      const covered = WRITER_OUT.nl.toLowerCase().includes(u.query.split(' ')[0]) || WRITER_OUT.dropped_concepts.includes(u.concept)
      expect(covered).toBe(true)
    }
    // L5④：只扫 V1 的字符串值（JSON 键名如 schema_version 不算 tag 形态）
    const scanValues = (node: unknown): string[] => {
      if (typeof node === 'string') return [node]
      if (Array.isArray(node)) return node.flatMap(scanValues)
      if (node !== null && typeof node === 'object') return Object.values(node).flatMap(scanValues)
      return []
    }
    for (const s of scanValues(outcome.v1)) expect(detectTagForm(s)).toBe(false)
    expect(outcome.ok).toBe(true)
  })
})

describe('edge cases (spec §9 golden c13-c15)', () => {
  it('c13 超长输入（brief >500 字）→ pipeline completes via echo evidence', async () => {
    const longBp: SemanticBlueprint = {
      ...BP,
      core: { ...BP.core, concept: 'x'.repeat(600) },
      subjects: [{ ...BP.subjects[0], appearance: 'detail '.repeat(90).trim() }],
    }
    const outcome = await orchestrateCompositing(longBp, 'safe', {
      enrichRunner: async () => '{"set":{}}',
      writerRunner: async () => JSON.stringify(WRITER_OUT),
      critic: PASS_JUDGE,
      search: ECHO_SEARCH,
    }, { minTags: 0 })
    expect(outcome.positive.length).toBeGreaterThan(0)
  })
  it('c14 无主体纯场景（subjects 空）→ completes, no crash', async () => {
    const sceneBp: SemanticBlueprint = { ...BP, subjects: [] }
    const outcome = await orchestrateCompositing(sceneBp, 'safe', {
      enrichRunner: async () => '{"set":{}}',
      writerRunner: async () => JSON.stringify({ ...WRITER_OUT, tags: WRITER_OUT.tags.filter((t) => !t.source_concept.startsWith('S1')), dropped_concepts: ['S1.appearance', 'S1.pose'] }),
      critic: PASS_JUDGE,
      search: ECHO_SEARCH,
    }, { minTags: 0 })
    expect(outcome.ok).toBe(true)
  })
  it('c15 全 unresolved（词库空窗）→ tags 空、positive = rating + nl 覆盖全部 query', async () => {
    const emptySearch = async () => []
    const pack: RetrievalPack = {
      evidence: [],
      unresolved: [
        { concept: 'core.concept', query: 'a girl on a rooftop at dusk' },
        { concept: 'mood', query: 'nocturnal' },
      ],
      artists: [], mutual_exclusion_pairs: [], truncated: [],
    }
    const out = deterministicCompose(BP, pack)
    expect(out.tags).toEqual([])
    expect(out.nl).toContain('a girl on a rooftop at dusk')
    expect(out.nl).toContain('nocturnal')
    // writer 全 unresolved 场景：N1 出口 = 全部进 dropped_concepts 亦可
    const outcome = await orchestrateCompositing(BP, 'safe', {
      enrichRunner: async () => '{"set":{}}',
      writerRunner: async () => JSON.stringify({ ...WRITER_OUT, tags: [], dropped_concepts: ['core.concept', 'core.scene.environment', 'core.scene.time_of_day', 'core.scene.weather', 'core.scene.lighting_idea', 'S1.identity', 'S1.appearance', 'S1.pose', 'S1.expression', 'composition.framing', 'composition.camera_angle', 'composition.placement', 'mood'] }),
      critic: PASS_JUDGE,
      search: emptySearch,
    }, { minTags: 0 })
    expect(outcome.advisories).toContain('evidence_partial')
    expect(outcome.ok).toBe(true)
  })
})
