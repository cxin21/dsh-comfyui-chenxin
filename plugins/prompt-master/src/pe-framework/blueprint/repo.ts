/**
 * 蓝图存储（spec §5.3 蓝图存储/版本化前提）。
 * createBlueprintRepo(ctx)：复用 settings namespace（沿用 prompt-master-custom-profiles 的 z.dict 模式，
 * blueprints 表为 Record<string, string>，JSON 序列化）。注入的 scope 形状与 profileScope 一致：
 * get() 返回 blueprints 表、update(patch) 合并补丁、replace(section) 整表替换。
 * 接线（把真实 settings namespace 解包为 blueprints 表）由消费方（Task 10 蓝图管线）完成。
 */
import type { BlueprintV1 } from './schema.js'

export interface BlueprintRepo {
  save(id: string, bp: BlueprintV1): void
  load(id: string): BlueprintV1 | undefined
  list(): string[]
}

/** 注入的 settings scope（测试 stub 与真实 scope 的公共形状） */
export interface RepoSettingsScope {
  get(): Record<string, string> | undefined
  update(patch: Record<string, string>): unknown
  replace(section: Record<string, string>): unknown
}

export function createBlueprintRepo(ctx: { settings: RepoSettingsScope }): BlueprintRepo {
  const settings = ctx.settings
  return {
    save(id, bp) {
      void settings.update({ [id]: JSON.stringify(bp) })
    },
    load(id) {
      const section = settings.get()
      const raw = section?.[id]
      if (raw == null) return undefined
      try {
        return JSON.parse(raw) as BlueprintV1
      } catch {
        return undefined // JSON 解析失败视为缺失（spec §5.3 容错）
      }
    },
    list() {
      return Object.keys(settings.get() ?? {})
    },
  }
}
