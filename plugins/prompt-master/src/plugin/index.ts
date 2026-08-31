import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { registerExpandTool } from '../tools/prompt-expand.js'
import { registerReverseTool } from '../tools/prompt-reverse.js'
import { registerMinimaxTool } from '../tools/minimax-scenario.js'
import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js'
import { registerCompileTool } from '../tools/prompt-compile.js'
import { registerCatalogSearchTool } from '../tools/catalog-search.js'
import { registerAuditTool } from '../tools/prompt-audit.js'
import { setCustomProfileSource } from '../resolver/profiles/source.js'
import '../pe-framework/dialect/anima.js'
import '../pe-framework/dialect/h3.js'
import { createDefaultIntentProvider } from '../pe-framework/intent/index.js'
import { setPresetRoot } from '../pe-framework/resources/resolve.js'
import { Config, type Config as ConfigShape } from './config.js'

export const name = 'prompt-master'
export const inject = ['tools', 'llm', 'settings', 'subagents']
export { Config }

export function apply(ctx: Context, config: ConfigShape) {
  // 资源路径解析：显式 presetRoot 优先（其后 env / preset 布局 fallback 在 resolve 内部处理）
  setPresetRoot(config.presetRoot)

  const ns = settingsNamespace('prompt-master-custom-profiles')
  const scope: SettingsScope<{ customProfiles: Record<string, string> }> = ctx.settings.register(ns, z.object({
    customProfiles: z.dict(z.string(), z.string()).default({}),
  }))

  // Ruling #2 显式适配：真实 get() 返回 {customProfiles}，ProfileScope 期望直接表
  const profileScope: ProfileScope = {
    get: () => scope.get().customProfiles ?? {},
    update: (patch) => scope.update(patch),        // 形状 {customProfiles} 与真实兼容
    replace: (section) => scope.replace(section),  // 同
  }

  // 注入 resolver 自定义 profile 源（兼证 Task 9 契约）
  setCustomProfileSource(() =>
    Object.entries(profileScope.get()).map(([id, profileJson]) => ({ id, profileJson })),
  )

  // R2: 装入默认 Intent Provider（intent 走 DSH one-shot subagent；ownerCtx 一次性绑定；返回 AuthorIntentFn 单参）
  //     必须早于 author 工具注册/调用 → 在 ctx.effect 之前完成
  setAuthorIntentProvider(createDefaultIntentProvider(ctx))

  ctx.effect(() => {
    const disposers: (() => void)[] = []
    disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
    disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
    disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope })))
    disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
    disposers.push(ctx.tools.register(registerCompileTool()))
    disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
    disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
    return () => { for (const d of disposers) d() }
  }, 'prompt-master.tools')
}