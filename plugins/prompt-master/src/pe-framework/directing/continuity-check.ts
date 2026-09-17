/**
 * 连续性机检 12 门（spec 2026-09-17-h3-agentic-directing-pipeline-design §6，零 LLM）：
 * 对 DirectingIR 逐门确定性谓词检查，产出 Gate[]（复用 compositing/audit.ts 的 Gate 形状）。
 * 门清单：G-schema / G-purpose / G-duration / G-intents / G-refbinding / G-dialogue-official /
 *         G-prop / G-handoff / G-shotcard / G-sound / G-signature / G-unit。
 * 严重度：全部 critical 除非注明（G-duration tag 区间=important；G-unit 默认 warning）。
 * N11 双模开关：strict=true 时 warning 级升 critical（沿 director-suite）。
 * 纯函数：依赖 ir-schema 校验与常量，零 anima-catalog 依赖。
 */
import {
  validateDirectingIr,
  PURPOSE_TAGS,
  DURATION_RANGES,
  type DirectingIr,
  type PurposeTag,
  type Stage,
  type ReferenceRole,
} from './ir-schema.js';

export type GateSeverity = 'critical' | 'important' | 'warning';

export interface DirectingGate {
  rule: string;
  severity: GateSeverity;
  detail: string;
  source: 'directing/check';
}

export interface CheckOpts {
  /** N11 双模：true 时 warning 级升 critical */
  strict?: boolean;
}

const PURPOSE_ROLE_SET: Record<Stage, ReferenceRole[]> = {
  t2va: [],
  i2va: ['composition_picture'],
  fl2va: ['composition_picture'],
  l2va: ['composition_picture'],
  ref2va: ['identity_subject', 'location_subject', 'prop_subject'],
};

/** H3 生成硬约束（秒）——官方 4s 下限 / 15s 上限 */
const H3_MIN_DURATION = 4;
const H3_MAX_DURATION = 15;

export function checkDirectingIr(ir: DirectingIr, opts?: CheckOpts): DirectingGate[] {
  const gates: DirectingGate[] = [];
  const strict = opts?.strict ?? false;
  const push = (rule: string, severity: GateSeverity, detail: string): void => {
    gates.push({ rule, severity, detail, source: 'directing/check' });
  };
  const allShots = ir.beats.flatMap((b) => b.shots.map((s) => ({ beat: b, shot: s })));

  // G-schema：转发 validateDirectingIr（结构/枚举/引用完整性）
  const schema = validateDirectingIr(ir);
  for (const m of schema.missing) push('G-schema', 'critical', m);

  // G-purpose：purpose_tag ∈ 六枚举
  for (const { shot } of allShots) {
    if (!PURPOSE_TAGS.includes(shot.purpose_tag as PurposeTag)) {
      push('G-purpose', 'critical', `shots[${shot.id}].purpose_tag 非法: ${shot.purpose_tag}（合法: ${PURPOSE_TAGS.join('|')}）`);
    }
  }

  // G-duration：tag 区间越界 = important（叙事节奏信号）；Beat 总时长（= 生成单元）越界 = critical（H3 硬约束）
  for (const { shot } of allShots) {
    const range = DURATION_RANGES[shot.purpose_tag as PurposeTag];
    const d = shot.duration_seconds;
    if (range && (d < range[0] || d > range[1])) {
      push(
        'G-duration',
        'important',
        `shots[${shot.id}] duration ${d}s 超出 ${shot.purpose_tag} 区间 [${range[0]},${range[1]}]（叙事节奏信号）`,
      );
    }
  }
  for (const beat of ir.beats) {
    const total = beat.shots.reduce((s, x) => s + x.duration_seconds, 0);
    if (total < H3_MIN_DURATION || total > H3_MAX_DURATION) {
      push(
        'G-duration',
        'critical',
        `beats[${beat.id}] 生成单元总时长 ${total.toFixed(1)}s 超出 H3 硬约束 [${H3_MIN_DURATION},${H3_MAX_DURATION}]s——过短素材应打包、过长应拆分`,
      );
    }
  }

  // G-intents：shot_intent 数 = shots 数；new_information 非空；对白 Beat ≥1 contains_reaction
  for (const beat of ir.beats) {
    if (beat.shots.length !== beat.shots.filter((s) => s.shot_intent != null).length) {
      push('G-intents', 'critical', `beats[${beat.id}] shot_intent 数与 shots 数不一致`);
    }
    for (const s of beat.shots) {
      if (s.shot_intent && s.shot_intent.new_information.trim() === '') {
        push('G-intents', 'critical', `shots[${s.id}].shot_intent.new_information 为空——无新信息的 cut 应删除或改为运镜`);
      }
    }
    const hasDialogue = beat.shots.some((s) => s.direction?.dialogue != null);
    if (hasDialogue && !beat.shots.some((s) => s.shot_intent?.contains_reaction === true)) {
      push('G-intents', 'critical', `beats[${beat.id}] 对白 Beat 缺 contains_reaction: true 的镜头`);
    }
  }

  // G-refbinding：stage ↔ 角色绑定矩阵（R1 官方 5 stages）
  for (const { shot } of allShots) {
    const allowed = PURPOSE_ROLE_SET[shot.stage as Stage];
    if (!allowed) continue;
    for (const ref of shot.reference_plan ?? []) {
      if (!allowed.includes(ref.role)) {
        push(
          'G-refbinding',
          'critical',
          `shots[${shot.id}] stage ${shot.stage} 不支持引用角色 ${ref.role}（合法: ${allowed.join('|') || '无'}）——提示词不得引用到不了模型的参考`,
        );
      }
    }
    // 合法角色的数量约束（director-suite workflow-routing：i2va 仅首帧 1 张、fl2va 首尾帧 2 张）
    const picCount = (shot.reference_plan ?? []).filter((r) => r.role === 'composition_picture').length;
    if (shot.stage === 'i2va' && picCount > 1) {
      push('G-refbinding', 'critical', `shots[${shot.id}] i2va 仅支持 1 张首帧构图参考，实际 ${picCount} 张`);
    }
    if (shot.stage === 'fl2va' && picCount > 2) {
      push('G-refbinding', 'critical', `shots[${shot.id}] fl2va 仅支持 2 张首尾帧构图参考，实际 ${picCount} 张`);
    }
  }

  // G-dialogue-official：truncated 仅末镜；speaker_id ∈ characters
  const charIds = new Set(ir.characters.map((c) => c.id));
  const lastBeat = ir.beats[ir.beats.length - 1];
  const lastShotId = lastBeat?.shots[lastBeat.shots.length - 1]?.id;
  for (const { shot } of allShots) {
    const d = shot.direction?.dialogue;
    if (!d) continue;
    if (!charIds.has(d.speaker_id)) {
      push('G-dialogue-official', 'critical', `shots[${shot.id}] speaker_id ${d.speaker_id} 不在 characters 中`);
    }
    // truncated 仅末镜合法（official: speech truncated by the end of the video）
    const truncatedOnShot =
      (typeof shot.dialogue === 'object' && shot.dialogue?.truncated === true) ||
      (d as unknown as { truncated?: boolean }).truncated === true;
    if (truncatedOnShot && shot.id !== lastShotId) {
      push('G-dialogue-official', 'critical', `shots[${shot.id}] <cutoff> 仅允许在全片末镜（当前非末镜）`);
    }
  }

  // G-prop：三态结构 + 出现覆盖
  for (const p of ir.props) {
    for (const [beatId, state] of Object.entries(p.state_by_beat)) {
      const parts = String(state).split('→').map((s) => s.trim());
      if (parts.length !== 3 || parts.some((s) => s === '')) {
        push('G-prop', 'critical', `props.${p.name}.state_by_beat[${beatId}] 三态（初态→触发→末态）结构不完整: "${state}"`);
      }
    }
  }
  // 出现覆盖：direction/what 文本提及 prop.name 的 Beat 必须在 state_by_beat 中
  for (const p of ir.props) {
    for (const beat of ir.beats) {
      const mentioned = beat.shots.some(
        (s) =>
          s.direction?.performance?.toLowerCase().includes(p.name.toLowerCase()) ||
          s.what?.toLowerCase().includes(p.name.toLowerCase()),
      );
      if (mentioned && p.state_by_beat[beat.id] === undefined) {
        push('G-prop', 'critical', `props.${p.name} 在 ${beat.id} 被引用但 state_by_beat 缺该 Beat 登记台账`);
      }
    }
  }

  // G-handoff：非首 Beat 四通道非空
  ir.beats.forEach((beat, bi) => {
    if (bi === 0) return;
    for (const s of beat.shots) {
      const h = s.continuity_handoff;
      for (const f of ['positions', 'emotion', 'props', 'audio'] as const) {
        if (!h[f] || h[f].trim() === '') {
          push('G-handoff', 'critical', `beats[${beat.id}].shots[${s.id}].continuity_handoff.${f} 非空缺失（非首 Beat 四通道必填）`);
        }
      }
    }
  });

  // G-shotcard：镜号连续（Beat 内 S1..Sn）；sound 必填；tags ≤2；time 连续
  for (const beat of ir.beats) {
    beat.shots.forEach((s, si) => {
      const expected = `${beat.id}-S${si + 1}`;
      if (s.id !== expected) {
        push('G-shotcard', 'critical', `镜号不连续: 期望 ${expected}，实际 ${s.id}`);
      }
      if (!s.sound || s.sound.trim() === '') {
        push('G-shotcard', 'critical', `shots[${s.id}].sound 必填（静默也写）`);
      }
      if ((s.tags ?? []).length > 2) {
        push('G-shotcard', 'critical', `shots[${s.id}].tags 超限（≤2）`);
      }
      if (si > 0) {
        const prev = beat.shots[si - 1];
        const prevEnd = prev.time && prev.duration_seconds ? (parseTimeToSeconds(prev.time) ?? 0) + prev.duration_seconds : null;
        const curStart = parseTimeToSeconds(s.time);
        if (prevEnd != null && curStart != null && Math.abs(curStart - prevEnd) > 0.01) {
          push(
            'G-shotcard',
            'important',
            `shots[${s.id}].time 不连续: 前镜出口 ${prevEnd.toFixed(2)}s，本镜入口 ${curStart.toFixed(2)}s`,
          );
        }
      }
    });
  }

  // G-sound：sound_events ≤12 且顺序固定
  if (ir.meta.sound_events && ir.meta.sound_events.length > 12) {
    push('G-sound', 'critical', `sound_events ${ir.meta.sound_events.length} 超限（12-slot 固定顺序，禁跳号）`);
  }

  // G-signature：color_ids ≤6 / master_dna ≤3 / core_theme 非空
  const sig = ir.meta.audiovisual_signature as Record<string, Record<string, unknown>> | undefined;
  if (sig) {
    const colorIds = (sig.color_ids ?? {}) as Record<string, string>;
    const colorN = Object.keys(colorIds).length;
    if (colorN > 6) push('G-signature', 'critical', `audiovisual_signature.color_ids ${colorN} 超限（≤6，每角色一色相）`);
    const dnaN = Array.isArray(sig.master_dna) ? sig.master_dna.length : 0;
    if (dnaN > 3) push('G-signature', 'critical', `audiovisual_signature.master_dna ${dnaN} 超限（≤3，超过会互相打架）`);
    const theme = String(sig.core_theme ?? '');
    if (theme.trim() === '' || theme.split(/\s+/).length < 3) {
      push('G-signature', 'critical', `audiovisual_signature.core_theme 必须可拍（主语+比喻动词+宾语，≥3 词）: "${theme}"`);
    }
  }

  // G-unit：climax 位置 60-80%（默认 warning；strict 升 critical）
  if (ir.meta.climax_segment) {
    const totalDuration = ir.beats.reduce((sum, b) => sum + b.shots.reduce((s, x) => s + x.duration_seconds, 0), 0);
    const climaxBeat = ir.beats.find((b) => b.id === ir.meta.climax_segment);
    if (climaxBeat) {
      let start = 0;
      for (const b of ir.beats) {
        if (b.id === ir.meta.climax_segment) break;
        start += b.shots.reduce((s, x) => s + x.duration_seconds, 0);
      }
      const ratio = totalDuration > 0 ? start / totalDuration : 0;
      if (ratio < 0.6 || ratio > 0.8) {
        push(
          'G-unit',
          strict ? 'critical' : 'warning',
          `climax_segment ${ir.meta.climax_segment} 起始位置 ${(ratio * 100).toFixed(0)}% 在全片 60-80% 窗口外`,
        );
      }
    }
  }

  // N11 双模：strict → warning 升 critical
  return strict ? gates.map((g) => (g.severity === 'warning' ? { ...g, severity: 'critical' as GateSeverity } : g)) : gates;
}

function parseTimeToSeconds(time: string): number | null {
  const m = time.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
