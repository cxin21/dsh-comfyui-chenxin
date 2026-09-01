import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  submitProposal,
  listProposals,
  decideProposal,
  openOverlayDb,
  overlayPath,
  type ProposalInput,
} from '../pe-framework/anima-knowledge/relations.js'
import { classifyTag } from '../pe-framework/dialect/anima-catalog.js'
import type { Config } from '../plugin/config.js'

type LogCtx = { logger?: { info?: (msg: string) => void } }
const logInfo = (ctx: Context | null, msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg)

interface RelationsArgs {
  action?: string
  // submit
  source_tag?: string
  target_tag?: string
  relation?: string
  confidence?: number
  rationale?: string
  evidence?: string[]
  model?: string
  // list
  status?: string
  record_id?: string
  limit?: number
  // accept / reject
  proposal_id?: string
}

/** overlay 计数（status 面）：candidate/accepted/rejected 三档计数 + 路径 */
function overlayStatusSummary(): { path: string; exists: boolean; counts: Record<'candidate' | 'accepted' | 'rejected', number> } {
  const counts = { candidate: 0, accepted: 0, rejected: 0 }
  const rows = listProposals({ status: 'all', limit: 1_000_000 })
  for (const r of rows) counts[r.status]++
  const path = overlayPath()
  let exists = false
  try {
    openOverlayDb().close()
    exists = true
  } catch {
    exists = false
  }
  return { path, exists, counts }
}

/** G1 tool wrapper：relation 提交/生命周期（Task 6 relations.ts）暴露为 catalog_relations。
 *  纯库零日志；本层只打 action 摘要。classify 接线 dialect/anima-catalog.classifyTag（T6 review carry-over）。 */
export function registerCatalogRelationsTool(ctx: Context, _config: Config) {
  return defineTool({
    name: 'catalog_relations',
    description:
      'Anima tag 关系提案生命周期：submit（校验链 + overlay 落盘）/ list / accept / reject / status。' +
      '端点存在性由 tag-catalog 判定（canonical/alias）；cooccurrence 关系拒收（需真实统计源，非 LLM）。',
    parameters: {
      action: { type: 'string', description: 'submit | list | accept | reject | status（必填）' },
      source_tag: { type: 'string', description: 'submit：关系起点 tag' },
      target_tag: { type: 'string', description: 'submit：关系终点 tag' },
      relation: { type: 'string', description: "submit：parent | child | related（cooccurrence 拒收）" },
      confidence: { type: 'number', description: 'submit：0-1，缺省 0.5' },
      rationale: { type: 'string', description: 'submit：提交理由（缺省 post-authoring relation proposal）' },
      evidence: { type: 'array', description: 'submit：证据条目（缺省 ["llm-submission"]）' },
      model: { type: 'string', description: 'submit：提案来源模型标记（缺省 current-llm）' },
      status: { type: 'string', description: 'list：candidate | accepted | rejected | all（默认 all）' },
      record_id: { type: 'string', description: 'list：按端点（from 或 to）过滤' },
      limit: { type: 'integer', description: 'list：返回条数上限（默认 100）' },
      proposal_id: { type: 'string', description: 'accept / reject：提案 id（rel:…）' },
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串（action 结果；错误以可读 message 抛出）' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: RelationsArgs) {
      const action = String(args.action ?? '').trim()
      if (!action) throw new Error('action is required: submit | list | accept | reject | status')
      switch (action) {
        case 'submit': {
          const input: ProposalInput = {
            source_tag: String(args.source_tag ?? ''),
            target_tag: String(args.target_tag ?? ''),
            relation: String(args.relation ?? ''),
            confidence: args.confidence,
            rationale: args.rationale,
            evidence: args.evidence,
          }
          const r = submitProposal(input, { classify: classifyTag, model: args.model })
          if ('issues' in r) throw new Error(`relation submission rejected: ${r.issues.join('; ')}`)
          logInfo(ctx, `[prompt-master] catalog_relations submit → ${r.proposal_id} ${input.source_tag.trim()} -${input.relation.trim()}-> ${input.target_tag.trim()}`)
          return JSON.stringify({ ok: true, proposal_id: r.proposal_id, status: r.status })
        }
        case 'list': {
          const status = (args.status ?? 'all') as 'candidate' | 'accepted' | 'rejected' | 'all'
          const proposals = listProposals({
            status,
            recordId: args.record_id === undefined ? undefined : String(args.record_id),
            limit: args.limit ?? 100,
          })
          logInfo(ctx, `[prompt-master] catalog_relations list status=${status} → ${proposals.length}`)
          return JSON.stringify({ ok: true, status, proposals })
        }
        case 'accept':
        case 'reject': {
          const proposalId = String(args.proposal_id ?? '').trim()
          if (!proposalId) throw new Error(`proposal_id is required for action=${action}`)
          const r = decideProposal(proposalId, action)
          logInfo(ctx, `[prompt-master] catalog_relations ${action} → ${r.proposal_id} status=${r.status}`)
          return JSON.stringify({ ok: true, ...r })
        }
        case 'status': {
          const s = overlayStatusSummary()
          logInfo(ctx, `[prompt-master] catalog_relations status → candidate=${s.counts.candidate} accepted=${s.counts.accepted} rejected=${s.counts.rejected}`)
          return JSON.stringify({ ok: true, ...s, overlay: s.exists ? 'available' : 'unavailable' })
        }
        default:
          throw new Error(`unknown catalog_relations action: ${action}`)
      }
    },
  })
}
