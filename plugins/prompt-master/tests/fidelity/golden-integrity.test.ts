import { describe, expect, it } from 'vitest'
import { readGolden } from './harness.js'
import { createHash } from 'node:crypto'

const SUCCESS_NAMES = ['t2va-baker', 't2va-sword-peaks', 'i2va-window', 'fl2va-cyclist', 'ref2va-neko', 'ref2va-mei-three-refs']
const FAILURE_NAMES = ['fl2va-multishot']

describe('golden integrity (M5)', () => {
  it('every golden sha256 matches its recorded pythonOutput', () => {
    for (const name of [...SUCCESS_NAMES, ...FAILURE_NAMES]) {
      const entry = readGolden(name)
      const expectSha = createHash('sha256').update(JSON.stringify(entry.pythonOutput)).digest('hex')
      expect(expectSha, `${name} sha256 self-consistent`).toBe(entry.sha256)
    }
  })

  it('success goldens carry ok=true and a non-empty inner text', () => {
    for (const name of SUCCESS_NAMES) {
      const entry = readGolden(name)
      const env = entry.pythonOutput as any
      expect(env.ok, `${name} ok`).toBe(true)
      expect(String(env.result?.text || '').length, `${name} text`).toBeGreaterThan(0)
      expect(String(env.result?.budget?.char_limit || ''), `${name} char_limit`).toBe('7000')
    }
  })

  it('failure golden pins the official validation envelope', () => {
    const entry = readGolden('fl2va-multishot')
    const env = entry.pythonOutput as any
    expect(env.ok).toBe(false)
    expect(env.errors?.[0]?.code).toBe('validation_failed')
  })
})