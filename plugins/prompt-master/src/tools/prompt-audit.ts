import { defineTool } from '@deepseek-ai/dsh-tools';
import { auditAnima, type AnimaSlots } from '../pe-framework/dialect/anima.js';
import { normalizeRefs } from '../pe-framework/dialect/h3.js';
import { auditH3Full, contractGatesH3 } from '../pe-framework/audit/rules-h3.js';
import { buildH3Budget, h3BudgetToReport } from '../pe-framework/audit/budget.js';
import { serializeReport } from '../pe-framework/audit/report.js';
import { searchCatalog } from '../pe-framework/dialect/anima-catalog.js';
import type { AuditGate } from '../pe-framework/types.js';
import type { H3ShotsInput } from '../pe-framework/schema/h3-shots.js';
import type { Config } from '../plugin/config.js';
import type { Context } from '@deepseek-ai/cordis';

export interface AuditContent {
  target: 'anima' | 'h3';
  // anima: positive/negative + variant + slots（catalog_miss 等需 slots）
  positive?: string;
  negative?: string;
  variant?: string;
  slots?: AnimaSlots;
  // h3: text + 元信息 + references
  text?: string;
  stage?: string;
  duration?: number;
  shotCount?: number;
  references?: unknown[];
}

/** T11-001（spec 附录 A1 遗留处置，合并后 dispatch）：D1 残余面收敛——audit 链路为同步契约
 *  （DialectContract.audit），auditAnima 的 miss 闸门走 searchCatalogSync，永远看不到 semantic
 *  层（级联 semantic + 子串召回 + tie-breaker）。本助手在异步工具边界做 post-hoc 转换：
 *  对 rule='catalog_miss' 的 gate 提取原文（detail 'catalog_miss:<text>（…）'），用 async
 *  searchCatalog 重查——级联增强层（semantic/子串召回/tie-breaker）可解时，gate 原位替换为
 *  semantic_fallback（与 auditAnima in-band 同格式）；不可解或故障保持原 gate（spec §5 降级纪律）。
 *  注意：能走到这里的查询，同步级联必已全 miss，async 级联的 top hit 只可能来自增强层。 */
export async function reconcileSemanticFallback(gates: AuditGate[]): Promise<AuditGate[]> {
  const out: AuditGate[] = [];
  for (const g of gates) {
    if (g.rule !== 'catalog_miss') {
      out.push(g);
      continue;
    }
    const m = /^catalog_miss:(.+?)（/.exec(g.detail);
    const text = m?.[1]?.trim();
    if (!text) {
      out.push(g);
      continue;
    }
    try {
      const hits = await searchCatalog(text, { mode: 'auto', limit: 5 });
      const top = hits[0];
      if (!top?.prompt_form) {
        out.push(g);
        continue;
      }
      out.push({
        rule: 'semantic_fallback',
        target: 'anima',
        severity: 'minor',
        detail: `semantic_fallback:${text}→${top.prompt_form}（保留原文未替换）`,
        source: 'tools/prompt-audit',
      });
    } catch {
      out.push(g); // 增强层纪律：转换失败保持原 gate（spec §5）
    }
  }
  return out;
}

/** 纯审计闸门（无 LLM）：按 target 直接 audit + budget → Envelope */
export function auditContentEnvelope(content: AuditContent): string {
  const target = content.target;
  let gates: AuditGate[] = [];
  let budget: unknown;
  let ok: boolean;
  if (target === 'anima') {
    if (typeof content.positive !== 'string' || typeof content.negative !== 'string') {
      throw new Error('anima 审计需要 positive + negative 文本');
    }
    const variant = (content.variant ?? 'base') as 'base' | 'aesthetic' | 'turbo';
    gates = auditAnima(content.positive, content.negative, { variant, slots: content.slots });
    budget = undefined;
    ok = gates.every((g) => g.severity !== 'critical');
  } else {
    if (typeof content.text !== 'string') throw new Error('h3 审计需要 text 文本');
    const stage = content.stage ?? 't2va';
    const duration = content.duration ?? 10;
    const shotCount = content.shotCount ?? ((content.text.match(/\[Shot \d+\]/g) ?? []).length || 1);
    const references = content.references ?? [];
    const shots: H3ShotsInput = { duration_seconds: duration, shots: [{ what: content.text.slice(0, 200) }] };
    try {
      gates = [
        ...contractGatesH3(stage, { duration_seconds: duration, shots: [{ what: 'x' }] }, references),
        ...auditH3Full(content.text, { stage, duration, shotCount }, references),
      ];
    } catch (error) {
      // field_order 类结构错误（极端路径，正常时已被 auditH3 内部 gate 化）：不 throw 裸错误，返回引导 gate
      const message = error instanceof Error ? error.message : String(error);
      gates = [
        {
          rule: 'field_order',
          target: 'h3',
          severity: 'critical',
          detail: `${message}；提示：prompt_audit 接受已成型的六段式 H3 文本（subject_definitions/summary/retention_analysis/detailed_description/overall_soundscape/non_diegetic_music 固定顺序）；裸文本或非六段内容请改用 prompt_author（一句话→完整六段）或 prompt_compile（shots→六段）`,
          source: 'tools/prompt-audit',
        },
      ];
    }
    // P5：field_order gate 的 detail 统一补引导语（auditH3 内部 gate 化的路径在此兜底）
    gates = gates.map((g) =>
      g.rule === 'field_order' && !g.detail.includes('prompt_author')
        ? {
            ...g,
            detail: `${g.detail}；提示：裸文本或非六段式内容请改用 prompt_author（一句话→完整六段）或 prompt_compile（shots→六段）`,
          }
        : g,
    );
    budget = h3BudgetToReport(buildH3Budget(stage, content.text, normalizeRefs(references)));
    ok = gates.every((g) => g.severity !== 'critical');
    void shots;
  }
  return serializeReport({
    ok,
    audit: { passed: ok, gates, ...(budget ? { budget } : {}) },
    advisories: [],
  } as never);
}

export function registerAuditTool(ctx: Context, _config: Config) {
  type LogCtx = { logger?: { info?: (msg: string) => void } };
  const logInfo = (msg: string) => (ctx as unknown as LogCtx | undefined)?.logger?.info?.(msg);
  return defineTool({
    name: 'prompt_audit',
    description:
      '纯审计闸门（无 LLM）：按 target 对已有内容直接跑审计 + budget（anima: positive/negative（可附 slots）；h3: text + stage/duration/shotCount/references）。',
    parameters: {
      target: { type: 'string', default: 'h3', description: 'anima | h3' },
      positive: { type: 'string', default: '', description: 'anima positive' },
      negative: { type: 'string', default: '', description: 'anima negative' },
      variant: { type: 'string', default: 'base', description: 'anima variant' },
      slots: {
        type: 'object',
        description: 'anima 槽位（catalog_miss/段数审计）',
        default: {},
        additionalProperties: true,
      },
      text: { type: 'string', default: '', description: 'h3 提示词文本' },
      stage: { type: 'string', default: 't2va', description: 'h3 stage' },
      duration: { type: 'number', default: 10, description: 'h3 duration_seconds' },
      shotCount: { type: 'number', default: 1, description: 'h3 镜头数' },
      references: { type: 'array', description: 'h3 图片引用', default: [] },
    },
    output: {
      schema: { type: 'string', description: 'Envelope JSON 字符串 {ok, audit, advisories}' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    async execute(args: Record<string, unknown>) {
      const target = String(args.target ?? 'h3') as 'anima' | 'h3';
      if (target !== 'anima' && target !== 'h3') throw new Error(`未知 target: ${target}`);
      logInfo(
        `[prompt-master] prompt_audit target=${target}${typeof args.stage === 'string' && target === 'h3' ? ` stage=${args.stage}` : ''}`,
      );
      let out = auditContentEnvelope({
        target,
        positive: typeof args.positive === 'string' ? args.positive : undefined,
        negative: typeof args.negative === 'string' ? args.negative : undefined,
        variant: typeof args.variant === 'string' ? args.variant : undefined,
        slots: args.slots as AnimaSlots | undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
        stage: typeof args.stage === 'string' ? args.stage : undefined,
        duration: typeof args.duration === 'number' ? args.duration : undefined,
        shotCount: typeof args.shotCount === 'number' ? args.shotCount : undefined,
        references: Array.isArray(args.references) ? args.references : undefined,
      });
      // T11-001（spec 附录 A1）：anima 审计的 catalog_miss gate 在异步边界做
      // catalog_miss → semantic_fallback post-hoc 转换（同步审计链路看不到 semantic 层）。
      if (target === 'anima') {
        try {
          const env = JSON.parse(out) as {
            ok?: boolean;
            audit?: { passed?: boolean; gates?: AuditGate[] };
            advisories?: string[];
          };
          const gates = env.audit?.gates ?? [];
          if (gates.some((g) => g.rule === 'catalog_miss')) {
            const reconciled = await reconcileSemanticFallback(gates);
            const ok2 = reconciled.every((g) => g.severity !== 'critical');
            out = serializeReport({
              ok: ok2,
              audit: { passed: ok2, gates: reconciled },
              advisories: [],
            } as never);
          }
        } catch {
          /* 转换失败保持原结果（spec §5 降级纪律） */
        }
      }
      try {
        const env = JSON.parse(out) as { ok?: boolean; audit?: { gates?: Array<{ severity: string }> } };
        const gates = env.audit?.gates ?? [];
        logInfo(
          `[prompt-master] prompt_audit → ok=${env.ok === true} gates=${gates.length} critical=${gates.filter((g) => g.severity === 'critical').length}`,
        );
      } catch {
        /* 日志失败不影响工具结果 */
      }
      return out;
    },
  });
}
