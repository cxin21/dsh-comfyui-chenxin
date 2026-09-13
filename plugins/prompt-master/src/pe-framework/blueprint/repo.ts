/**
 * 蓝图存储（spec §5.3 蓝图存储/版本化前提）。
 * createBlueprintRepo(ctx)：复用 settings namespace（沿用 prompt-master-custom-profiles 的 z.dict 模式，
 * blueprints 表为 Record<string, string>，JSON 序列化）。注入的 scope 形状与 profileScope 一致：
 * get() 返回 blueprints 表、update(patch) 合并补丁、replace(section) 整表替换。
 * 接线（把真实 settings namespace 解包为 blueprints 表）由消费方完成——M5-HOTFIX 起 prompt-author
 * 经 blueprintSettingsScope()（settings.register('prompt-master-blueprints') owner scope 惰性接线 +
 * 按服务复用）供给真实 scope，裸服务误传已在接线层杜绝（见该函数注释）。
 *
 * M5-HOTFIX（P0，DSH 进程死亡根因②）：save 返回 Promise——scope.update 的 rejection（含同步
 * throw）一律经返回的 promise 透传，绝不 void 丢弃浮空（调用方 prompt-author await 于 try/catch
 * 内 → rejection 落 advisory blueprint_save_failed，fail-open 成立；旧实现的浮空 rejection 在
 * Node 默认 unhandledRejection 语义下直接杀死 DSH 进程）。
 */
import type { BlueprintV1 } from './schema.js'

export interface BlueprintRepo {
  save(id: string, bp: BlueprintV1): Promise<unknown>
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
      try {
        return Promise.resolve(settings.update({ [id]: JSON.stringify(bp) }))
      } catch (error) {
        return Promise.reject(error) // 同步 throw 也统一到异步面（调用方单一 await 通道）
      }
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
