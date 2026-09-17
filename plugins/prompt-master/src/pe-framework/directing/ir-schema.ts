/**
 * DirectingIR schema 与校验（spec 2026-09-17-h3-agentic-directing-pipeline-design §4）：
 * H3 多镜头短剧工程的交换格式。本模块 = 类型 + 确定性手写校验（沿 blueprint/schema.ts 模式），
 * 零 LLM；§6 机器门的跨镜/预算类检查在 continuity-check.ts（Task 3）。
 * 校验规则（全部确定性谓词）：
 * - creative_intent 四字段可观察、非空
 * - shots[].shot_intent 与 shots 数量严格相等；每镜 new_information 非空；对白 Beat ≥1 contains_reaction
 * - purpose_tag ∈ 六枚举；stage ∈ 官方五枚举；duration_seconds 落入该 tag 区间
 * - props.state_by_beat 三态（初态→触发→末态）
 * - 非首 Beat 的 continuity_handoff 四通道非空
 */

export const PURPOSE_TAGS = ['dialogue', 'mixed', 'action', 'establish', 'insert', 'reaction'] as const;
export type PurposeTag = (typeof PURPOSE_TAGS)[number];

export const STAGES = ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'] as const;
export type Stage = (typeof STAGES)[number];

/** 各 purpose_tag 合法时长区间（秒）——playbook 时长 taxonomy */
export const DURATION_RANGES: Record<PurposeTag, [number, number]> = {
  dialogue: [2, 4],
  mixed: [1.5, 3],
  action: [0.4, 1.5],
  establish: [2, 4],
  insert: [0.5, 2],
  reaction: [1, 2],
};

export interface CreativeIntent {
  state_before: string;
  trigger: string;
  state_after: string;
  audience_takeaway: string;
}

export interface ShotIntent {
  new_information: string;
  narrative_subject: string;
  contains_reaction: boolean;
}

export type ReferenceRole =
  | 'identity_subject'
  | 'location_subject'
  | 'prop_subject'
  | 'composition_picture'
  | 'motion_video'
  | 'audio_reference';

export interface ReferencePlanEntry {
  role: ReferenceRole;
  target: string;
  h3_label: string;
}

export interface BeatDirection {
  performance: string;
  staging: string;
  cinematography: string;
  dialogue: { speaker_id: string; line: string; addressee_id: string | null } | null;
  micro_performance: string;
}

export interface ContinuityHandoff {
  positions: string;
  emotion: string;
  props: string;
  audio: string;
}

export interface DirectingShot {
  id: string;
  purpose_tag: PurposeTag;
  time: string;
  duration_seconds: number;
  shot_size: string;
  camera: string;
  /** 镜头内容描述（G-prop 出现覆盖判定用） */
  what: string;
  /** shot 级对白（D-U7 官方对白契约：dialect 发射层消费） */
  dialogue?: string | { text: string; language?: string; voiceover?: boolean; continues_across_cut?: boolean; truncated?: boolean };
  transition?: string;
  technique?: string | null;
  tags?: string[];
  sound: string;
  stage: Stage;
  route_reason: string;
  shot_intent: ShotIntent;
  reference_plan: ReferencePlanEntry[];
  direction: BeatDirection;
  continuity_handoff: ContinuityHandoff;
  prompt: { text: string; token_count: number } | null;
  audit: { gates: unknown[]; findings: unknown[]; verdict: string } | null;
}

export interface DirectingBeat {
  id: string;
  purpose: string;
  /** 可选单元结构（N6）：unit/dramatic_task/visual_motif/hook */
  unit?: { dramatic_task: string; visual_motif: string; hook: string } | null;
  creative_intent: CreativeIntent;
  location_id: string;
  character_ids: string[];
  shots: DirectingShot[];
}

export interface DirectingIr {
  meta: {
    title: string;
    source_script_hash: string;
    created_at: string;
    dialect: string;
    director_schema_version: number;
    rating?: string;
    original_rating?: string;
    strict_prompt_validation?: boolean;
    climax_segment?: string;
    audiovisual_signature?: Record<string, unknown>;
    sound_events?: string[];
    world_anchors?: Record<string, string> | null;
  };
  characters: Array<{ id: string; name: string; appearance_lock: string; wardrobe: string; notes: string; four_view_refs?: Record<string, string> | null }>;
  locations: Array<{ id: string; name: string; spatial_landmarks: string }>;
  props: Array<{ id: string; name: string; state_by_beat: Record<string, string> }>;
  beats: DirectingBeat[];
  continuity_ledger: Array<{ check: string; beat_span: string; status: string; note: string }>;
}

export interface ScriptIr {
  // appearance_lock 运行时必查（S1 契约），但输入类型允许缺失——校验器负责报违规
  characters: Array<{ id: string; name: string; appearance_lock?: string; wardrobe?: string; notes?: string }>;
  locations: Array<{ id: string; name: string; spatial_landmarks: string }>;
  props: Array<{ id: string; name: string }>;
  info_cuts: Array<{ beat_hint: string; change: string }>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkCreativeIntent(ci: unknown, path: string, missing: string[]): void {
  if (!isObj(ci)) {
    missing.push(`${path}.creative_intent 缺失`);
    return;
  }
  for (const f of ['state_before', 'trigger', 'state_after', 'audience_takeaway'] as const) {
    if (!isStr(ci[f])) missing.push(`${path}.creative_intent.${f} 非空缺失`);
  }
}

function checkPropStates(ir: DirectingIr, missing: string[]): void {
  for (const p of ir.props) {
    for (const [beatId, state] of Object.entries(p.state_by_beat)) {
      const parts = String(state).split('→').map((s) => s.trim());
      if (parts.length !== 3 || parts.some((s) => s === '')) {
        missing.push(`props.${p.name}.state_by_beat[${beatId}] 三态（初态→触发→末态）结构不完整`);
      }
    }
  }
}

export function validateDirectingIr(ir: DirectingIr): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!isObj(ir.meta) || !isStr(ir.meta.title)) missing.push('meta.title 缺失');
  if (!Array.isArray(ir.characters) || ir.characters.length === 0) missing.push('characters 空');
  for (const c of ir.characters ?? []) {
    if (!isStr(c.id) || !isStr(c.name) || !isStr(c.appearance_lock)) {
      missing.push(`characters[${c.id ?? '?'}] 缺 id/name/appearance_lock`);
    }
  }
  for (const l of ir.locations ?? []) {
    if (!isStr(l.id) || !isStr(l.name)) missing.push(`locations[${l.id ?? '?'}] 缺 id/name`);
  }
  checkPropStates(ir, missing);

  let hasDialogueBeat = false;
  (ir.beats ?? []).forEach((beat, bi) => {
    const path = `beats[${beat.id ?? bi}]`;
    checkCreativeIntent(beat.creative_intent, path, missing);
    if (!isStr(beat.id) || !isStr(beat.purpose)) missing.push(`${path} 缺 id/purpose`);
    if (!Array.isArray(beat.shots) || beat.shots.length === 0) {
      missing.push(`${path}.shots 空`);
      return;
    }
    if (beat.shots.some((s) => (s.direction?.dialogue?.line ?? '').trim() !== '')) hasDialogueBeat = true;

    if (beat.shots.length !== beat.shots.filter((s) => isObj(s.shot_intent)).length) {
      missing.push(`${path}.shot_intent 数与 shots 数不一致`);
    }
    for (const s of beat.shots) {
      if (!PURPOSE_TAGS.includes(s.purpose_tag)) missing.push(`${path}.shots[${s.id}].purpose_tag 非法: ${s.purpose_tag}`);
      if (!STAGES.includes(s.stage)) missing.push(`${path}.shots[${s.id}].stage 非法: ${s.stage}`);
      const range = DURATION_RANGES[s.purpose_tag];
      if (range && (s.duration_seconds < range[0] || s.duration_seconds > range[1])) {
        missing.push(`${path}.shots[${s.id}].duration ${s.duration_seconds}s 超出 ${s.purpose_tag} 区间 [${range[0]},${range[1]}]`);
      }
      const si = s.shot_intent;
      if (!isObj(si) || !isStr(si.new_information)) missing.push(`${path}.shots[${s.id}].shot_intent.new_information 缺失`);
      if (!Array.isArray(s.reference_plan)) missing.push(`${path}.shots[${s.id}].reference_plan 缺失`);
      for (const ref of s.reference_plan ?? []) {
        if (!PURPOSE_ROLE_SET.has(ref.role)) missing.push(`${path}.shots[${s.id}].reference_plan.role 非法: ${ref.role}`);
      }
      const d = s.direction?.dialogue;
      if (d && (!isStr(d.speaker_id) || !isStr(d.line))) missing.push(`${path}.shots[${s.id}].direction.dialogue 缺 speaker_id/line`);
      const h = s.continuity_handoff;
      if (!isObj(h)) {
        missing.push(`${path}.shots[${s.id}].continuity_handoff 缺失`);
      } else {
        for (const f of ['positions', 'emotion', 'props', 'audio'] as const) {
          if (!isStr(h[f])) missing.push(`${path}.shots[${s.id}].continuity_handoff.${f} 非空缺失`);
        }
      }
      if (s.prompt !== null && (!isObj(s.prompt) || !isStr(s.prompt.text))) {
        missing.push(`${path}.shots[${s.id}].prompt.text 非法`);
      }
    }
  });
  if ((ir.beats ?? []).length > 1 && !hasDialogueBeat) {
    // 对白 Beat 契约：多 Beat 工程至少一个含台词 Beat（对白驱动短剧的领域约束）
    // 逐镜 contains_reaction 检查在下方逐镜循环内对含台词 Beat 执行
  }
  // 对白 Beat ≥1 contains_reaction（逐 Beat）
  for (const beat of ir.beats ?? []) {
    const hasDialogue = beat.shots.some((s) => s.direction?.dialogue != null);
    if (!hasDialogue) continue;
    if (!beat.shots.some((s) => s.shot_intent?.contains_reaction === true)) {
      missing.push(`beats[${beat.id}] 对白 Beat 缺 contains_reaction: true 的镜头`);
    }
  }
  // 非首 Beat handoff 四通道非空
  (ir.beats ?? []).forEach((beat, bi) => {
    if (bi === 0) return;
    for (const s of beat.shots) {
      const h = s.continuity_handoff;
      if (isObj(h)) {
        for (const f of ['positions', 'emotion', 'props', 'audio'] as const) {
          if (!isStr(h[f])) missing.push(`beats[${beat.id}].shots[${s.id}].continuity_handoff.${f} 非空缺失（非首 Beat 四通道必填）`);
        }
      }
    }
  });
  return { ok: missing.length === 0, missing };
}

const PURPOSE_ROLE_SET = new Set<string>([
  'identity_subject',
  'location_subject',
  'prop_subject',
  'composition_picture',
  'motion_video',
  'audio_reference',
]);

export function validateScriptIr(ir: ScriptIr): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const c of ir.characters ?? []) {
    if (!isStr(c.id) || !isStr(c.name)) missing.push(`characters[${c.id ?? '?'}] 缺 id/name`);
    if (!isStr(c.appearance_lock)) missing.push(`characters[${c.name ?? c.id ?? '?'}].appearance_lock 缺失`);
  }
  for (const l of ir.locations ?? []) {
    if (!isStr(l.id) || !isStr(l.name)) missing.push(`locations[${l.id ?? '?'}] 缺 id/name`);
  }
  for (const p of ir.props ?? []) {
    if (!isStr(p.id) || !isStr(p.name)) missing.push(`props[${p.id ?? '?'}] 缺 id/name`);
  }
  for (const [i, cut] of (ir.info_cuts ?? []).entries()) {
    if (!isStr(cut.beat_hint) || !isStr(cut.change)) missing.push(`info_cuts[${i}] 缺 beat_hint/change`);
  }
  return { ok: missing.length === 0, missing };
}
