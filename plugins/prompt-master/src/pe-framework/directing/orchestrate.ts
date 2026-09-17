/**
 * directing 编排器（spec 2026-09-17-h3-agentic-directing-pipeline-design §3/§7/§8）：
 * S1 剧本分析（fail-fast）→ S2 Beat 导演（可选挂起等授权）→ S3 逐镜成文（单镜失败不阻塞）
 * → S4 双轨审核（机器门 ∥ pm-continuity-auditor 每镜必跑）→ S5 修复（受影响镜 ≤2 轮）。
 * 依赖全部注入——零 host 依赖、可全 mock 测试。
 * 降级语义（spec §8）：S1/S2 fail-fast；S3 单镜 prompt:null 不阻塞；S4 故障仅机器门；S5 耗尽保留产物。
 */
import { createHash } from 'node:crypto';
import type { ScriptIr, DirectingIr, DirectingBeat } from './ir-schema.js';
import { validateScriptIr } from './ir-schema.js';
import { checkDirectingIr } from './continuity-check.js';
import { compileH3 } from '../dialect/h3.js';
import {
  buildScriptAnalystPrompt, parseScriptIrOutput,
  buildBeatDirectorPrompt, parseBeatDirectorOutput,
  buildShotWriterPrompt, parseShotWriterOutput,
  buildContinuityAuditorPrompt, parseContinuityAuditorOutput,
  buildRepairerPrompt, parseRepairerOutput,
} from './prompts.js';
import type { EmitResult } from './engineering/emit.js';

export interface DirectingDeps {
  scriptAnalystRunner?: (taskText: string) => Promise<string>;
  beatDirectorRunner?: (taskText: string) => Promise<string>;
  shotWriterRunner?: (taskText: string) => Promise<string>;
  auditorRunner?: (taskText: string) => Promise<string>;
  repairerRunner?: (taskText: string) => Promise<string>;
  /** 工程落盘缝（缺省内存态不写文件） */
  emit?: (ir: DirectingIr) => EmitResult | undefined;
}

export interface DirectingInput {
  script: string;
  project?: string;
  awaitUserApproval?: boolean;
  rating?: string;
}

export interface DirectingOutcome {
  ok: boolean;
  status: 'completed' | 'awaiting_approval';
  quality: 'passed' | 'degraded' | 'failed';
  storyboard: DirectingIr;
  gates: Array<{ rule: string; severity: string; detail: string; source: string }>;
  advisories: string[];
  corrections: number;
  /** S5 修复轮耗尽且仍有关键门（spec §7 loop_exhausted 语义） */
  loopExhausted: boolean;
  auditor?: { verdict: string; findings: unknown[] };
  trace: Array<{ name: string; ms: number }>;
}

const SHOTS_PER_REPAIR = 2;

export async function orchestrateDirecting(
  input: DirectingInput,
  deps: DirectingDeps,
): Promise<DirectingOutcome> {
  const advisories: string[] = [];
  const trace: Array<{ name: string; ms: number }> = [];
  let corrections = 0;

  // ── S1 剧本分析（fail-fast，spec §8）──
  if (!deps.scriptAnalystRunner) throw new Error('scriptAnalystRunner 缺失——S1 不可跳过');
  const tS1 = performance.now();
  const scriptRaw = await deps.scriptAnalystRunner(buildScriptAnalystPrompt(input.script));
  const scriptIr: ScriptIr = parseScriptIrOutput(scriptRaw);
  const scriptCheck = validateScriptIr(scriptIr);
  if (!scriptCheck.ok) throw new Error(`S1 ScriptIR 校验失败: ${scriptCheck.missing.join('; ')}`);
  trace.push({ name: 'script_analyst', ms: performance.now() - tS1 });

  const sourceScriptHash = createHash('sha256').update(input.script).digest('hex');

  // ── S2 Beat 导演 ──
  if (!deps.beatDirectorRunner) throw new Error('beatDirectorRunner 缺失——S2 不可跳过');
  const tS2 = performance.now();
  const beatsRaw = await deps.beatDirectorRunner(buildBeatDirectorPrompt(scriptIr));
  const beats = parseBeatDirectorOutput(beatsRaw) as DirectingBeat[];
  trace.push({ name: 'beat_director', ms: performance.now() - tS2 });

  // 组装 DirectingIR（S3 填充 prompt，S4 填充 audit）
  const ir: DirectingIr = {
    meta: {
      title: input.project ?? 'untitled',
      source_script_hash: sourceScriptHash,
      created_at: new Date().toISOString(),
      dialect: 'h3',
      director_schema_version: 1,
      rating: input.rating,
      original_rating: input.rating,
      strict_prompt_validation: false,
    },
    characters: scriptIr.characters.map((c) => ({ ...c, appearance_lock: c.appearance_lock ?? '', wardrobe: c.wardrobe ?? '', notes: c.notes ?? '', four_view_refs: null })),
    locations: scriptIr.locations,
    props: scriptIr.props.map((p) => ({ ...p, state_by_beat: {} })),
    beats: beats as DirectingIr['beats'],
    continuity_ledger: [],
  };

  // D-U7：await_user_approval → S2 后挂起
  if (input.awaitUserApproval) {
    if (deps.emit) deps.emit(ir);
    return {
      ok: true, status: 'awaiting_approval', quality: 'degraded',
      storyboard: ir, gates: [], advisories, corrections: 0, loopExhausted: false, trace,
    };
  }

  // ── S3 逐镜成文 + S4 双轨审核 + S5 修复 ──
  const tLoop = performance.now();
  let writerFailures = 0;
  let auditorResult: { verdict: string; findings: Array<{ severity: string; dimension: string; problem: string; requiredFix: string }> } | undefined;
  let allGates: Array<{ rule: string; severity: string; detail: string; source: string }> = [];

  for (const beat of ir.beats) {
    for (const shot of beat.shots) {
      // S3 成文（单镜失败 → prompt:null 不阻塞，spec §8）
      try {
        if (!deps.shotWriterRunner) throw new Error('shotWriterRunner 缺失');
        const raw = await deps.shotWriterRunner(
          buildShotWriterPrompt(beat, ir.characters, ir.locations),
        );
        const content = parseShotWriterOutput(raw);
        // 将 S3 产出按 shot id 匹配回填
        const match = content.find((c: Record<string, unknown>) => c.who === shot.who || (beat.shots.indexOf(shot) === 0 && !c.who));
        if (match && typeof match === 'object') {
          Object.assign(shot, match);
        }
      } catch (e) {
        advisories.push(`shot_writer_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
        shot.prompt = null;
        writerFailures++;
      }

      // S4 机器门
      const gates = checkDirectingIr(ir, { strict: ir.meta.strict_prompt_validation === true });
      allGates = gates;

      // S4 审计 LLM（每镜必跑——A3 语义）
      try {
        if (!deps.auditorRunner) throw new Error('auditorRunner 缺失');
        const gateTexts = gates.filter((g) => g.severity === 'critical' || g.severity === 'important').map((g) => `${g.rule}(${g.severity}): ${g.detail}`);
        const auditRaw = await deps.auditorRunner(
          buildContinuityAuditorPrompt(ir, gateTexts),
        );
        const audit = parseContinuityAuditorOutput(auditRaw);
        auditorResult = audit;
        shot.audit = { gates, findings: audit.findings, verdict: audit.verdict };
      } catch (e) {
        advisories.push(`auditor_skipped:${shot.id}:${(e as Error).message.slice(0, 120)}`);
      }

      // S5 修复（仅受影响镜，≤SHOTS_PER_REPAIR 轮）
      const hasCritical = gates.some((g) => g.severity === 'critical');
      const needsRevision = auditorResult?.verdict === 'needs_revision';
      if ((hasCritical || needsRevision) && deps.repairerRunner && corrections < SHOTS_PER_REPAIR) {
        corrections++;
        const gateViolations = gates.filter((g) => g.severity === 'critical' || g.severity === 'important').map((g) => `${g.rule}(${g.severity}): ${g.detail}`);
        const auditorFixes = (auditorResult?.findings ?? []).map((f) => `[${f.severity}] ${f.requiredFix}`);
        try {
          const repairRaw = await deps.repairerRunner(
            buildRepairerPrompt(shot, gateViolations, auditorFixes),
          );
          const repaired = parseRepairerOutput(repairRaw);
          Object.assign(shot, repaired);
        } catch (e) {
          advisories.push(`repair_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
        }
      }
    }
  }
  trace.push({ name: 'shot_loop', ms: performance.now() - tLoop });

  // ── dialect 编译（spec §3：DirectingIR → dialect → 官方格式文本）──
  // S3 填充 H3Shot 兼容内容字段 → compileH3 逐镜编译为分 stage 官方格式
  for (const beat of ir.beats) {
    for (const shot of beat.shots) {
      try {
        const h3Input = {
          duration_seconds: shot.duration_seconds,
          shots: [{
            what: shot.what,
            who: shot.who,
            duration: shot.duration_seconds,
            camera: shot.camera,
            action: shot.action,
            micro: shot.micro,
            carry: shot.carry,
            ambient: shot.ambient,
            dialogue: shot.dialogue,
          }],
        };
        const compiled = compileH3(h3Input, { stage: shot.stage });
        shot.prompt = { text: compiled.text, token_count: 0 };
      } catch (e) {
        advisories.push(`compile_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
        shot.prompt = null;
      }
    }
  }

  // 最终机器门（全工程）
  allGates = checkDirectingIr(ir, { strict: ir.meta.strict_prompt_validation === true });
  const hasCritical = allGates.some((g) => g.severity === 'critical');
  // S5 耗尽语义（spec §7）：修复轮用尽且仍有关键门 → loop_exhausted（storyboard 仍是有效 JSON）
  const loopExhausted = corrections >= SHOTS_PER_REPAIR && hasCritical;
  if (loopExhausted) advisories.push('loop_exhausted:true');
  // ok=false 仅在修复耗尽（闭环无法收敛）；部分失败（S3 单镜/S4 降级）→ ok=true + quality=degraded
  const ok = !loopExhausted;
  const quality: DirectingOutcome['quality'] =
    hasCritical || corrections > 0 || writerFailures > 0 ? 'degraded' : 'passed';

  // 工程落盘
  if (deps.emit) deps.emit(ir);

  return {
    ok,
    status: 'completed',
    quality,
    storyboard: ir,
    gates: allGates,
    advisories,
    corrections,
    loopExhausted,
    ...(auditorResult !== undefined ? { auditor: auditorResult } : {}),
    trace,
  };
}
