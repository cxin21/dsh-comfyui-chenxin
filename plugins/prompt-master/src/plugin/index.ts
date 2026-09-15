import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { registerExpandTool } from '../tools/prompt-expand.js'
import { registerReverseTool } from '../tools/prompt-reverse.js'
import { registerMinimaxTool } from '../tools/minimax-scenario.js'
import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js'
import { registerAuthorTool } from '../tools/prompt-author.js'
import { registerCompileTool } from '../tools/prompt-compile.js'
import { registerCatalogSearchTool } from '../tools/catalog-search.js'
import { registerCatalogRelationsTool } from '../tools/catalog-relations.js'
import { registerCatalogBuildTool } from '../tools/catalog-build.js'
import { registerCatalogArtistAddTool } from '../tools/catalog-artist-add.js'
import { registerAuditTool } from '../tools/prompt-audit.js'
import { registerFeedbackTool } from '../tools/prompt-feedback.js'
import { registerStyleListTool } from '../tools/style-list.js'
import { registerStyleSaveTool } from '../tools/style-save.js'
import { setCustomProfileSource } from '../resolver/profiles/source.js'
import { setBuiltinFilter } from '../resolver/profiles/index.js'
import { registerOverridesNamespace, registerOrReuseNamespace } from '../pe-framework/profiles/storage-v2.js'
import '../pe-framework/dialect/anima.js'
import '../pe-framework/dialect/h3.js'
// 2026-09-15 终态：intent 子代理 provider 不再生产注入（见下方注释）；工厂保留可切回。
import { setPresetRoot } from '../pe-framework/resources/resolve.js'
import { Config, type Config as ConfigShape } from './config.js'

export const name = 'prompt-master'
export const inject = ['tools', 'llm', 'settings', 'subagents']
export { Config }

export function apply(ctx: Context, config: ConfigShape) {
  // 资源路径解析：显式 presetRoot 优先（其后 env / preset 布局 fallback 在 resolve 内部处理）
  setPresetRoot(config.presetRoot)

  const ns = settingsNamespace('prompt-master-custom-profiles')
  // register-or-reuse：同进程重复 mount（失败重试 / standing 重建）时复用既有注册，不让 mount 失败
  const scope: SettingsScope<{ customProfiles: Record<string, string> }> = registerOrReuseNamespace(ctx, ns, z.object({
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

  // 2026-09-15 终态（用户定案「全部 LLM 调用改 direct」）：intent 不再注入子代理 provider——
  // 生产走 prompt-author 的 defaultIntent（ctx.llm.stream 直连，零会话生命周期）。
  // spawn 子会话形态会触发 session-init 表单（团队资产注入/Agent 绑定选择），而 delegated
  // 子代理不可交互（DELEGATED_CALLER），未决问题进 final result 污染蓝图 JSON 解析（实证）。
  // createSubagentIntentProvider 保留（未来 DSH 提供无会话 one-shot 原语时可切回）。

  // 内置覆盖层 namespace（Task 7 spec §7.1）→ 注入 profile_list 工具
  const overrides = registerOverridesNamespace(ctx)

  // enable=false 必须同时作用于按 id 引用（resolveExpand/resolveReverse 走 findProfileById）
  setBuiltinFilter((id) => overrides.all()[id]?.enabled === false)

  ctx.effect(() => {
    const disposers: (() => void)[] = []
    disposers.push(ctx.tools.register(registerExpandTool(ctx, config)))
    disposers.push(ctx.tools.register(registerReverseTool(ctx, config)))
    disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)))
    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope, overrides })))
    disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)))
    disposers.push(ctx.tools.register(registerCompileTool(ctx)))
    disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)))
    disposers.push(ctx.tools.register(registerCatalogRelationsTool(ctx, config)))
    disposers.push(ctx.tools.register(registerCatalogBuildTool(ctx, config)))
    disposers.push(ctx.tools.register(registerCatalogArtistAddTool(ctx, config)))
    disposers.push(ctx.tools.register(registerAuditTool(ctx, config)))
    disposers.push(ctx.tools.register(registerFeedbackTool(ctx, config)))
    disposers.push(ctx.tools.register(registerStyleListTool(ctx, config)))
    disposers.push(ctx.tools.register(registerStyleSaveTool(ctx, config)))
    return () => { for (const d of disposers) d() }
  }, 'prompt-master.tools')
}