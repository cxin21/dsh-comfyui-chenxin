import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings';
import { registerExpandTool } from '../tools/prompt-expand.js';
import { registerReverseTool } from '../tools/prompt-reverse.js';
import { registerMinimaxTool } from '../tools/minimax-scenario.js';
import { registerProfileListTool, type ProfileScope } from '../tools/profile-list.js';
import { registerAuthorTool, setAuthorIntentProvider } from '../tools/prompt-author.js';
import { createDefaultIntentProvider } from '../pe-framework/intent/index.js';
import { registerCompileTool } from '../tools/prompt-compile.js';
import { registerCatalogSearchTool } from '../tools/catalog-search.js';
import { registerCatalogRelationsTool } from '../tools/catalog-relations.js';
import { registerCatalogBuildTool } from '../tools/catalog-build.js';
import { registerCatalogArtistAddTool } from '../tools/catalog-artist-add.js';
import { registerAuditTool } from '../tools/prompt-audit.js';
import { registerFeedbackTool } from '../tools/prompt-feedback.js';
import { registerStyleListTool } from '../tools/style-list.js';
import { registerStyleSaveTool } from '../tools/style-save.js';
import { setCustomProfileSource } from '../resolver/profiles/source.js';
import { setBuiltinFilter } from '../resolver/profiles/index.js';
import {
  migrateLegacySettingsSection,
  registerOverridesNamespace,
  registerOrReuseNamespace,
} from '../pe-framework/profiles/storage-v2.js';
import '../pe-framework/dialect/anima.js';
import '../pe-framework/dialect/h3.js';
import { setPresetRoot } from '../pe-framework/resources/resolve.js';
import { Config, type Config as ConfigShape } from './config.js';

export const name = 'prompt-forge';
// KNOWN-ISSUES #30（host dsh 0.2.2-rc.5）：subagents.start seam 已被移除，preset scope 下
// apply 期硬接线会直接拒载（14 工具全灭）。intent/扩写/评审在调用期按 subagentsReady 分流，
// 新 host 自动全走 ctx.llm 直连；'subagents' 不再进 inject（inject 只声明挂载期依赖，
// 运行期 ctx.subagents 仍可经 scope 链解析，旧 host 行为不受影响）。
export const inject = ['tools', 'llm', 'settings'];
export { Config };

export function apply(ctx: Context, config: ConfigShape) {
  const ns = settingsNamespace('prompt-forge-custom-profiles');
  // register-or-reuse：同进程重复 mount（失败重试 / standing 重建）时复用既有注册，不让 mount 失败。
  // namespace 复用语义不在 issue 17 的卸载合同里，仍在 effect 外注册。
  const scope: SettingsScope<{ customProfiles: Record<string, string> }> = registerOrReuseNamespace(
    ctx,
    ns,
    z.object({
      customProfiles: z.dict(z.string(), z.string()).default({}),
    }),
  );
  // prompt-master → prompt-forge 改名（2026-11-22）：老用户数据在旧 key 下，注册后一次性惰性迁移。
  migrateLegacySettingsSection(ctx, ns, 'prompt-master-custom-profiles', 'customProfiles');

  // Ruling #2 显式适配：真实 get() 返回 {customProfiles}，ProfileScope 期望直接表
  const profileScope: ProfileScope = {
    get: () => scope.get().customProfiles ?? {},
    update: (patch) => scope.update(patch), // 形状 {customProfiles} 与真实兼容
    replace: (section) => scope.replace(section), // 同
  };

  // 内置覆盖层 namespace（Task 7 spec §7.1）→ 注入 profile_list 工具
  const overrides = registerOverridesNamespace(ctx);

  // 模块槽与工具注册同一条 effect：cordis 同步执行，所以「先装 intent provider，再注册工具」仍成立。
  // disposer 在卸载时逆序跑，工具先注销，四条槽再回到安全缺省，避免卸载后静默沿用旧 ctx。
  ctx.effect(() => {
    // 资源路径解析：显式 presetRoot 优先（其后 env / preset 布局 fallback 在 resolve 内部处理）
    setPresetRoot(config.presetRoot);
    // 注入 resolver 自定义 profile 源（兼证 Task 9 契约）
    setCustomProfileSource(() => Object.entries(profileScope.get()).map(([id, profileJson]) => ({ id, profileJson })));
    // Intent Provider 在 apply 期装配：模块槽与工具注册同生共死（卸载即回安全缺省）。
    // 2026-11-22 关键修正（host 0.2.2-rc.5 拒载事故）：provider 的**构造**不再可能抛错。
    // 旧实现把 createSubagentIntentProvider(ctx) 硬接线在 apply 期，而它的工厂级 guard
    // （ctx.subagents.start 缺失即 throw）会让整包 14 个工具在预设里静默失能
    // （预设在、其它插件在、只有 prompt-forge 没了）。
    // 现在工厂只「绑定 ctx」，transport 在**调用期**按能力解析：
    //   direct（ctx.llm.stream 直连，默认）→ subagent（PM_TRANSPORT=subagent 或 direct 不可用时回退）。
    // 失败因此表现为单次调用的可观测错误，而不是挂载失败。
    setAuthorIntentProvider(createDefaultIntentProvider(ctx));
    // enable=false 必须同时作用于按 id 引用（resolveExpand/resolveReverse 走 findProfileById）
    setBuiltinFilter((id) => overrides.all()[id]?.enabled === false);

    const disposers: (() => void)[] = [];
    disposers.push(ctx.tools.register(registerExpandTool(ctx, config)));
    disposers.push(ctx.tools.register(registerReverseTool(ctx, config)));
    disposers.push(ctx.tools.register(registerMinimaxTool(ctx, config)));
    disposers.push(ctx.tools.register(registerProfileListTool(ctx, config, { scope: profileScope, overrides })));
    disposers.push(ctx.tools.register(registerAuthorTool(ctx, config)));
    disposers.push(ctx.tools.register(registerCompileTool(ctx)));
    disposers.push(ctx.tools.register(registerCatalogSearchTool(ctx, config)));
    disposers.push(ctx.tools.register(registerCatalogRelationsTool(ctx, config)));
    disposers.push(ctx.tools.register(registerCatalogBuildTool(ctx, config)));
    disposers.push(ctx.tools.register(registerCatalogArtistAddTool(ctx, config)));
    disposers.push(ctx.tools.register(registerAuditTool(ctx, config)));
    disposers.push(ctx.tools.register(registerFeedbackTool(ctx, config)));
    disposers.push(ctx.tools.register(registerStyleListTool(ctx, config)));
    disposers.push(ctx.tools.register(registerStyleSaveTool(ctx, config)));
    return () => {
      for (const d of disposers) d();
      setAuthorIntentProvider(null);
      setBuiltinFilter(undefined);
      setCustomProfileSource(null);
      setPresetRoot(undefined);
    };
  }, 'prompt-forge.tools');
}
