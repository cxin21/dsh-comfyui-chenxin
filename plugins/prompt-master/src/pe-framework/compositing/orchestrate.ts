/**
 * compositing 编排器（spec 2026-09-17 agentic-pipeline-redesign，第三版管线）：
 * S2 扩写 → S3 成文（pm-writer，工具查字典）→ S4 双轨审核（机器门 ∥ pm-auditor 每轮必跑，A3）
 * → S5 修复（独立 pm-repairer，A4；≤2 轮，每轮修复后重跑 S4）。
 * A1：检索层（S2.5 检索包）已废除——writer 不再吃 evidence pack，tag 合法性由
 * writer 工具自证 + 机审 verifyTag 直查（A5）双保险。
 * 依赖全部注入（enrich/writer/auditor/repair runner、verifyTag、search、vectorSim）——
 * 本模块零 host 依赖、可全 mock 测试。
 * 失败语义：writer/repair 失败/耗尽 → deterministicCompose 回退（D7 fail-open，永不空手出稿）；
 * auditor 故障 → advisory 降级（机器门独立成立）。
 */
import { runSemanticEnrich } from './enrich.js';
import { buildWriterPrompt, parseWriterOutput, type WriterOutput } from './writer.js';
import { auditCompositing, type CompositingGate } from './audit.js';
import { assemblePositive, assembleNegative, deterministicCompose, type FallbackSearch } from './compose.js';
import { buildAuditorPrompt, parseAuditorVerdict, type AuditorVerdict } from './auditor.js';
import { buildRepairPrompt, parseRepairOutput } from './repair.js';
import type { SemanticBlueprint } from '../blueprint/semantic-schema.js';
import type { Rating } from '../types.js';

export interface CompositingDeps {
  /** S2 扩写 runner（pm-enrich 子代理）；缺省 → enrich_skipped 降级 */
  enrichRunner?: (taskText: string) => Promise<string>;
  /** S3 成文 runner（pm-writer 子代理，工具开放 catalog_search）；缺省 → 立即回退 deterministicCompose */
  writerRunner?: (taskText: string) => Promise<string>;
  /** S4 审计 runner（pm-auditor 子代理，工具开放 catalog_search）；缺省 → 仅机器门（judge_mode=off 语义） */
  auditorRunner?: (taskText: string) => Promise<string>;
  /** S5 修复 runner（pm-repairer 子代理，工具开放 catalog_search）；缺省 → 退化为 writer feedback 重入 */
  repairRunner?: (taskText: string) => Promise<string>;
  /** A5：tag 合法性直查（canonical/alias/artist 命中 = true）；缺省 → fabricated_tag 门跳过 */
  verifyTag?: (tag: string) => boolean;
  /** 回退直查缝（A6）：deterministicCompose 的 catalog 同步查询 */
  search: FallbackSearch;
  /** bge-base-en-v1.5 相似度注入点（NL 句 × tag）；缺省 → 审计仅词面 + overlap_vector_unavailable */
  vectorSim?: (a: string, b: string) => number | undefined;
  /** 审计前预热向量缓存（嵌入异步而审计同步，故拆两半）；缺省 → sim 对未缓存对 undefined */
  vectorPrewarm?: (nl: string, tags: string[]) => Promise<void>;
}

export interface CompositingOutcome {
  ok: boolean;
  /** audit P3：质量三态——调用方读此一键即知产品质量带，无需解析 advisories。ok 语义不变（D7） */
  quality: 'passed' | 'degraded' | 'fallback';
  positive: string;
  negative: string;
  gates: CompositingGate[];
  advisories: string[];
  corrections: number;
  fallbackUsed: boolean;
  v1: SemanticBlueprint;
  auditor?: AuditorVerdict;
  /** 审计 findings 投影（[severity] requiredFix）——修复轮输入之一 */
  auditorFeedback: string[];
  trace: Array<{ name: 'semantic_enrich' | 'writer_loop'; ms: number }>;
}

export interface CompositingOpts {
  maxCorrections?: number;
  /** 透传 auditCompositing（测试 fixture tag 数常小于预算下限；生产缺省 20） */
  minTags?: number;
}

export async function orchestrateCompositing(
  v0: SemanticBlueprint,
  rating: Rating,
  deps: CompositingDeps,
  opts: CompositingOpts = {},
): Promise<CompositingOutcome> {
  const advisories: string[] = [];
  const trace: Array<{ name: 'semantic_enrich' | 'writer_loop'; ms: number }> = [];
  const maxCorrections = opts.maxCorrections ?? 2;

  // audit P1：审计前预热 nl_tag_overlap 向量缓存（嵌入异步、审计同步，接缝拆两半）。
  // 故障静默——未缓存对 sim=undefined，audit 自然落入词面路径。
  const prewarmOverlap = async (o: WriterOutput): Promise<void> => {
    if (!deps.vectorPrewarm) return;
    try {
      await deps.vectorPrewarm(
        o.nl,
        o.tags.map((t) => t.text),
      );
    } catch {
      /* prewarm 故障不阻塞审计 */
    }
  };
  const auditOpts = () => ({
    ...(deps.verifyTag ? { verifyTag: deps.verifyTag } : {}),
    ...(deps.vectorSim ? { vectorSim: deps.vectorSim } : {}),
    rating,
    ...(opts.minTags !== undefined ? { minTags: opts.minTags } : {}),
  });

  // S2 扩写
  const tEnrich = performance.now();
  const enriched = await runSemanticEnrich(v0, { runner: deps.enrichRunner });
  advisories.push(...enriched.advisories);
  const v1 = enriched.v1;
  trace.push({ name: 'semantic_enrich', ms: performance.now() - tEnrich });

  let corrections = 0;
  let writerOut: WriterOutput | undefined;
  let gates: CompositingGate[] = [];
  let auditor: AuditorVerdict | undefined;
  let auditorFeedback: string[] = [];
  let fallbackUsed = false;
  const t0 = performance.now();

  const runAuditor = async (out: WriterOutput): Promise<void> => {
    auditor = undefined;
    auditorFeedback = [];
    if (!deps.auditorRunner) return; // judge_mode=off 语义：仅机器门
    try {
      const v = parseAuditorVerdict(await deps.auditorRunner(buildAuditorPrompt(v1, out)));
      auditor = v;
      auditorFeedback = v.findings
        .filter((f) => f.severity === 'major' || f.severity === 'blocker')
        .map((f) => `[${f.severity}] ${f.requiredFix}`);
    } catch (e) {
      advisories.push(`auditor_skipped:${(e as Error).message.slice(0, 120)}`);
    }
  };

  /** S5 修复：返回 true = 修复产物已就绪进入下一轮审核 */
  const runRepair = async (current: WriterOutput): Promise<boolean> => {
    corrections++;
    const gateViolations = gates
      .filter((g) => g.severity === 'critical' || g.severity === 'important')
      .map((g) => `${g.rule}(${g.severity}): ${g.detail}`);
    const repairRunner = deps.repairRunner;
    if (repairRunner === undefined) {
      // 无 pm-repairer（含 judge_mode=off 场景外的降级装配）：无修复通道 → 终止
      advisories.push('repair_unavailable:no_runner');
      return false;
    }
    let raw: string;
    try {
      raw = await repairRunner(
        buildRepairPrompt({ bp: v1, draft: current, gateViolations, auditorFindings: auditorFeedback }),
      );
    } catch (e) {
      advisories.push(`repair_failed:${(e as Error).message.slice(0, 120)}`);
      return false;
    }
    try {
      writerOut = parseRepairOutput(raw);
      return true;
    } catch (e) {
      advisories.push(`repair_parse_failed:${(e as Error).message.slice(0, 120)}`);
      return false;
    }
  };

  // S3 成文（writer 只跑一次；修复由独立 pm-repairer 承担，A4）
  let raw: string | undefined;
  if (deps.writerRunner) {
    try {
      raw = await deps.writerRunner(buildWriterPrompt(v1));
    } catch (e) {
      advisories.push(`writer_failed:${(e as Error).message.slice(0, 120)}`);
    }
  } else {
    advisories.push('writer_fallback_used:no_runner');
  }
  let parsedOk = false;
  if (raw !== undefined) {
    try {
      writerOut = parseWriterOutput(raw);
      parsedOk = true;
    } catch (e) {
      advisories.push(`writer_parse_failed:${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (!parsedOk) {
    // D7 fail-open：确定性回退出稿，闭环终止
    writerOut = deterministicCompose(v1, deps.search);
    fallbackUsed = true;
    advisories.push('writer_fallback_used');
    await prewarmOverlap(writerOut);
    gates = auditCompositing(writerOut, v1, auditOpts());
  } else {
    // S4 双轨审核 ∥ S5 修复循环：机器门 ∥ 审计 LLM（每轮必跑，A3——废除 critical 跳审）
    while (true) {
      await prewarmOverlap(writerOut as WriterOutput);
      gates = auditCompositing(writerOut as WriterOutput, v1, auditOpts());
      const critical = gates.filter((g) => g.severity === 'critical');
      await runAuditor(writerOut as WriterOutput);
      const auditorFailed = auditor?.verdict === 'needs_revision';

      if (critical.length === 0 && !auditorFailed) break;
      if (corrections >= maxCorrections) {
        advisories.push('loop_exhausted:true');
        break;
      }

      // S5 修复（独立 pm-repairer，A4）；修复产物回到本循环顶部重跑 S4
      const repaired = await runRepair(writerOut as WriterOutput);
      if (!repaired) {
        advisories.push('loop_exhausted:true');
        break; // repair 失败/不可用 → 保留当前产物，交由末尾 D7 判定
      }
    }
  }
  trace.push({ name: 'writer_loop', ms: performance.now() - t0 });

  // D7 fail-open（spec §7「任何情况下不空手出稿」）：耗尽/失败后仍含 critical →
  // 确定性回退出稿（真实会话 gen_1789521620450 实证：耗尽后 ok=false 且 result 被丢，违反 D7）
  const hasCritical = gates.some((g) => g.severity === 'critical');
  if (!fallbackUsed && hasCritical) {
    writerOut = deterministicCompose(v1, deps.search);
    fallbackUsed = true;
    advisories.push('writer_fallback_used');
    await prewarmOverlap(writerOut);
    gates = auditCompositing(writerOut, v1, auditOpts());
  }

  // ok 语义（legacy P3 对齐）：确定性审计全过 → ok=true（auditor needs_revision 耗尽走 loop_exhausted
  // advisory，不丢 result）；回退通道 fail-open 恒 ok=true（产品已出，故事在 advisories/gates 里）
  const finalWriterOut = writerOut as WriterOutput; // 循环不变式：break 前必已赋值（解析失败/耗尽走 fallback 分支）
  const ok = fallbackUsed ? true : gates.every((g) => g.severity !== 'critical');
  const positive = assemblePositive(finalWriterOut, rating);
  const negative = assembleNegative(finalWriterOut);

  return {
    ok,
    quality: fallbackUsed ? 'fallback' : corrections > 0 ? 'degraded' : 'passed',
    positive,
    negative,
    gates,
    advisories,
    corrections,
    fallbackUsed,
    v1,
    ...(auditor !== undefined ? { auditor } : {}),
    auditorFeedback,
    trace,
  };
}
