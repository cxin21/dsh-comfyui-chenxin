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
  // ── M2 T1b：复数形态覆盖（后缀模式 + 词干变形变体表，spec §5.4 TR1 follow-up）──
  // t39 备案的 \b 语义复数逃逸（kids/babies/toddlers 等不再被子串命中）由 captain 裁定收口：
  // ASCII marker 升级为 \b<marker>(?:s|es|ren)?\b 后缀模式 + y→ies 词干变形显式变体表。

  it('suffix pattern covers regular English plurals (per-word blocking)', () => {
    // 逐词断言：kids/lolis/lolitas/toddlers/infants/shotacons 为后缀模式新增覆盖；
    // children 在词表内既有显式条目（child+ren 后缀冗余无害——双路径同命中）。
    const plurals = ['kids', 'lolis', 'lolitas', 'toddlers', 'infants', 'shotacons', 'children']
    for (const w of plurals) {
      expect(checkBoundaries(`1girl, ${w}, nude`, 'sensitive')[0]?.gate, w).toBe('minor_content_conflict')
    }
  })

  it('stem-changing plural variants: babies blocked (y→ies table entry)', () => {
    // baby→babies 是 y→ies 词干变形——后缀模式 (?:s|es|ren) 无法覆盖（babies 无 'y'），
    // 由显式变体表承接。matched 报告变体词本身。
    expect(checkBoundaries('1girl, babies, nude', 'sensitive')[0]?.matched).toBe('babies')
  })

  it('policy semantics preserved under suffix pattern: fashion compounds still pass', () => {
    // '_' 是词字符：lolita_fashion / shota_fashion / lolitas_fashion（复数扩展同语义）
    // 在 lolita(?:s)? 与尾 '_' 之间无边界 → 放行（t39 政策裁定的后缀模式自然延伸）。
    expect(checkBoundaries('1girl, lolita_fashion, elegant dress', 'explicit')).toEqual([])
    expect(checkBoundaries('1girl, shota_fashion, elegant dress', 'explicit')).toEqual([])
    expect(checkBoundaries('1girl, lolitas_fashion, elegant dress', 'explicit')).toEqual([])
  })

  it('word-boundary collision guards survive the optional suffix (kidmo/drapery/shotacon internals)', () => {
    // 后缀组可选不改变首/尾边界判定：kidmo（尾随 m）、drapery∋rape（首随 d）、
    // shota∋shotacon（尾随 c）依旧不命中。
    expect(checkBoundaries('1girl, kidmo style, nude', 'sensitive')).toEqual([])
    expect(checkBoundaries('1girl, drapery dress, nude', 'explicit')).toEqual([])
    expect(checkBoundaries('1girl, shotacon, nude', 'explicit')[0]?.matched).toBe('shotacon')
  })

  it('bestiality stem-changing plural variant: bestialities rejected at every tier', () => {
    // bestiality→bestialities 同为 y→ies（扫描范围超出任务字面 20E+10S+minor，
    // 硬闸门同类逃逸按保守方向扩表备案——见 boundaries.ts 变体表注释）。
    for (const r of ['safe', 'sensitive', 'explicit'] as const) {
      expect(checkBoundaries(`drawings of bestialities`, r)[0]?.gate).toBe('bestiality_content_rejected')
    }
  })

  it('CJK markers keep substring matching (CJK text has no word boundaries)', () => {
    // CJK 无空格分词，\b 对 CJK 无意义——萝莉/儿童 在更长 CJK 串中仍命中（substring 语义保持）。
    expect(checkBoundaries('画一个萝莉风格的角色', 'sensitive')[0]?.matched).toBe('萝莉')
    expect(checkBoundaries('描绘儿童题材的画面', 'sensitive')[0]?.matched).toBe('儿童')
  })
  it('case-insensitive word-boundary matching', () => {
    expect(checkBoundaries('1girl, KID, nude', 'explicit')[0]?.gate).toBe('minor_content_conflict')
    expect(checkBoundaries('Nude CHILDREN', 'sensitive')[0]?.gate).toBe('minor_content_conflict')
    // 词边界顺带消除 drapery∋rape 类潜在误报（M1 substring 语义的隐性缺陷，\b 下放行）
    expect(checkBoundaries('1girl, drapery dress, nude', 'explicit')).toEqual([])
  })
  // 备注（M2 T1b 收口）：t39 备案的英文复数逃逸已由后缀模式 + y→ies 变体表收口
  // （kids/lolis/lolitas/toddlers/infants/children/shotacons 后缀覆盖；babies 变体表；
  // pussies/nudities 属 rating 词表侧处置——见 anima-rating.test.ts 升档断言与 rating.ts 扫描结论注释）。
})
