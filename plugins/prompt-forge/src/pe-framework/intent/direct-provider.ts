/**
 * direct Intent Provider（2026-11-22）——把 intent core 的 taskText 经 **direct transport**
 * （ctx.llm.stream 直连）送出。
 *
 * 与 createSubagentIntentProvider 的关系：**同一个 core（persona/schema/taskText/parse），
 * 两个 transport**。因此：
 *   - persona/schema 解析口径一致（semantic > blueprint > legacy）；
 *   - compositingMode 分支在两条路上都存在（此前只有 subagent 侧有 → 直连会静默降级成 legacy slots）；
 *   - 输出解析/归一化/澄清投影完全一致。
 *
 * 路由（provider/model）从调用方 exec 惰性解析——插件不内置默认模型，完全跟随会话路由。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AuthorIntentFn, AuthorIntentRequest, AuthorDraft } from '../../tools/prompt-author.js';
import { resolveRoute, type ExecLike } from '../../llm/route.js';
import { resolveTransport } from '../llm/transport.js';
import {
  applyBlueprintClarify,
  buildIntentTaskText,
  extractJsonCandidate,
  parseIntentDraft,
  resolveIntentPersonaSchema,
  type IntentPromptOptions,
} from './core.js';

export interface DirectIntentProviderOptions extends IntentPromptOptions {
  /** 仅测试用：把解析结果强制为指定对象（跳过 JSON 解析） */
  _testOverride?: (rawText: string, req: AuthorIntentRequest) => AuthorDraft | null;
}

/**
 * 创建 direct Intent Provider：ownerCtx 在此一次性绑定，返回可装入 author.ts seam 的 AuthorIntentFn。
 */
export function createDirectIntentProvider(
  ctx: Context,
  opts: DirectIntentProviderOptions = {},
): AuthorIntentFn {
  return async function directIntent(req: AuthorIntentRequest, exec?: ExecLike): Promise<AuthorDraft> {
    const live = exec as ExecLike | undefined;
    if (!live) {
      throw new Error(
        'direct Intent Provider 需要调用上下文（exec）：请从 Agent 会话内调用 prompt_author（路由完全跟随会话）。',
      );
    }
    const transport = resolveTransport(ctx, {
      resolveRoute: () => resolveRoute(live),
      parent: live.agent ?? (ctx as { agent?: unknown } | undefined)?.agent,
      labelPrefix: 'pm-author',
      signal: live.signal,
    });
    if (!transport) {
      throw new Error(
        'Intent Provider 不可用：ctx.llm.stream 与 ctx.subagents.start 均不可用（host 未加载 LLM 服务或 subagent 服务）。',
      );
    }
    // B7（外部基准 2026-09）：catalog 候选召回注入——检索证据进生成回路
    const candidates = (Array.isArray(req.catalogCandidates) ? req.catalogCandidates : []).filter(
      (c) => typeof c === 'string' && c.trim(),
    );
    const resolved = resolveIntentPersonaSchema(req, opts);
    const taskText = buildIntentTaskText(req, resolved, candidates);
    const text = await transport.run(taskText);
    if (opts._testOverride) {
      const o = opts._testOverride(text, req);
      if (o) return applyBlueprintClarify(o, req);
    }
    return applyBlueprintClarify(parseIntentDraft(extractJsonCandidate(text), req), req);
  };
}
