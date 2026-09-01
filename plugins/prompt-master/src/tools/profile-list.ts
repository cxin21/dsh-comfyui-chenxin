import { defineTool } from '@deepseek-ai/dsh-tools'
import { getDefaultBuiltinProfiles, clearProfileCache } from '../resolver/profiles/index.js'
import { getTaxonomyMeta } from '../resolver/taxonomy.js'
import { listProfilesMerged, validateImportPayload, recastImportedProfile, type OverridesApi } from '../pe-framework/profiles/storage-v2.js'
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

export function registerProfileListTool(_ctx: Context, _config: Config, deps: { scope: ProfileScope; overrides?: OverridesApi }) {
  const { scope, overrides } = deps
  return defineTool({
    name: 'profile_list',
    description: '查询/保存/删除提示词 profile（内置 + 自定义）。list/search 查询，get 单查，save/delete 管理自定义 profile，enable/sort 管理内置覆盖，export/import/validate_import 导入导出。',
    parameters: {
      action: { type: 'string', default: 'list', description: 'list|search|get|save|delete|enable|sort|export|import|validate_import' },
      kind: { type: 'string', default: '', description: 'list/search 时按 kind 过滤：expand/reverse/minimax' },
      query: { type: 'string', default: '', description: 'list/search 时按关键字搜索' },
      target: { type: 'string', default: '', description: 'list/search 时按推导 target 过滤：anima|h3|sd|danbooru|mj|generic（缺省不过滤）' },
      id: { type: 'string', default: '', description: 'get/save/delete/enable/export 的目标 profile id' },
      profile: { type: 'object', description: 'save 时要保存的 profile 对象（将强制 id 并保存为 builtin:false）；import 时为导入 payload', default: {}, additionalProperties: true },
      enabled: { type: 'boolean', default: true, description: 'enable 时目标内置 profile 的启用状态' },
      ids: { type: 'array', description: 'sort 时按顺序排列的内置 profile id 列表', default: [] },
    },
    output: {
      schema: { type: 'string', description: 'JSON 字符串' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: { action?: string; kind?: string; query?: string; target?: string; id?: string; profile?: Record<string, unknown>; enabled?: boolean; ids?: unknown[] }) {
      const action = String(args.action || 'list').trim()
      if (action === 'list' || action === 'search') {
        const kind = String(args.kind || '').trim()
        const query = String(args.query || '').trim()
        const target = args.target != null ? String(args.target).trim() : ''
        // 两层合并读取（spec §7.1）：getDefaultBuiltinProfiles 已含 custom 层，按 builtin 标记拆分后走 listProfilesMerged
        const all = getDefaultBuiltinProfiles()
        let profiles = listProfilesMerged(
          all.filter((p) => p.builtin),
          all.filter((p) => !p.builtin),
          overrides?.all() ?? {},
        )
        if (kind) {
          const k = kind
          profiles = profiles.filter((p) => {
            if (k === 'minimax') return !!p.minimaxScenarioId
            return p.kind === k
          })
        }
        if (target) profiles = profiles.filter((p) => profileTargets(p).includes(target as ProfileTarget))
        if (query) {
          const q = query.toLowerCase()
          // 注：search 语义=合并列表的小写子串过滤（原 searchProfiles 的评分排序不适用 overrides 过滤后列表）
          profiles = profiles.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)))
        }
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
      if (action === 'enable') {
        if (!overrides) throw new Error('overrides namespace 未注册，无法启用/停用内置 profile')
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for enable action')
        const enabled = args.enabled !== false
        if (!getDefaultBuiltinProfiles().some((p) => p.builtin && p.id === id)) {
          throw new Error(`内置 profile 不存在: ${id}`)
        }
        await overrides.set(id, { enabled })
        clearProfileCache()
        return JSON.stringify({ id, enabled, message: `内置 profile ${id} 已${enabled ? '启用' : '停用'}` })
      }
      if (action === 'sort') {
        if (!overrides) throw new Error('overrides namespace 未注册，无法排序内置 profile')
        const ids = Array.isArray(args.ids) ? args.ids.map((x) => String(x).trim()).filter(Boolean) : []
        if (!ids.length) throw new Error('ids is required for sort action')
        const builtinIds = new Set(getDefaultBuiltinProfiles().filter((p) => p.builtin).map((p) => p.id))
        for (const id of ids) {
          if (!builtinIds.has(id)) throw new Error(`内置 profile 不存在: ${id}`)
        }
        for (let i = 0; i < ids.length; i++) {
          await overrides.set(ids[i], { enabled: true, sort: i })
        }
        clearProfileCache()
        return JSON.stringify({ ids, message: `已按给定顺序排序 ${ids.length} 个内置 profile` })
      }
      if (action === 'export') {
        const id = String(args.id || '').trim()
        if (!id) throw new Error('id is required for export action')
        const all = getDefaultBuiltinProfiles()
        const merged = listProfilesMerged(all.filter((p) => p.builtin), all.filter((p) => !p.builtin), overrides?.all() ?? {})
        const p = merged.find((x) => x.id === id)
        if (!p) throw new Error(`Profile not found: ${id}`)
        return JSON.stringify({ format: 'prompt-master-prompt-engineering', profile: p })
      }
      if (action === 'import' || action === 'validate_import') {
        const builtinIds = getDefaultBuiltinProfiles().filter((p) => p.builtin).map((p) => p.id)
        const r = validateImportPayload(args.profile, builtinIds)
        if (!r.ok) return JSON.stringify({ ok: false, action, reason: r.reason })
        if (action === 'validate_import') return JSON.stringify({ ok: true, action, message: '导入 payload 校验通过（未落盘）' })
        const recast = recastImportedProfile(r.profile)
        const newId = String(recast['id'])
        const current = scope.get()
        await scope.update({ customProfiles: { ...current, [newId]: JSON.stringify(recast) } })
        clearProfileCache()
        return JSON.stringify({ ok: true, action: 'import', id: newId, message: `已导入为自定义 profile ${newId}` })
      }
      throw new Error(`Unknown action: ${action}`)
    },
  })
}