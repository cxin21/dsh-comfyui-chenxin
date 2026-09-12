// storage-v2 — 两层 profile 存储的纯函数层 + 内置覆盖 namespace（spec §7.1）
// 内置层：只读 builtin profiles + settings 覆盖（enabled/sort）；自定义层：customProfiles（不变）。
// 纯模块：不落日志（工具层记 action 摘要）。

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'

export interface BuiltinOverride { enabled: boolean; sort?: number }
export interface OverridesSection { builtinOverrides: Record<string, BuiltinOverride> }

export interface OverridesApi {
  get(): Record<string, BuiltinOverride>
  all(): Record<string, BuiltinOverride>
  set(id: string, o: BuiltinOverride | null): Promise<void>
}

/**
 * register-or-reuse：settings namespace 在同一进程内只允许注册一次（重复 register 抛
 * "already registered"，整个 preset mount 失败）。本插件随 preset 挂载，同一进程里可能
 * 多次走到 apply（mount 失败重试、standing mount 按文件戳重建），而旧注册可能仍驻留，
 * 因此冲突时退化为 document 级 API（get/update/replace）复用既有注册，而不是让 mount 失败。
 */
export function registerOrReuseNamespace<T>(
  ctx: Context,
  ns: ReturnType<typeof settingsNamespace>,
  schema: z<T>,
): SettingsScope<T> {
  try {
    return ctx.settings.register(ns, schema)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('already registered')) throw error
    return {
      get: () => ctx.settings.get(ns) as T,
      // 复用路径拿不到原注册的 watcher 集合；本插件没有 watch 消费方，no-op 即可。
      watch: () => () => {},
      update: (patch: object) => ctx.settings.update(ns, patch),
      replace: (section: object) => ctx.settings.replace(ns, section),
    }
  }
}

/**
 * 注册内置覆盖层 namespace（spec §7.1）。
 * schemastery 纪律：无 default 字段即 optional-by-default，绝不 .optional()。
 */
export function registerOverridesNamespace(ctx: Context): OverridesApi {
  const ns = settingsNamespace('prompt-master-profile-overrides')
  const scope = registerOrReuseNamespace(ctx, ns, z.object({
    builtinOverrides: z.dict(z.object({ enabled: z.boolean(), sort: z.number() })),
  }))
  const read = (): Record<string, BuiltinOverride> =>
    (scope.get() as unknown as OverridesSection | undefined)?.builtinOverrides ?? {}
  return {
    get: read,
    all: read,
    set: async (id: string, o: BuiltinOverride | null) => {
      const next = { ...read() }
      if (o === null) delete next[id]
      else next[id] = o
      await scope.update({ builtinOverrides: next })
    },
  }
}

/** 合并读取：builtins 按 overrides 过滤/重排，custom 追加其后，整体按 sort（缺省 999）+ id 稳定排序。 */
export function listProfilesMerged<T extends { id: string; sort?: number }>(
  builtins: T[], custom: T[], overrides: Record<string, BuiltinOverride>,
): T[] {
  const out: T[] = []
  for (const b of builtins) {
    const o = overrides[b.id]
    if (o && o.enabled === false) continue
    out.push(o?.sort !== undefined ? { ...b, sort: o.sort } : b)
  }
  out.push(...custom)
  return out.sort((x, y) => (x.sort ?? 999) - (y.sort ?? 999) || String(x.id).localeCompare(String(y.id)))
}

const IMPORT_KINDS = new Set(['expand', 'reverse', 'train'])

export function validateImportPayload(payload: unknown, builtinIds: string[]): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'payload 需为对象' }
  const p = payload as Record<string, unknown>
  const builtinIdsSet = new Set(builtinIds)
  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id'])) return { ok: false, reason: `id "${p['id']}" 与内置冲突：请移除 id 字段后重试（导入时会自动重铸）` }
  if (typeof p['name'] !== 'string' || !(p['name'] as string).trim()) return { ok: false, reason: 'name 必填' }
  if (typeof p['kind'] !== 'string' || !IMPORT_KINDS.has(p['kind'])) return { ok: false, reason: `kind 需为 expand|reverse|train，得到 ${String(p['kind'])}` }
  if (typeof p['systemPrompt'] !== 'string' || !(p['systemPrompt'] as string).trim()) return { ok: false, reason: 'systemPrompt 必填' }
  return { ok: true, profile: p }
}

/** 导入重铸：id → pe_custom_+uuid，强制 builtin:false，时间戳重置（PEProfile.createdAt/updatedAt 存在，编译门通过）。 */
export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now()
  return { ...profile, id: `pe_custom_${randomUUID()}`, builtin: false, createdAt: now, updatedAt: now }
}
