import { describe, expect, it } from 'vitest'
import { checkBoundaries } from '../../../src/pe-framework/safety/boundaries.js'

describe('hard boundaries (spec §5.4)', () => {
  it('minor × sensitive/explicit is rejected', () => {
    expect(checkBoundaries('1girl, loli, explicit pose', 'explicit')[0]?.gate).toBe('minor_content_conflict')
    expect(checkBoundaries('小学生 制服', 'sensitive')[0]?.gate).toBe('minor_content_conflict')
  })
  it('minor × safe passes (drawing children is legitimate at safe tier)', () => {
    expect(checkBoundaries('1boy, child, playing soccer', 'safe')).toEqual([])
  })
  it('adult body trait words are NOT minor markers', () => {
    expect(checkBoundaries('1girl, flat_chest, petite, nude', 'explicit')).toEqual([])
  })
  it('nonconsensual rejected at every tier', () => {
    for (const r of ['safe', 'sensitive', 'explicit'] as const) {
      expect(checkBoundaries('rape scene', r)[0]?.gate).toBe('nonconsensual_content_rejected')
    }
  })
  it('bestiality rejected', () => {
    expect(checkBoundaries('bestiality', 'explicit')[0]?.gate).toBe('bestiality_content_rejected')
  })
  it('clean corpus passes at every tier', () => {
    expect(checkBoundaries('masterpiece, 1girl, dress, garden', 'explicit')).toEqual([])
  })
})
