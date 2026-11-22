import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  lastManifestCheck,
  overlayStatus,
  searchCatalogWithMeta,
  type CatalogQueryOptions,
} from '../pe-framework/dialect/anima-catalog.js';
import type { Config } from '../plugin/config.js';
import type { Context } from '@deepseek-ai/cordis';

/** 纯查询（无 LLM）：Anima 证据检索 → JSON 字符串 */
export function registerCatalogSearchTool(_ctx: Context, _config: Config) {
  return defineTool({
    name: 'catalog_search',
    description:
      'Anima tag-catalog 证据查询（canonical/alias/fuzzy/semantic/miss 级联；semantic 仅 auto 模式前级全空时末位追加，不自动改写）。返回命中列表与 overlay 状态；semantic 命中携带 score/text_source。',
    parameters: {
      tag: { type: 'string', description: '待查询标签（必填）' },
      mode: {
        type: 'string',
        default: 'auto',
        description: 'auto（canonical→alias→fuzzy→semantic 级联）/ exact（无 fuzzy，无 semantic）',
      },
      limit: { type: 'integer', default: 5, description: '返回命中数上限（1-20）' },
    },
    output: {
      schema: {
        type: 'string',
        description:
          'JSON 字符串 {hits[].candidate, hits[].score?, hits[].text_source?, advisories?, manifest, overlay}',
      },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { tag?: string; mode?: string; limit?: number }) {
      const tag = String(args.tag ?? '').trim();
      if (!tag) throw new Error('tag is required');
      const mode = (args.mode === 'exact' ? 'exact' : 'auto') as CatalogQueryOptions['mode'];
      let limit = args.limit ?? 5;
      if (!(limit >= 1 && limit <= 20)) limit = 5;
      const { hits, advisories: normAdvisories } = await searchCatalogWithMeta(tag, {
        mode,
        limit,
        tagLookup: undefined,
      });
      const status = overlayStatus();
      // G5：fuzzy 命中仅作候选参考；usage_count 低于采纳阈值时给出 advisory。
      // spec §3.2：semantic 命中的 score/text_source 透传进 result.hits（显式列出契约字段，
      // 防未来映射重构静默丢字段）；candidate 标记仍只认 fuzzy。
      const flagged = hits.map((h) => ({
        ...h,
        candidate: h.match_type === 'fuzzy',
        ...(h.score !== undefined ? { score: h.score } : {}),
        ...(h.text_source !== undefined ? { text_source: h.text_source } : {}),
      }));
      const advisories = [
        ...normAdvisories,
        ...flagged
          .filter((h) => h.match_type === 'fuzzy' && (h.usage_count ?? 0) < 1000)
          .map((h) => `fuzzy_below_threshold: usage_count=${h.usage_count ?? 0} 低于采纳阈值 1000，仅作候选参考`),
      ];
      return JSON.stringify({
        hits: flagged,
        advisories: advisories.length > 0 ? advisories : undefined,
        manifest: lastManifestCheck(),
        overlay: {
          status,
          advisory:
            status === 'available'
              ? undefined
              : 'overlay_unavailable：关系覆盖层未启用——运行 anima-prompt-v1 relation.submit 初始化后可见 overlay 命中',
        },
      });
    },
  });
}
