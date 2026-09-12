/**
 * 风格预设 registry（spec §4.2）——目录加载/去重/索引/过滤/查询，零 LLM。
 * 首次访问扫描 <plugin>/assets/style-presets/*.json 全量加载，逐条 validateStylePreset
 * （非法文件 throw，fail-fast 不静默丢弃）；重复 id：第二个及以后加 -N 后缀
 * （第 2 个 → id-2）+ advisory `style_preset_id_conflict:<原id>`；模块内缓存 load 结果。
 * 目录定位复用 resources/resolve.ts 的根路径注入机制（_presetRoot → DSH_COMFYUI_PRESET_ROOT
 * → import.meta.url 布局回溯，回溯点到 plugins/prompt-master 段，无硬编码相对层级猜测）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { getPresetRoot } from '../resources/resolve.js'
import { validateStylePreset, type StylePresetV2, type StyleCategory } from './schema.js'
import type { Rating } from '../types.js'

const RATING_RANK: Record<Rating, number> = { safe: 0, sensitive: 1, explicit: 2 }

const MODE_TARGETS = ['anima', 'h3', 'sd'] as const

/**
 * captain 附加项①（t15 加固）：applies_to 元素枚举校验——validateStylePreset 只校验数组形状，
 * 元素值在此收紧为 'anima'|'h3'|'sd'，非法元素 fail-fast（与非法文件同等对待，不静默丢弃）。
 */
export function assertAppliesToElements(preset: StylePresetV2, file: string): void {
  for (const t of preset.applies_to) {
    if (!(MODE_TARGETS as readonly string[]).includes(t)) {
      throw new Error(`style preset invalid (${file}): applies_to contains non-enum element "${String(t)}" (allowed: anima|h3|sd)`)
    }
  }
}

let _cache: { presets: StylePresetV2[]; advisories: string[] } | undefined
let _byId: Map<string, StylePresetV2> | undefined

/** 风格预设目录：跟随 resolve.ts 的根路径解析链；style-presets 位于插件目录（非 preset 根） */
function stylePresetsDir(): string {
  const configured = getPresetRoot()?.replace(/[\\/]+$/, '') || process.env.DSH_COMFYUI_PRESET_ROOT
  if (configured) return join(configured, 'plugins', 'prompt-master', 'assets', 'style-presets')
  try {
    const here = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, ''))
    const parts = here.split(/[\\/]/)
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === 'plugins' && parts[i + 1] === 'prompt-master') {
        return join(parts.slice(0, i + 2).join(sep), 'assets', 'style-presets')
      }
    }
  } catch { /* fall through */ }
  throw new Error('stylePresetsDir: cannot locate plugins/prompt-master/assets/style-presets (setPresetRoot / DSH_COMFYUI_PRESET_ROOT / preset layout)')
}

export function loadStylePresets(): { presets: StylePresetV2[]; advisories: string[] } {
  if (_cache && _byId) return _cache
  const dir = stylePresetsDir()
  const advisories: string[] = []
  const presets: StylePresetV2[] = []
  const seen = new Map<string, number>()
  const byId = new Map<string, StylePresetV2>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (e) {
      throw new Error(`style preset is not valid JSON (${file}): ${(e as Error)?.message ?? 'parse failed'}`)
    }
    const checked = validateStylePreset(raw)
    if (!checked.ok) throw new Error(`style preset invalid (${file}): ${checked.errors.join('; ')}`)
    let preset = checked.value
    assertAppliesToElements(preset, file)
    const n = seen.get(preset.id) ?? 0
    seen.set(preset.id, n + 1)
    if (n > 0) {
      advisories.push(`style_preset_id_conflict:${preset.id}`)
      preset = { ...preset, id: `${preset.id}-${n + 1}` }
    }
    presets.push(preset)
    if (!byId.has(preset.id)) byId.set(preset.id, preset)
  }
  _cache = { presets, advisories }
  _byId = byId
  return _cache
}

export function getStylePreset(id: string): StylePresetV2 | undefined {
  loadStylePresets()
  return _byId?.get(id)
}

export interface StylePresetFilter {
  category?: StyleCategory
  /** 语义：preset.rating ≤ maxRating 才可见（序 safe < sensitive < explicit，spec §4.2） */
  maxRating?: Rating
  appliesTo?: 'anima' | 'h3' | 'sd'
  /** 匹配 id/name 子串（大小写不敏感） */
  query?: string
}

export function listStylePresets(filter?: StylePresetFilter): StylePresetV2[] {
  const { presets } = loadStylePresets()
  const f = filter ?? {}
  const q = f.query?.toLowerCase()
  return presets.filter((p) => {
    if (f.category !== undefined && p.category !== f.category) return false
    if (f.maxRating !== undefined && RATING_RANK[p.rating] > RATING_RANK[f.maxRating]) return false
    if (f.appliesTo !== undefined && !p.applies_to.includes(f.appliesTo)) return false
    if (q !== undefined && !p.id.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) return false
    return true
  })
}

export function stylePresetCount(): number {
  return loadStylePresets().presets.length
}
