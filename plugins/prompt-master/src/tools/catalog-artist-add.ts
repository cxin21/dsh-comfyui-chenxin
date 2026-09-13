/**
 * catalog_artist_add（M4 T1，spec §13 延伸）——overlay 画师存在性登记，零 LLM。
 * 背景：M2 五批 authoring 中 miss/fuzzy 画师（xu beihong、good smile company 等）无法走
 * catalog_relations（端点存在性前置校验）——本工具补齐「验证失败→登记→catalog_search 复验」
 * 闭环，authoring 不再有死路。
 * 语义定夺（测试钉死）：①overlay 同库新表 artist_registry（与 relation_proposals 同一
 * overlay sqlite，源 tags.sqlite 零改动）②catalog_search 消费：canonical/alias 零命中时
 * 以 match_type 'alias' + source 'overlay_artist_registry' 返回（填隙，永不遮蔽真命中）
 * ③evidence 必填非空（防 LLM 灌水，无缺省）④幂等 = UPSERT 更新 evidence/confidence。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { registerArtist, listArtists } from '../pe-framework/anima-knowledge/relations.js'
import type { Config } from '../plugin/config.js'

type LogCtx = { logger?: { info?: (msg: string) => void } }
const logInfo = (ctx: Context | null, msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)

/** 纯写面（无 LLM）：catalog_artist_add → JSON 摘要 */
export function registerCatalogArtistAddTool(ctx: Context, _config: Config) {
  return defineTool({
    name: 'catalog_artist_add',
    description:
      'Anima catalog 画师存在性登记（M4）：catalog_search 验证失败的画师登记入 overlay 层' +
      '（源 tags.sqlite 零改动），登记后 catalog_search 以 alias + source=overlay_artist_registry ' +
      '返回（canonical/alias 零命中时填隙，永不遮蔽真命中）。evidence 必填非空（防 LLM 灌水）；' +
      '重复登记幂等（更新 evidence/confidence）。零 LLM。',
    parameters: {
      name: { type: 'string', description: '画师名（裸名，与 artist_hints 库约定一致）' },
      evidence: { type: 'array', description: '证据条目（必填非空：画师存在的真实证据链，如出典页面/任务记录）' },
      confidence: { type: 'number', description: '0-1，缺省 0.5' },
      model: { type: 'string', description: '登记来源模型标记（缺省 null）' },
    },
    output: {
      schema: { type: 'string', description: 'JSON {ok,created,name,name_normalized,confidence,evidence_count,registry_size}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { name?: string; evidence?: string[]; confidence?: number; model?: string }) {
      const r = registerArtist({
        name: String(args?.name ?? ''),
        evidence: Array.isArray(args?.evidence) ? args.evidence.map((e) => String(e)) : [],
        confidence: args?.confidence,
        model: args?.model === undefined ? undefined : String(args.model),
      })
      logInfo(ctx, `[prompt-master] catalog_artist_add → ${r.name_normalized} created=${r.created} evidence=${r.evidence.length}`)
      return JSON.stringify({
        ok: true,
        created: r.created,
        name: r.name,
        name_normalized: r.name_normalized,
        confidence: r.confidence,
        evidence_count: r.evidence.length,
        registry_size: listArtists(1_000_000).length,
      })
    },
  })
}
