import { defineTool } from '@deepseek-ai/dsh-tools'
import { getDefaultBuiltinProfiles, filterProfilesByKind, searchProfiles, clearProfileCache } from '../resolver/profiles/index.js'
import { getTaxonomyMeta } from '../resolver/taxonomy.js'
import type { Config } from '../plugin/config.js'
import type { Context } from '@deepseek-ai/cordis'

export interface ProfileScope {
  get(): Record<string, string>
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

export type ProfileTarget = 'anima' | 'h3' | 'sd' | 'danbooru' | 'mj' | 'generic'

/**
 * A18 处置：PEProfile 无 target 字段 → 查询层推导映射（spec §5 配方×方言解耦；写入手册）。
 * 推导：outputFormat='minimax' → h3；tags 含 'Anima'/'anima3' → anima；
 * outputFormat∈{sd_tags,danbooru_tags} → sd|danbooru；kind='train' 的训练配方按 outputFormat 归入对应变体；其余 → generic。
 */
export function profileTargets(p: { kind: string; outputFormat: string; tags: string[] }): ProfileTarget[] {
  if (p.outputFormat === 'minimax') return ['h3']
  if ((p.tags ?? []).some((t) => /anima/i.test(t))) return ['anima']
  if (p.outputFormat === 'sd_tags' || p.outputFormat === 'danbooru_tags') return ['sd', 'danbooru']
  return ['generic']
}

export function registerProfileListTool(_ctx: Context, _config: Config, deps: { scope: ProfileScope }) {
  const { scope } = deps
  return defineTool({
    name: 'profile_list',
    description: '查询/保存/删除提示词 profile（内置 + 自定义）。list/search 查询，get 单查，save/delete 管理自定义 profile。',
    parameters: {
      action: { type: 'string', default: 'list', description: 'list|search|get|save|delete' },
      kind: { type: 'string', default: '', description: 'list/search 时按 kind 过滤：expand/reverse/minimax' },
      query: { type: 'string', default: '', description: 'list/search 时按关键字搜索' },
      target: { type: 'string', default: '', description: 'list/search 时按推导 target 过滤：anima|h3|sd|danbooru|mj|generic（缺省不过滤）' },
      id: { type: 'string', default: '', description: 'get/save/delete 的目标 profile id' },
      profile: { type: 'object', description: 'save 时要保存的 profile 对象（将强制 id 并保存为 builtin:false）', default: {}, additionalProperties: true },
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { action?: string; kind?: string; query?: string; target?: string; id?: string; profile?: Record<string, unknown> }) {
      const action = String(args.action || 'list').trim()
      if (action === 'list' || action === 'search') {
        const kind = String(args.kind || '').trim()
        const query = String(args.query || '').trim()
        const target = args.target != null ? String(args.target).trim() : ''
        let profiles = getDefaultBuiltinProfiles()
        if (kind) profiles = filterProfilesByKind(kind)
        if (target) profiles = profiles.filter((p) => profileTargets(p).includes(target as ProfileTarget))
        if (query) profiles = searchProfiles(query)
        return JSON.stringify({
          profiles: profiles.map((p) => ({ id: p.id, name: p.name, category: p.category, description: p.description, kind: p.kind, outputFormat: p.outputFormat, tags: p.tags, target: profileTargets(p)[0] ?? undefined })),
          taxonomy: getTaxonomyMeta(),
        })
      }
      if (action === 'get') {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for get action')
        const current = scope.get()
        if (current[id]) return JSON.stringify({ profile: JSON.parse(current[id]), custom: true })
        const p = getDefaultBuiltinProfiles().find((x) => x.id === id)
        if (!p) throw new Error(`Profile not found: ${id}`)
        return JSON.stringify({ profile: p, custom: false })
      }
      if (action === 'save') {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for save action')
        if (!args.profile || typeof args.profile !== 'object') throw new Error('profile object is required')
        const profileWithId = { ...args.profile, id, builtin: false }
        const current = scope.get()
        await scope.update({ customProfiles: { ...current, [id]: JSON.stringify(profileWithId) } })
        clearProfileCache()
        return JSON.stringify({ id, message: `Profile ${id} 已保存` })
      }
      if (action === 'delete') {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for delete action')
        if (getDefaultBuiltinProfiles().find((p) => p.id === id && p.builtin)) {
          throw new Error(`${id} 是内置 profile，不能删除`)
        }
        const current = scope.get()
        const next = { ...current }
        delete next[id]
        await scope.replace({ customProfiles: next })
        clearProfileCache()
        return JSON.stringify({ id, message: `Profile ${id} 已删除` })
      }
      throw new Error(`Unknown action: ${action}`)
    },
  })
}