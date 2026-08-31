import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchCatalog, overlayStatus, type CatalogHit, type CatalogQueryOptions } from '../pe-framework/dialect/anima-catalog.js'
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
      schema: { type: 'string', description: 'JSON 字符串 {hits, overlay}' },
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
      return JSON.stringify({
        hits,
        overlay: { status, advisory: status === 'available' ? undefined : 'overlay_unavailable' },
      })
    },
  })
}