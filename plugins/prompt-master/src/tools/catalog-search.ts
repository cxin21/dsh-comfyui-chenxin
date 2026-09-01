import { defineTool } from '@deepseek-ai/dsh-tools'
import { lastManifestCheck, overlayStatus, searchCatalog, type CatalogHit, type CatalogQueryOptions } from '../pe-framework/dialect/anima-catalog.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

/** 纯查询（无 LLM）：Anima 证据检索 → JSON 字符串 */
export function registerCatalogSearchTool(_ctx: Context, _config: Config) {
  return defineTool({
    name: 'catalog_search',
    description:
      'Anima tag-catalog 证据查询（canonical/alias/fuzzy/miss 级联；不自动改写）。返回命中列表与 overlay 状态。',
    parameters: {
      tag: { type: 'string', description: '待查询标签（必填）' },
      mode: { type: 'string', default: 'auto', description: 'auto（canonical→alias→fuzzy 级联）/ exact（无 fuzzy）' },
      limit: { type: 'integer', default: 5, description: '返回命中数上限（1-20）' },
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串 {hits[].candidate, advisories?, manifest, overlay}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { tag?: string; mode?: string; limit?: number }) {
      const tag = String(args.tag ?? '').trim()
      if (!tag) throw new Error('tag is required')
      const mode = (args.mode === 'exact' ? 'exact' : 'auto') as CatalogQueryOptions['mode']
      let limit = args.limit ?? 5
      if (!(limit >= 1 && limit <= 20)) limit = 5
      const hits: CatalogHit[] = searchCatalog(tag, { mode, limit })
      const status = overlayStatus()
      // G5：fuzzy 命中仅作候选参考；usage_count 低于采纳阈值时给出 advisory
      const flagged = hits.map((h) => ({ ...h, candidate: h.match_type === 'fuzzy' }))
      const advisories = flagged
        .filter((h) => h.match_type === 'fuzzy' && (h.usage_count ?? 0) < 1000)
        .map((h) => `fuzzy_below_threshold: usage_count=${h.usage_count ?? 0} 低于采纳阈值 1000，仅作候选参考`)
      return JSON.stringify({
        hits: flagged,
        advisories: advisories.length > 0 ? advisories : undefined,
        manifest: lastManifestCheck(),
        overlay: { status, advisory: status === 'available' ? undefined : 'overlay_unavailable：关系覆盖层未启用——运行 anima-prompt-v1 relation.submit 初始化后可见 overlay 命中' },
      })
    },
  })
}