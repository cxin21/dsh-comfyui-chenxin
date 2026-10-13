/**
 * directing 编排器（spec 2026-09-17-h3-agentic-directing-pipeline-design §3/§7/§8）：
 * S1 剧本分析（fail-fast）→ S2 Beat 导演（可选挂起等授权）→ S3 逐镜成文（单镜失败不阻塞）
 * → S4 双轨审核（机器门 ∥ pm-continuity-auditor 每镜必跑）→ S5 修复（受影响镜 ≤2 轮）。
 * 依赖全部注入——零 host 依赖、可全 mock 测试。
 * 降级语义（spec §8）：S1/S2 fail-fast；S3 单镜 prompt:null 不阻塞；S4 故障仅机器门；S5 耗尽保留产物。
 */
import { createHash } from 'node:crypto';
import type { ScriptIr, DirectingIr, DirectingBeat } from './ir-schema.js';
import { validateScriptIr, validateDirectingIr } from './ir-schema.js';
import { checkDirectingIr } from './continuity-check.js';
import { CallerCancelledError } from '../llm/cancel.js';
import { compileDirectingShot } from './compile.js';
import { auditH3Full } from '../audit/rules-h3.js';
import { buildH3Budget } from '../audit/budget.js';
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
  /** 剧本文本（spec §3「剧本文本|文件路径」，文件形态由工具层读取后传入）；
   * resume（resumeStoryboard 在场）可省——省略时逐字对账与 hash 对账自然跳过 */
  script?: string;
  project?: string;
  awaitUserApproval?: boolean;
  rating?: string;
  /** R12（spec §5/§7 两段式确认续跑）：已批准方案（挂起态 storyboard 原样回传）——
   *  跳过 S1/S2，直接续跑 S3-S5；增量语义 R13 = 只重跑 null/违规镜 */
  resumeStoryboard?: DirectingIr;
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

/** P2-4c（对抗审查）：门 detail 点名镜/Beat 用词边界匹配——B01-S1 不得误伤 B01-S10（includes 子串陷阱） */
function mentionsId(detail: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_-])`).test(detail);
}

export async function orchestrateDirecting(
  input: DirectingInput,
  deps: DirectingDeps,
): Promise<DirectingOutcome> {
  const advisories: string[] = [];
  const trace: Array<{ name: string; ms: number }> = [];
  let corrections = 0;

  // R12（spec §5/§7）：已批准方案续跑入口——validateDirectingIr fail-fast（上游是根，不空手编故事）
  const resume = input.resumeStoryboard;
  // script 可选化（resume 可省）后，新鲜路径显式 fail-fast——S1 无剧本文本只会产出垃圾蓝图。
  // 局部变量固定窄化（input.script 的 property 窄化会被中间 await 调用打断）。
  let scriptText: string;
  if (!resume) {
    if (typeof input.script !== 'string') {
      throw new Error('directing 缺 script 文本：新鲜请求必填，续跑可省（resumeStoryboard）');
    }
    scriptText = input.script;
  } else {
    scriptText = '';
  }
  if (resume) {
    const resumeCheck = validateDirectingIr(resume);
    if (!resumeCheck.ok) throw new Error(`resumeStoryboard 校验失败: ${resumeCheck.missing.join('; ')}`);
    advisories.push('resume_approved_plan');
  }

  // S1/S2 产物提升到函数作用域：fresh 路径填充；resume 路径由 resumeStoryboard 承载（下方 ir 二选一装配）
  let scriptIr: ScriptIr | undefined;
  let bdOut: ReturnType<typeof parseBeatDirectorOutput> | undefined;
  let beats: DirectingBeat[] | undefined;

  if (!resume) {
    // ── S1 剧本分析（fail-fast，spec §8）──
    if (!deps.scriptAnalystRunner) throw new Error('scriptAnalystRunner 缺失——S1 不可跳过');
    const tS1 = performance.now();
    const scriptRaw = await deps.scriptAnalystRunner(buildScriptAnalystPrompt(scriptText));
    scriptIr = parseScriptIrOutput(scriptRaw);
    const scriptCheck = validateScriptIr(scriptIr);
    if (!scriptCheck.ok) throw new Error(`S1 ScriptIR 校验失败: ${scriptCheck.missing.join('; ')}`);
    trace.push({ name: 'script_analyst', ms: performance.now() - tS1 });

    // ── S2 Beat 导演 ──
    if (!deps.beatDirectorRunner) throw new Error('beatDirectorRunner 缺失——S2 不可跳过');
    const tS2 = performance.now();
    const beatsRaw = await deps.beatDirectorRunner(buildBeatDirectorPrompt(scriptIr));
    bdOut = parseBeatDirectorOutput(beatsRaw);
    beats = bdOut.beats as DirectingBeat[];
    trace.push({ name: 'beat_director', ms: performance.now() - tS2 });
  }

  const sourceScriptHash = resume
    ? resume.meta.source_script_hash
    : createHash('sha256').update(scriptText).digest('hex');

  // 组装 DirectingIR（S3 填充 prompt，S4 填充 audit）；resume 原样承载（ledger 拷贝防外部突变）
  let ir: DirectingIr;
  if (resume) {
    ir = { ...resume, continuity_ledger: [...resume.continuity_ledger] };
  } else {
    ir = {
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
      characters: scriptIr!.characters.map((c) => ({ ...c, appearance_lock: c.appearance_lock ?? '', wardrobe: c.wardrobe ?? '', notes: c.notes ?? '', four_view_refs: null })),
      locations: scriptIr!.locations,
      // R9（spec §5 S2 道具三态登记）：S2 台账按 id/name 合并覆盖；未登记道具保持空台账
      props: (() => {
        const merged: Array<{ id: string; name: string; state_by_beat: Record<string, string> }> = scriptIr!.props.map((p) => ({ ...p, state_by_beat: {} }));
        for (const sp of bdOut!.props ?? []) {
          const t = merged.find((m) => (sp.id != null && m.id === sp.id) || (sp.name != null && m.name === sp.name));
          if (t && typeof sp.state_by_beat === 'object' && sp.state_by_beat !== null) t.state_by_beat = { ...sp.state_by_beat };
          else if (!t) merged.push({ id: String(sp.id ?? sp.name ?? ''), name: String(sp.name ?? sp.id ?? ''), state_by_beat: typeof sp.state_by_beat === 'object' && sp.state_by_beat !== null ? { ...sp.state_by_beat } : {} });
        }
        return merged;
      })(),
      beats: beats as DirectingIr['beats'],
      continuity_ledger: [],
    };

    // R8（spec §4 meta：N4/N5/N6「S1/S2 产出」）：S2 meta 合并进 DirectingIR.meta（resume 的 meta 已含 S2 产出）
    if (bdOut?.meta) {
      if (typeof bdOut.meta.climax_segment === 'string' && bdOut.meta.climax_segment.trim() !== '') {
        ir.meta.climax_segment = bdOut.meta.climax_segment;
      }
      if (Array.isArray(bdOut.meta.sound_events)) {
        ir.meta.sound_events = bdOut.meta.sound_events.filter((s): s is string => typeof s === 'string');
      }
      if (typeof bdOut.meta.audiovisual_signature === 'object' && bdOut.meta.audiovisual_signature !== null && !Array.isArray(bdOut.meta.audiovisual_signature)) {
        ir.meta.audiovisual_signature = bdOut.meta.audiovisual_signature;
      }
      if (bdOut.meta.world_anchors === null || (typeof bdOut.meta.world_anchors === 'object' && !Array.isArray(bdOut.meta.world_anchors))) {
        ir.meta.world_anchors = (bdOut.meta.world_anchors as Record<string, string> | null) ?? null;
      }
    }
  }

  // D-U7：await_user_approval → S2 后挂起
  // P2-4b（对抗审查）：resume 时对账 source_script_hash——调用方换了剧本仍沿用已批准方案
  // （S1/S2 已跳过，IR 反映的是旧剧本），scriptText 逐字对账不得拿新剧本对旧稿
  // （会误触发 G-dialogue 修复链白烧 LLM）；advisory 可观测，不阻塞续跑。
  let scriptTextForGates: string | undefined = input.script;
  if (resume && typeof input.script === 'string' && input.script.trim() !== '') {
    const suppliedHash = createHash('sha256').update(input.script).digest('hex');
    if (suppliedHash !== resume.meta.source_script_hash) {
      advisories.push(
        `resume_script_mismatch:input 剧本与已批准方案 source_script_hash 不一致（${suppliedHash.slice(0, 8)} ≠ ${String(resume.meta.source_script_hash).slice(0, 8)}），S1/S2 沿用已批准方案，逐字对账跳过`,
      );
      scriptTextForGates = undefined;
    }
  }
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
  let allGates: Array<{ rule: string; severity: string; detail: string; source: string }> = [];
  const compiledGates: Array<{ rule: string; severity: string; detail: string; source: string }> = [];
  // envelope 投影用最近一次审计裁决（R10：修复触发改用镜内局部变量，杜绝跨镜泄漏）
  let lastAuditorResult: { verdict: string; findings: Array<{ severity: string; dimension: string; problem: string; requiredFix: string }> } | undefined;

  for (const beat of ir.beats) {
    for (const shot of beat.shots) {
      // R13（增量语义）：续跑只重写空 prompt 镜或违规镜——已批准稿保留（S4/S5 一并跳过）
      if (shot.prompt != null) {
        const preGates = checkDirectingIr(ir, { strict: ir.meta.strict_prompt_validation === true, scriptText: scriptTextForGates });
        const violated = preGates.some(
          (g) => (g.severity === 'critical' || g.severity === 'important') && (mentionsId(g.detail, shot.id) || mentionsId(g.detail, beat.id)),
        );
        if (!violated) continue;
      }

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
        // R11（spec §5/§7 版本登记）：S3 产出登记进 continuity_ledger（版本/上游设计 hash）
        ir.continuity_ledger.push({
          check: 'shot_prompt_version',
          beat_span: shot.id,
          status: 'ok',
          note: `prompt_v1 @ ${sourceScriptHash.slice(0, 8)}`,
        });
      } catch (e) {
        if (e instanceof CallerCancelledError) throw e; // P2-5：取消不得被吞成 advisory（zombie 防线）
        advisories.push(`shot_writer_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
        shot.prompt = null;
        writerFailures++;
      }

      // S4 机器门（R4：scriptText 逐字对账面接线）
      const gates = checkDirectingIr(ir, { strict: ir.meta.strict_prompt_validation === true, scriptText: scriptTextForGates });
      allGates = gates;

      // S4 审计 LLM（每镜必跑——A3 语义；R10：结果镜内作用域）
      let shotAuditor: { verdict: string; findings: Array<{ severity: string; dimension: string; problem: string; requiredFix: string }> } | undefined;
      try {
        if (!deps.auditorRunner) throw new Error('auditorRunner 缺失');
        const gateTexts = gates.filter((g) => g.severity === 'critical' || g.severity === 'important').map((g) => `${g.rule}(${g.severity}): ${g.detail}`);
        const auditRaw = await deps.auditorRunner(
          buildContinuityAuditorPrompt(ir, gateTexts),
        );
        const audit = parseContinuityAuditorOutput(auditRaw);
        shotAuditor = audit;
        lastAuditorResult = audit;
        shot.audit = { gates, findings: audit.findings, verdict: audit.verdict };
      } catch (e) {
        if (e instanceof CallerCancelledError) throw e; // P2-5：取消不得被吞成 advisory（zombie 防线）
        advisories.push(`auditor_skipped:${shot.id}:${(e as Error).message.slice(0, 120)}`);
      }

      // S5 修复（R10，spec §5「仅受影响镜头」/§7 修订记录：每镜 1 次机会 + 全局 SHOTS_PER_REPAIR=2）：
      // 触发 = critical/important gate 明细点名本 shot 或本 beat（镜面违规），
      // 或本镜审计 needs_revision；meta 级 gate（sound/signature/unit 等）不在镜修复射程
      // （蓝图冻结——S5 只修 prompt 层），不得触发。
      const affectedByGates = gates.some(
        (g) =>
          (g.severity === 'critical' || g.severity === 'important') &&
          (mentionsId(g.detail, shot.id) || mentionsId(g.detail, beat.id)),
      );
      const needsRevision = shotAuditor?.verdict === 'needs_revision';
      if ((affectedByGates || needsRevision) && deps.repairerRunner && corrections < SHOTS_PER_REPAIR) {
        corrections++;
        const gateViolations = gates
          .filter((g) => (g.severity === 'critical' || g.severity === 'important') && (mentionsId(g.detail, shot.id) || mentionsId(g.detail, beat.id)))
          .map((g) => `${g.rule}(${g.severity}): ${g.detail}`);
        const auditorFixes = (shotAuditor?.findings ?? []).map((f) => `[${f.severity}] ${f.requiredFix}`);
        try {
          const repairRaw = await deps.repairerRunner(
            buildRepairerPrompt(shot, gateViolations, auditorFixes),
          );
          const repaired = parseRepairerOutput(repairRaw);
          Object.assign(shot, repaired);
          // R11（spec §5/§7 版本登记）：S5 产出登记进 continuity_ledger
          ir.continuity_ledger.push({
            check: 'shot_prompt_version',
            beat_span: shot.id,
            status: 'repaired',
            note: `prompt_v2+ repair @ ${sourceScriptHash.slice(0, 8)}（gates: ${gateViolations.map((g) => g.split('(')[0]).join(',') || 'auditor'}）`,
          });
        } catch (e) {
          if (e instanceof CallerCancelledError) throw e; // P2-5：取消不得被吞成 advisory（zombie 防线）
          advisories.push(`repair_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
        }
      }
    }
  }
  trace.push({ name: 'shot_loop', ms: performance.now() - tLoop });

  // ── dialect 编译（spec §3：DirectingIR → dialect → 官方格式文本）──
  // S3 填充 H3Shot 兼容内容字段 → compileH3 逐镜编译为分 stage 官方格式
  // R2（spec §6.1②）：speaker ID 源 = characters[].id 逐镜注入（编译作用域只见单镜，
  // 跨镜稳定 ID 不能靠 collectSpeakerIds 重推导）；身份短语 = character.name（官方格式
  // `Name (S1) says:`，名称缺失回退 appearance_lock，再回退原 who/缺省 The speaker）。
  const charById = new Map(ir.characters.map((c) => [c.id, c]));
  for (const beat of ir.beats) {
    for (const shot of beat.shots) {
      // P2-4a（对抗审查）：编译循环不得覆盖已批准/已修复稿——prompt 非空的镜文本已定稿
      // （S5 修复产物可能已是 prompt_v2+，确定性重编译会静默回退修复），原样保留。
      if (shot.prompt != null) continue;
      try {
        const dialogueText =
          typeof shot.dialogue === 'string' ? shot.dialogue : (shot.dialogue?.text ?? '');
        const hasDialogue = dialogueText.trim() !== '';
        let label = shot.who;
        let speakerIds: Map<string, string> | undefined;
        if (hasDialogue) {
          const speakerId = shot.direction?.dialogue?.speaker_id ?? shot.who;
          const speakerChar = speakerId != null ? charById.get(speakerId) : undefined;
          if (speakerChar) {
            label = speakerChar.name || speakerChar.appearance_lock || speakerChar.id;
            speakerIds = new Map([[label, speakerChar.id]]);
          }
          // speaker 不在 characters（G-dialogue-official 会另记 critical）：保持原 who，缺省分配
        }
        const h3Input = {
          duration_seconds: shot.duration_seconds,
          shots: [{
            what: shot.what,
            who: label,
            duration: shot.duration_seconds,
            camera: shot.camera,
            action: shot.action,
            micro: shot.micro,
            carry: shot.carry,
            ambient: shot.ambient,
            dialogue: shot.dialogue,
          }],
          // R3（spec §4 Δ3 / G-refbinding）：reference_plan 绑定进编译——identity→角色 appearance_lock、
          // location→空间地标、prop→道具；who 键与 shot 身份标签同源（保 applySubjectLabels 的
          // <Subject N> 替换对齐）。图片/视频文件本身属 D-U3 执行面（camera-video 供素材），此处
          // 只绑定官方文本格式的主体声明位，不伪造素材路径。
          references: (shot.reference_plan ?? [])
            .map((rp): { who: string; image: string; width: null; height: null; description?: string } | null => {
              if (rp.role === 'identity_subject') {
                const c = charById.get(rp.target);
                return {
                  who: c ? c.name || c.id : rp.target,
                  image: '',
                  width: null,
                  height: null,
                  ...(c?.appearance_lock ? { description: c.appearance_lock } : {}),
                };
              }
              if (rp.role === 'location_subject') {
                const l = ir.locations.find((x) => x.id === rp.target);
                return {
                  who: l ? l.name : rp.target,
                  image: '',
                  width: null,
                  height: null,
                  ...(l?.spatial_landmarks ? { description: l.spatial_landmarks } : {}),
                };
              }
              if (rp.role === 'prop_subject') {
                const p = ir.props.find((x) => x.id === rp.target);
                return { who: p ? p.name : rp.target, image: '', width: null, height: null };
              }
              return null; // composition_picture/motion_video/audio_reference：执行绑定不做（spec §10）
            })
            .filter((r): r is { who: string; image: string; width: null; height: null; description?: string } => r != null),
        };
        const compiled = compileDirectingShot(h3Input, { stage: shot.stage, speakerIds });
        // R6（spec §6 rules-h3 复用落位）：逐镜接现行文本审计——cut 语法/信息增量/字段结构/对白标记
        try {
          const textGates = auditH3Full(
            compiled.text,
            { stage: shot.stage, duration: shot.duration_seconds, shotCount: 1 },
            h3Input.references,
          );
          for (const g of textGates) {
            compiledGates.push({
              rule: String((g as { rule?: string }).rule ?? 'h3_audit'),
              severity: String((g as { severity?: string }).severity ?? 'critical'),
              detail: `shots[${shot.id}] ${String((g as { detail?: string }).detail ?? '')}`,
              source: 'directing/h3-audit',
            });
          }
        } catch (e) {
          advisories.push(`h3_audit_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
        }
        // R7（spec §6 G-budget）：官方 tokenizer 精确计数（现行机制复用）+ token_count 落值
        try {
          const budget = buildH3Budget(shot.stage, compiled.text, h3Input.references as never[]);
          if (budget.over) {
            compiledGates.push({
              rule: 'G-budget',
              severity: 'critical',
              detail: `shots[${shot.id}] 超预算: text_tokens=${budget.textTokens} effective_cap=${budget.effectiveCap} char=${budget.charCount}/${budget.charLimit}${budget.tokenOver ? ' (token_over)' : ''}${budget.charOver ? ' (char_over)' : ''}`,
              source: 'directing/check',
            });
          }
          shot.prompt = { text: compiled.text, token_count: budget.textTokens };
        } catch (e) {
          advisories.push(`budget_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
          shot.prompt = { text: compiled.text, token_count: 0 };
        }
      } catch (e) {
        if (e instanceof CallerCancelledError) throw e; // P2-5：取消不得被吞成 advisory（zombie 防线）
        advisories.push(`compile_failed:${shot.id}:${(e as Error).message.slice(0, 120)}`);
        shot.prompt = null;
      }
    }
  }

  // 最终机器门（全工程）+ 编译步产物门（R6/R7）合并
  allGates = [
    ...checkDirectingIr(ir, { strict: ir.meta.strict_prompt_validation === true, scriptText: scriptTextForGates }),
    ...compiledGates,
  ];
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
    ...(lastAuditorResult !== undefined ? { auditor: lastAuditorResult } : {}),
    trace,
  };
}
