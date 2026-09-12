/**
 * 风格库兼容 shim（spec §4.2/§4.3，M1 Phase 内过渡）。
 * 实现已迁至 styles/apply.ts（registry 支撑）：applyStyle 自此处再导出，原位引用不断。
 * MINIMAL_STYLES 改为从 registry 派生的兼容导出（@deprecated，Phase 内删除直接引用）：
 * 以 v0 StyleTemplate 形状投影 builtin-migrated 预设（prompt_fragments/artistHints 字段名
 * 保持旧测试与 golden 比对契约），数据权威源为 assets/style-presets/*.json。
 */
import { loadStylePresets } from '../styles/registry.js'

export { applyStyle } from '../styles/apply.js'

export interface StyleTemplate {
  id: string
  name: string
  base?: string                 // 基底风格：媒介/画风
  theme?: string                // 主题风格：赛博朋克/和风/废土（影响场景+配色）
  palette?: string              // 情绪配色
  prompt_fragments: { image: string; video: string }
  /** B8：画师候选（catalog 验证存在的裸名，3 位；投影 → anima artist 槽） */
  artistHints: string[]
  applies_to: string[]          // 适用模型/方言 id
  negative_hints: string[]      // 该风格应规避的负向提示（具体名词）
}

/** @deprecated 数据已迁 assets/style-presets/*.json（registry 为权威源）；仅兼容旧消费方，勿新增引用 */
export const MINIMAL_STYLES: StyleTemplate[] = loadStylePresets()
  .presets
  .filter((p) => p.source === 'builtin-migrated')
  .map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.base !== undefined ? { base: p.base } : {}),
    ...(p.theme !== undefined ? { theme: p.theme } : {}),
    ...(p.palette !== undefined ? { palette: p.palette } : {}),
    prompt_fragments: { image: p.fragments.image, video: p.fragments.video },
    artistHints: [...p.artist_hints],
    applies_to: [...p.applies_to],
    negative_hints: [...p.negative_hints],
  }))
