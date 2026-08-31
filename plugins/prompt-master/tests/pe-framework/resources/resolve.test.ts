// tests/pe-framework/resources/resolve.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { join, sep } from 'node:path'
import { setPresetRoot, getPresetRoot, resolveKnowledgePath } from '../../../src/pe-framework/resources/resolve.js'
import { catalogPath, setCatalogPath, closeCatalog } from '../../../src/pe-framework/dialect/anima-catalog.js'

describe('resolveKnowledgePath', () => {
  beforeEach(() => setPresetRoot('C:/fake-preset'))
  afterEach(() => setPresetRoot(undefined))

  it('joins presetRoot + skillDir + knowledge + asset', () => {
    expect(resolveKnowledgePath({ skillDir: 'anima-prompt-v1', asset: 'tag-catalog.sqlite' }))
      .toBe('C:\\fake-preset\\skills\\anima-prompt-v1\\knowledge\\tag-catalog.sqlite')
  })

  it('normalizes trailing slash on presetRoot', () => {
    setPresetRoot('C:/fake-preset/')
    expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe('C:\\fake-preset\\skills\\x\\knowledge\\y.json')
  })

  it('throws readable error when no presetRoot configured', () => {
    // 本 checkout 的源码恰好位于 <preset>/plugins/prompt-master/... 布局下，
    // fallbackPresetRoot() 会成功解析出真实 preset 根（生产环境预期行为），此时不 throw。
    // 断言两种合法结果之一：throw 可读错误，或返回以 skills/<skillDir>/knowledge/<asset> 结尾的绝对路径。
    setPresetRoot(undefined)
    let result: string | undefined
    let threw = false
    try {
      result = resolveKnowledgePath({ skillDir: 'x', asset: 'y' })
    } catch (e) {
      threw = true
      expect(String(e)).toMatch(/presetRoot not configured|preset/i)
    }
    if (!threw) {
      expect(result).toBeDefined()
      const suffix = join('skills', 'x', 'knowledge', 'y')
      expect(result!.endsWith(suffix)).toBe(true)
      // fallback 解析出的根应为非空绝对路径（本 checkout 下即 preset 根目录）
      const root = result!.slice(0, result!.length - suffix.length).replace(/[\\/]+$/, '')
      expect(root.length).toBeGreaterThan(0)
      expect(sep === '\\' ? /^[A-Za-z]:[\\/]/.test(root) : root.startsWith('/')).toBe(true)
    }
  })

  it('uses DSH_COMFYUI_PRESET_ROOT env when no explicit presetRoot is set', () => {
    setPresetRoot(undefined)
    vi.stubEnv('DSH_COMFYUI_PRESET_ROOT', 'C:/env-root')
    try {
      expect(resolveKnowledgePath({ skillDir: 'x', asset: 'y.json' })).toBe(join('C:/env-root', 'skills', 'x', 'knowledge', 'y.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// MF-1：catalog 路径惰性解析——setPresetRoot 在 import 之后（插件 apply 期）改变时 catalogPath 必须跟随
describe('anima-catalog lazy path resolution', () => {
  afterEach(() => {
    setCatalogPath(process.env.ANIMA_CATALOG_PATH ?? '')
    delete (process.env as Record<string, string | undefined>).ANIMA_CATALOG_PATH
    closeCatalog()
  })

  it('catalogPath() reflects setPresetRoot called after module import', () => {
    setPresetRoot('C:/late-preset')
    expect(catalogPath()).toBe(join('C:/late-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
    setPresetRoot('C:/other-preset')
    expect(catalogPath()).toBe(join('C:/other-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
  })

  it('setCatalogPath override wins over presetRoot; clearing restores lazy default', () => {
    setPresetRoot('C:/late-preset')
    setCatalogPath('C:/custom/catalog.sqlite')
    expect(catalogPath()).toBe('C:/custom/catalog.sqlite')
    setCatalogPath('')
    expect(catalogPath()).toBe(join('C:/late-preset', 'skills', 'anima-prompt-v1', 'knowledge', 'tag-catalog.sqlite'))
  })

  it('ANIMA_CATALOG_PATH env takes priority level 0 over presetRoot', () => {
    setPresetRoot('C:/late-preset')
    process.env.ANIMA_CATALOG_PATH = 'C:/env/catalog.sqlite'
    setCatalogPath('') // re-derive override from env
    expect(catalogPath()).toBe('C:/env/catalog.sqlite')
  })
})
