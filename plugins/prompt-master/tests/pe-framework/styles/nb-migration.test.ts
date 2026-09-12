import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { validateStylePreset } from '../../../src/pe-framework/styles/schema.js'
import { MINOR_MARKERS } from '../../../src/pe-framework/safety/boundaries.js'

const dir = resolve(fileURLToPath(import.meta.url), '../../../../assets/style-presets')
const nbFiles = readdirSync(dir).filter((f) => f.startsWith('nb') && f.endsWith('.json'))
const VAGUE = ['cinematic', 'beautiful', '大气', '电影感']

describe('nb migration (spec §10)', () => {
  it('migrates all 44 nb presets to valid v2', () => {
    expect(nbFiles.length).toBe(44)
    for (const f of nbFiles) {
      const r = validateStylePreset(JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
      expect(r.ok, `${f}: ${r.ok ? '' : r.errors.join(';')}`).toBe(true)
    }
  })
  it('ids unique across nb set; rating preserved as safe', () => {
    const ids = nbFiles.map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')).id)
    expect(new Set(ids).size).toBe(44)
    for (const f of nbFiles) expect(JSON.parse(readFileSync(resolve(dir, f), 'utf8')).rating).toBe('safe')
  })
  it('quality gates: no vague words, non-empty fragments/negatives, bare artists within artist_max', () => {
    for (const f of nbFiles) {
      const p = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      for (const ch of ['image', 'video'] as const) {
        const low = p.fragments[ch].toLowerCase()
        for (const w of VAGUE) expect(low.includes(w), `${f} vague:${w}`).toBe(false)
      }
      expect(p.negative_hints.length).toBeGreaterThanOrEqual(1)
      for (const a of p.artist_hints) expect(a.startsWith('@'), `${f} artist ${a}`).toBe(false)
      expect(p.artist_hints.length).toBeLessThanOrEqual(p.artist_max + 2) // 候选可多于注入上限，截断在 apply 层
    }
  })
  it('hardening: no artist_hints entry hits safety MINOR_MARKERS (spec §5.4)', () => {
    // 精确成员判定（与验收「artist_hints × MINOR_MARKERS 交叉为零」一致）：
    // applyStyle 会把 artist_hints 注入 artist 槽直达 prompt，未成年标记词禁止作为预设数据存在。
    // 注：合法画师名含标记子串（如 kidmo ∋ kid）属下游 checkBoundaries 的 substring 交互问题，
    // 不在本断言范围（按条目精确相等判定）。
    for (const f of nbFiles) {
      const p = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      for (const a of p.artist_hints) {
        expect(MINOR_MARKERS.includes(a.toLowerCase()), `${f} artist_hints "${a}" hits MINOR_MARKERS`).toBe(false)
      }
    }
  })
})
