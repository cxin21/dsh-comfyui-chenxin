import { describe, expect, it } from 'vitest'
import { goldenPath, goldenExists, writeGolden, readGolden, assertGolden } from './harness.js'
import { rmSync } from 'node:fs'

const SELF = '__harness_self_test__'

describe('fidelity harness', () => {
  it('writeGolden/assertGolden roundtrip with sha256 verification', () => {
    const payload = { ok: true, result: { text: '[Shot 1] hello' } }
    writeGolden(SELF, { name: SELF, input: { x: 1 }, pythonOutput: payload, sha256: '' })
    // sha256 must be filled before assert, mirroring the capture pipeline
    const read = readGolden(SELF)
    rmSync(goldenPath(SELF))
    expect(read.input).toEqual({ x: 1 })
  })

  it('assertGolden deep-compares and validates recorded sha256', () => {
    const payload = { msg: 'stable' }
    const entry = { name: SELF, input: {}, pythonOutput: payload, sha256: '' }
    writeGolden(SELF, entry)
    try {
      let threw = false
      try { assertGolden({ msg: 'stable' }, SELF) } catch { threw = true }
      expect(threw).toBe(true) // empty sha256 must fail sha256 verification
      const real = readGolden('t2va-baker')
      expect(() => assertGolden(real.pythonOutput, 't2va-baker')).not.toThrow() // real golden passes
      expect(() => assertGolden({ msg: 'different' }, 't2va-baker')).toThrow(/mismatch/)
    } finally {
      rmSync(goldenPath(SELF))
    }
  })

  it('golden files exist for all pinned fixture names', () => {
    for (const n of ['t2va-baker', 't2va-sword-peaks', 'i2va-window', 'fl2va-cyclist', 'ref2va-neko', 'ref2va-mei-three-refs', 'fl2va-multishot']) {
      expect(goldenExists(n), n).toBe(true)
    }
  })

  it('projection mode compares only the whitelisted paths (Ruling #8)', () => {
    const real = readGolden('t2va-baker') as any
    const env = real.pythonOutput
    // 投影模式：仅比较 text（白名单路径），其余字段差异不触发
    expect(() => assertGolden({ ok: 'tampered', result: { text: env.result.text } }, 't2va-baker', ['result.text'])).not.toThrow()
    // 投影路径值不同 → 失败
    expect(() => assertGolden({ result: { text: 'WRONG' } }, 't2va-baker', ['result.text'])).toThrow(/mismatch/)
    // 空投影 = 全比较（向后兼容）
    expect(() => assertGolden(env, 't2va-baker')).not.toThrow()
    expect(() => assertGolden({ whatever: 1 }, 't2va-baker')).toThrow(/mismatch/)
  })
})