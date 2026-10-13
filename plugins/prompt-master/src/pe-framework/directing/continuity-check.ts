/**
 * 连续性机检 12 门（spec 2026-09-17-h3-agentic-directing-pipeline-design §6，零 LLM）：
 * 对 DirectingIR 逐门确定性谓词检查，产出 Gate[]（复用 compositing/audit.ts 的 Gate 形状）。
 * 门清单（IR 面）：G-schema / G-purpose / G-duration / G-intents / G-refbinding / G-cameramotion /
 *         G-dialogue-official / G-dialogue（逐字对账）/ G-prop / G-handoff / G-shotcard / G-sound /
 *         G-signature / G-unit。G-cutgrammar / G-budget 在编排器编译步接线（rules-h3 审计 + 官方
 *         tokenizer 预算，source='directing/h3-audit'/'directing/check'，见 orchestrate.ts）。
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
  /** R4（spec §6 G-dialogue Δ4）：原剧本文本——在场时对 `<d>` 文本做逐字对账（source_script_hash 对账面） */
  scriptText?: string;
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

/** R5（spec §6 G-cameramotion / N3 机位·运动 语法）：机位·运动 结构与运动语汇的可确定性机检面 */
const CAMERA_MOTION_TOKENS = [
  '推', '拉', '摇', '移', '跟', '甩', '晃', '环绕', '升降', '手持', '静止', '升', '降',
  'push', 'pull', 'pan', 'tilt', 'track', 'dolly', 'orbit', 'crane', 'handheld', 'zoom', 'static', 'locked',
];

/** R23（spec §6 G-sound / N4 声音 12-slot 规范名，源：deep-analysis A3 storyboard-schema） */
const SOUND_SLOTS = [
  '开场基底', '第一个高频锚点', '仪式启动音', '第一次撞击', '中频群', '关键V.O.',
  '第一次静默', '静默回归', '主题动作音', '高潮余震', '全片唯一', '结尾尾音',
];

/** R21：core_theme 可拍性词数——ASCII 词 + CJK 字符/2 折算（中文三词主谓宾 ≈ 6 字） */
function themeWordCount(theme: string): number {
  const ascii = theme.match(/[a-zA-Z0-9]+/g)?.length ?? 0;
  const cjk = theme.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return ascii + Math.ceil(cjk / 2);
}

/** #29-3：正则元字符转义（角色名来自 LLM/用户产出，可含元字符） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** #29-5：motif 词元 = ASCII 词（小写）+ CJK 二元组（echo 重叠豁免用） */
function motifTokens(motif: string): string[] {
  const words = motif.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const cjk = motif.match(/[\u4e00-\u9fff]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < cjk.length; i++) bigrams.push(`${cjk[i]}${cjk[i + 1]}`);
  return [...words, ...bigrams];
}

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
    // #29-1（A 路 P2）：缺/非数值不再静默过门——undefined 参与 < 比较 = NaN 恒 false 的语言陷阱
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      push('G-duration', 'important', `shots[${shot.id}] duration_seconds 缺失或非数值（各 stage 必填，硬约束 [${H3_MIN_DURATION},${H3_MAX_DURATION}]s）`);
      continue;
    }
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
    // R20（spec §6：l2va=Picture 1 末帧）：末帧 stage 同样单图约束
    if (shot.stage === 'l2va' && picCount > 1) {
      push('G-refbinding', 'critical', `shots[${shot.id}] l2va 仅支持 1 张末帧构图参考，实际 ${picCount} 张`);
    }
  }

  // R5（spec §6 G-cameramotion / N3 机位·运动）：camera 列必填且含运动语汇（可确定性机检面）；
  // 「motion×amplitude×speed 自然英语」语义面归 S3 persona 纪律（LLM 轨），机检不装懂语义
  for (const { shot } of allShots) {
    const camera = String(shot.camera ?? '').trim();
    if (camera === '') {
      push('G-cameramotion', 'critical', `shots[${shot.id}].camera 必填（N3 机位·运动 7 列镜头卡）`);
      continue;
    }
    const lower = camera.toLowerCase();
    const hasMotion = CAMERA_MOTION_TOKENS.some((t) => lower.includes(t));
    if (!hasMotion) {
      push('G-cameramotion', 'critical', `shots[${shot.id}].camera 无运动语汇（机位·运动 语法，禁纯景别/纯机位）: "${camera}"`);
    }
  }

  // G-dialogue-official：truncated 仅末镜；speaker_id ∈ characters
  const charIds = new Set(ir.characters.map((c) => c.id));
  const charNames = ir.characters.map((c) => c.name).filter((n) => n && n.trim() !== '');
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

  // R4（spec §6 G-dialogue Δ4）：`<d>` 文本与 script 台词逐字相等（scriptText 对账）；
  // 标签内禁冒号、禁角色名（官方：<d> 内只有语言标签+口语原文）
  for (const { shot } of allShots) {
    const d = shot.direction?.dialogue;
    const emitted =
      typeof shot.dialogue === 'string'
        ? shot.dialogue
        : (shot.dialogue?.text ?? d?.line ?? '');
    const text = emitted.trim();
    if (text === '') continue;
    if (text.includes(':') || text.includes('：')) {
      push('G-dialogue', 'critical', `shots[${shot.id}] <d> 标签内禁冒号（口语原文 only）: "${text.slice(0, 40)}"`);
    }
    // #29-3（A 路 P2，R4 谓词收窄）：禁的是「身份短语走私进 <d>」（Name 前缀接 (Sx)/says/said 形态），
    // 不是台词自然提及人名（「侦探，你终于来了」合法）——原 includes 子串判死误伤合法台词。
    const nameHit = charNames.find((n) => n && new RegExp(`^\\s*${escapeRegExp(n)}\\s*(\\(|says\\b|said\\b|说)`, 'i').test(text));
    if (nameHit) {
      push('G-dialogue', 'critical', `shots[${shot.id}] <d> 标签内禁身份短语前缀 "${nameHit}"（身份短语在标签外）`);
    }
    if (opts?.scriptText != null && !opts.scriptText.includes(text)) {
      push('G-dialogue', 'critical', `shots[${shot.id}] <d> 文本与 script 台词不逐字（source_script_hash 对账失败）: "${text.slice(0, 40)}"`);
    }
    if (d?.line != null && d.line.trim() !== '' && d.line.trim() !== text) {
      push('G-dialogue', 'critical', `shots[${shot.id}] S2 台词与 S3 发射文本不一致（双保险对账失败）`);
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
        // P0-2（A 路审查）：S2 少吐 continuity_handoff（LLM 常态）不得 TypeError 崩链——缺对象 = 四通道全缺
        if (!h || !h[f] || h[f].trim() === '') {
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
          // R19（spec §6「全部 critical 除非注明」，G-shotcard 无注明）：时间连续性升 critical
          push(
            'G-shotcard',
            'critical',
            `shots[${s.id}].time 不连续: 前镜出口 ${prevEnd.toFixed(2)}s，本镜入口 ${curStart.toFixed(2)}s`,
          );
        }
      }
    });
  }

  // G-sound：≤12 + R23 子谓词（顺序固定禁跳号、每项 序号+规范槽名=event；N/A 占位合法）
  if (ir.meta.sound_events) {
    const events = ir.meta.sound_events;
    if (events.length > 12) {
      push('G-sound', 'critical', `sound_events ${events.length} 超限（12-slot 固定顺序，禁跳号）`);
    }
    let lastSlot = -1;
    events.forEach((raw, i) => {
      const entry = String(raw).trim();
      if (entry === '' ) {
        push('G-sound', 'critical', `sound_events[${i}] 空条目（无对应写 N/A，禁跳号）`);
        return;
      }
      // N/A 占位合法（spec §4「无对应写 N/A」；#29-4 容注记形态：「N/A（无合唱）」「2 N/A - ambient only」）
      if (/^n\/?a(?![a-z])/i.test(entry.replace(/^\d+\s*/, ''))) return;
      const ordinal = entry.match(/^(\d+)\s*/);
      if (!ordinal) {
        push('G-sound', 'critical', `sound_events[${i}] 缺序号前缀（每项含 time/event，格式「${i + 1} 槽名 事件」）: "${entry.slice(0, 30)}"`);
        return;
      }
      if (Number(ordinal[1]) !== i + 1) {
        push('G-sound', 'critical', `sound_events[${i}] 序号跳号: 期望 ${i + 1}，实际 ${ordinal[1]}（禁跳号）`);
      }
      const slotIdx = SOUND_SLOTS.findIndex((slot) => entry.toLowerCase().includes(slot.toLowerCase()));
      if (slotIdx < 0) {
        push('G-sound', 'critical', `sound_events[${i}] 不含 12-slot 规范名（顺序固定）: "${entry.slice(0, 30)}"`);
        return;
      }
      if (slotIdx <= lastSlot && lastSlot >= 0) {
        push('G-sound', 'critical', `sound_events[${i}] 槽序倒置/重复（顺序固定禁跳号）: "${entry.slice(0, 30)}"`);
      }
      lastSlot = slotIdx;
    });
  }

  // G-signature：8 字段齐全 + color_ids ≤6 每角色一色相（禁漏色重色）/ master_dna ≤3 / core_theme 可拍
  const sig = ir.meta.audiovisual_signature as Record<string, Record<string, unknown>> | undefined;
  if (sig) {
    // 字段齐全（spec §4 jsonc 规范形状：medium/aspect/color_ids/texture/core_theme/master_dna/genre_formula）
    const requiredKeys = ['medium', 'aspect', 'color_ids', 'texture', 'core_theme', 'master_dna', 'genre_formula'];
    for (const key of requiredKeys) {
      const v = sig[key] as unknown;
      const empty = v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);
      if (empty) push('G-signature', 'critical', `audiovisual_signature.${key} 缺失（8 字段齐全）`);
    }
    const colorIds = (sig.color_ids ?? {}) as Record<string, string>;
    const colorN = Object.keys(colorIds).length;
    if (colorN > 6) push('G-signature', 'critical', `audiovisual_signature.color_ids ${colorN} 超限（≤6，每角色一色相）`);
    // 每角色一色相：禁漏色（角色无色相）+ 禁重色（多角色同色相）
    const missingHue = ir.characters.filter((c) => !(c.id in colorIds));
    if (missingHue.length > 0) {
      push('G-signature', 'critical', `audiovisual_signature.color_ids 漏色: ${missingHue.map((c) => c.id).join(',')}（每角色一色相）`);
    }
    const hues = Object.values(colorIds).map((v) => String(v).trim().toLowerCase());
    const dupHues = hues.filter((h, i) => hues.indexOf(h) !== i);
    if (dupHues.length > 0) {
      push('G-signature', 'critical', `audiovisual_signature.color_ids 重色: ${[...new Set(dupHues)].join(',')}（每角色一色相，禁重色）`);
    }
    const dnaN = Array.isArray(sig.master_dna) ? sig.master_dna.length : 0;
    if (dnaN > 3) push('G-signature', 'critical', `audiovisual_signature.master_dna ${dnaN} 超限（≤3，超过会互相打架）`);
    const theme = String(sig.core_theme ?? '');
    // R21：可拍性词数双语化——ASCII 词 + CJK 字符/2 折算（中文三词主谓宾 ≈ 6 字）
    if (theme.trim() === '' || themeWordCount(theme) < 3) {
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

  // G-unit（N6）相邻单元 ≥1 种对比：dramatic_task/visual_motif/hook 三字段全同 = 零对比（critical）
  const norm = (v: unknown): string => String(v ?? '').replace(/\s+/g, '').toLowerCase();
  for (let i = 1; i < ir.beats.length; i++) {
    const prev = ir.beats[i - 1].unit;
    const cur = ir.beats[i].unit;
    if (!prev || !cur) continue;
    const allSame =
      norm(prev.dramatic_task) === norm(cur.dramatic_task) &&
      norm(prev.visual_motif) === norm(cur.visual_motif) &&
      norm(prev.hook) === norm(cur.hook);
    if (allSame) {
      push('G-unit', 'critical', `beats[${ir.beats[i - 1].id}]→beats[${ir.beats[i].id}] 相邻单元三字段全同（N6 相邻单元 ≥1 种对比）`);
    }
  }
  // G-unit（N6）首末单元意象 echo：两端 unit.visual_motif 均在场且不同 = echo 缺失（默认 warning，strict 拒绝）
  const firstUnit = ir.beats[0]?.unit;
  const lastUnit = ir.beats[ir.beats.length - 1]?.unit;
  const firstMotif = String(firstUnit?.visual_motif ?? '').trim();
  const lastMotif = String(lastUnit?.visual_motif ?? '').trim();
  // #29-5（A 路 P2「echo 门过强」）：echo 判定从全等放宽为词元重叠豁免——首末 motif 共享任一
  // ASCII 词或 CJK 二元组即视为 echo 在场（「neon gate」→「the same neon gate, now dry」不判缺失），
  // 只对词元完全不相交的意象判 echo 缺失（「红伞」vs「蓝灯」仍判）。
  if (
    ir.beats.length > 1 &&
    firstMotif !== '' &&
    lastMotif !== '' &&
    norm(firstMotif) !== norm(lastMotif) &&
    motifTokens(firstMotif).filter((t) => motifTokens(lastMotif).includes(t)).length === 0
  ) {
    push(
      'G-unit',
      strict ? 'critical' : 'warning',
      `首末单元意象 echo 缺失: visual_motif "${firstMotif}" ≠ "${lastMotif}"（N6 首末 echo；词元零重叠）`,
    );
  }

  // N11 双模：strict → warning 升 critical
  return strict ? gates.map((g) => (g.severity === 'warning' ? { ...g, severity: 'critical' as GateSeverity } : g)) : gates;
}

function parseTimeToSeconds(time: string | undefined): number | null {
  // 缺字段/非 MM:SS（如中文场景描述）→ null：时间连续门按不可判定跳过，不得整链崩溃
  // （对抗审查 P2-4c 测试暴露：S2 产出 IR 缺 time 时 checkDirectingIr 直崩）
  if (typeof time !== 'string') return null;
  const m = time.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
