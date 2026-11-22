/**
 * R2 SubagentIntentProvider：通过 ctx.subagents.start（one-shot seam）创建创作子代理。
 *
 * 2026-11-22（direct transport 改造）：本文件瘦身为 **transport 适配层**——
 * persona/schema 解析、taskText 构造、输出解析全部搬进 intent/core.ts（与 transport 无关），
 * 这里只剩「怎么把 taskText 送出去」这一件事。这样 direct 与 subagent 两条路径共用同一份
 * core，parity 由结构保证；此前 prompt-author.ts 里另写了一份 defaultIntent（缺 compositingMode
 * 分支）导致的静默降级，正是这种「两份实现」的产物。
 *
 * 本文件继续 re-export 全部历史导出名（ANIMA_PERSONA / BLUEPRINT_SUBAGENT_SYSTEM /
 * createSubagentIntentProvider / ...），既有 import 方（dialect/anima.ts、dialect/h3.ts、tests/*）零改动。
 */
import { SubagentHostCtx } from '../llm/host-ctx.js'
import type { AuthorIntentFn, AuthorIntentRequest, AuthorDraft } from '../../tools/prompt-author.js';
import {
  applyBlueprintClarify,
  buildIntentTaskText,
  extractJsonCandidate,
  parseIntentDraft,
  resolveIntentPersonaSchema,
} from './core.js';

export {
  ANIMA_PERSONA,
  ANIMA_SCHEMA,
  ANIMA_SEMANTIC_PERSONA,
  ANIMA_SEMANTIC_RULES,
  ANIMA_SEMANTIC_SCHEMA,
  BLUEPRINT_SUBAGENT_SYSTEM,
  DEFAULT_PERSONA,
  DEFAULT_SCHEMA,
  H3_PERSONA,
  H3_SCHEMA,
} from './personas.js';

/** DSH 0.1.2 one-shot subagent run 的鸭子类型（测试 mock 与真实 seam 共用）。 */
export interface SubagentLikeRun {
  id?: string;
  localAgent?: unknown;
  result: Promise<{
    output: Array<{ type: string; text?: string }>;
    stopReason: string;
    diagnostic?: string;
  }>;
  dispose: () => Promise<unknown> | unknown;
}

/**
 * subagent 一次产出（intent/critic 共用）的默认超时。
 * 演进：60s（首版）→ 180s（R9，session-97f3819d 三连超时）→ 300s（2026-09 外部基准升级，
 * persona 3075 字符 + B7 候选块后实测 60s 不足）。
 * 覆盖顺序：显式 opts.timeoutMs > PM_SUBAGENT_TIMEOUT_MS > 本常量。
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;

export interface SubagentProviderOptions {
  persona?: string;
  schema?: string;
  timeoutMs?: number;
  /** ctx.subagents provider 名；缺省 'spawn'（dsh-base 已挂载 spawn/fork）。 */
  provider?: string;
  /** 仅测试用：把解析结果强制为指定对象（跳过 JSON 解析） */
  _testOverride?: (rawText: string, req: AuthorIntentRequest) => AuthorDraft | null;
}

/**
 * 创建子代理 Intent Provider：ownerCtx 在此一次性绑定，返回可装入 author.ts seam 的 AuthorIntentFn。
 * ownerCtx 应包含 ctx.subagents 服务（旧 seam；host 0.2.2-rc.5 已移除 → 见 transport.ts）。
 */
export function createSubagentIntentProvider(ownerCtx: SubagentHostCtx, opts: SubagentProviderOptions = {}): AuthorIntentFn {
  // 优先级：opts.timeoutMs（显式传入）> PM_SUBAGENT_TIMEOUT_MS 环境变量 > 300s 默认。
  const envTimeout = Number(process.env.PM_SUBAGENT_TIMEOUT_MS ?? '');
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_SUBAGENT_TIMEOUT_MS);
  const provider = opts.provider ?? 'spawn';

  if (!ownerCtx?.subagents?.start) {
    throw new Error(
      'SubagentIntentProvider 不可用：ctx.subagents 未注册（DSH host 未加载 subagent 服务或 plugin 未注入 "subagents"）。提示：检查 plugin inject 是否含 "subagents"，或稍后重试。',
    );
  }
  // guard 后捕获（闭包内属性窄化失效——audit F9 类型收口）
  const subagents = ownerCtx.subagents;

  return async function subagentIntent(req: AuthorIntentRequest, exec?: any): Promise<AuthorDraft> {
    // parent 必须是当前调用 Agent：工具执行上下文（exec.agent）优先，
    // 回退到 apply 绑定的 ownerCtx.agent（仅在插件确实在 agent scope 下 apply 时可用）。
    const parent = exec?.agent ?? ownerCtx?.agent;
    if (!parent) {
      throw new Error(
        'SubagentIntentProvider 需要调用 Agent 上下文（exec.agent / ownerCtx.agent 均不可用）：请从 Agent 会话内调用 prompt_author',
      );
    }
    const label = `pm-author-${req.target}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // B7（外部基准 2026-09）：catalog 候选召回注入——检索证据进生成回路
    const candidates = (Array.isArray(req.catalogCandidates) ? req.catalogCandidates : []).filter(
      (c) => typeof c === 'string' && c.trim(),
    );
    // persona/schema/taskText 全部来自 intent core（与 direct transport 同源）
    const resolved = resolveIntentPersonaSchema(req, opts);
    const taskText = buildIntentTaskText(req, resolved, candidates);

    const controller = new AbortController();
    const timeoutError = new Error(`SubagentIntentProvider 超时：未在 ${timeoutMs}ms 内收到 assistant 消息`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    let run: SubagentLikeRun;
    try {
      // host 返回形状是运行时守卫后的结构子集——此处置信断言（guard 已验 start 可调用）
      run = (await subagents.start(provider, {
        label,
        prompt: [{ type: 'text', text: taskText }],
        parent,
        // 不指定 provider/model → resolveChildAgentOptions 继承 parent 会话 route（R1）
        // one-shot 产出不需要工具——架构级禁用（host 端 childCtx.tools.restrict）
        toolFilter: { allow: [] },
        signal: exec?.signal ?? controller.signal,
      })) as unknown as SubagentLikeRun;
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError;
      throw error;
    }

    try {
      const result = await Promise.race([
        run.result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      if (result.stopReason !== 'completed') {
        const detail = result.diagnostic === undefined ? '' : `；diagnostic: ${result.diagnostic}`;
        throw new Error(`SubagentIntentProvider 子代理未完成：stopReason=${result.stopReason}${detail}`);
      }
      const text = (result.output ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (text.trim().length === 0) {
        throw new Error('SubagentIntentProvider 子代理未产出 assistant 文本');
      }

      if (opts._testOverride) {
        const o = opts._testOverride(text, req);
        if (o) return applyBlueprintClarify(o, req);
      }
      return applyBlueprintClarify(parseIntentDraft(extractJsonCandidate(text), req), req);
    } finally {
      try {
        await run.dispose();
      } catch {
        /* 吞掉 dispose 异常 */
      }
    }
  };
}
