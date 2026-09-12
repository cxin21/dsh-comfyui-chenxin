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

  // ── M2 T1：两级匹配（ASCII \b<marker>\b 词边界 / CJK substring）──

  it('ASCII word-boundary: kidmo no longer collides with kid (M1 final-review named item)', () => {
    // M1 已知限制备案（t12）：kidmo ∋ kid 子串碰撞——合法画师风格名在升档会话误报。
    // \bkid\b 在 'kidmo' 内无尾边界（后随词字符 m）→ 放行；裸词 kid 仍阻断。
    expect(checkBoundaries('1girl, kidmo style, nude', 'sensitive')).toEqual([])
    expect(checkBoundaries('1girl, kid, playing, nude', 'sensitive')[0]?.gate).toBe('minor_content_conflict')
  })
  it('compound variants lolita/lolicon/shotacon: bare terms blocked, fashion compound passes', () => {
    // 政策语义（M2 T1 裁定）：lolita_fashion 是合法时装风格——'_' 是词字符，
    // \blolita\b 在 'lolita_fashion' 内无尾边界 → 放行；bare lolita / lolicon / shotacon
    // 是未成年语义暗语 → 阻断。shota 裸词在 'shotacon' 内无边界（后随 c），由独立变体承接。
    expect(checkBoundaries('1girl, lolita, nude', 'explicit')[0]?.matched).toBe('lolita')
    expect(checkBoundaries('1girl, lolicon, nude', 'explicit')[0]?.matched).toBe('lolicon')
    expect(checkBoundaries('1girl, shotacon, nude', 'explicit')[0]?.matched).toBe('shotacon')
    expect(checkBoundaries('1girl, lolita_fashion, elegant dress', 'explicit')).toEqual([])
    expect(checkBoundaries('1girl, shota_fashion, elegant dress', 'explicit')).toEqual([])
  })
  it('CJK markers keep substring matching (CJK text has no word boundaries)', () => {
    // CJK 无空格分词，\b 对 CJK 无意义——萝莉/儿童 在更长 CJK 串中仍命中（substring 语义保持）。
    expect(checkBoundaries('画一个萝莉风格的角色', 'sensitive')[0]?.matched).toBe('萝莉')
    expect(checkBoundaries('描绘儿童题材的画面', 'sensitive')[0]?.matched).toBe('儿童')
  })
  it('case-insensitive word-boundary matching', () => {
    expect(checkBoundaries('1girl, KID, nude', 'explicit')[0]?.gate).toBe('minor_content_conflict')
    expect(checkBoundaries('Nude children', 'sensitive')[0]?.gate).toBe('minor_content_conflict')
    // 词边界顺带消除 drapery∋rape 类潜在误报（M1 substring 语义的隐性缺陷，\b 下放行）
    expect(checkBoundaries('1girl, drapery dress, nude', 'explicit')).toEqual([])
  })
  // 备注（备案非断言）：\b 语义下英文复数形态（kids/babies/toddlers 等）不再被子串命中
  // ——计划 T1 裁定的补偿集仅 lolita/lolicon/shotacon 复合变体，复数补偿未列入，
  // 如需收紧须走评审扩充词表（不在本任务自行扩表）。
})
