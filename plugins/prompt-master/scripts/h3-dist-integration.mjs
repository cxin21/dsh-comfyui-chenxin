// R27（docs/plans/2026-09-18-h3-directing-pipeline-remediation.md §0-6）：
// dist 直连真实数据集成验证——不经 src、不经 vitest，直接 import 构建产物
// dist/src/pe-framework/directing/**，用确定性 runner 桩驱动双角色剧本全链。
// 断言七件：三件套落盘 / speaker ID 注入 / 版本台账 / 预算计数 / 参考绑定 / 续跑增量 / 两段式挂起。
// 运行：node scripts/h3-dist-integration.mjs（需先 npm run build）
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrateDirecting } from '../dist/src/pe-framework/directing/orchestrate.js';
import { emitEngineering } from '../dist/src/pe-framework/directing/engineering/emit.js';

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` :: ${detail}`}`);
  if (!ok) failures.push(name);
}

// ── 双角色剧本（ScriptIr，S1 御姐 / S2 青年）；对白台词逐字内嵌（R4 G-dialogue 对账源）──
const SCRIPT_TEXT = '霓虹街道，雨夜。御姐说：「你终于来了。」青年沉默跟上，脚步声混进城市底噪。';
const SCRIPT_IR = {
  characters: [
    { id: 'S1', name: '御姐', appearance_lock: 'tall', wardrobe: 'bodysuit', notes: '' },
    { id: 'S2', name: '青年', appearance_lock: 'slim', wardrobe: 'hoodie', notes: '' },
  ],
  locations: [{ id: 'L1', name: 'street', spatial_landmarks: 'neon gate' }],
  props: [],
  info_cuts: [{ beat_hint: 'B01', change: 'she appears' }],
};

const mkShot = (id, who, opts = {}) => ({
  id, purpose_tag: 'establish', time: 'night', duration_seconds: 4, stage: opts.stage ?? 't2va',
  what: `Shot ${id} on the neon street.`, who, shot_size: '全景', camera: '广角·慢推',
  transition: '硬切', technique: null, tags: [], route_reason: 'director',
  sound: 'city hum', action: 'She stands and surveys the street.', micro: 'fingers tighten',
  carry: 'gaze settles toward camera', ambient: 'city hum', music: '',
  dialogue: opts.line ? { text: '你终于来了。', language: 'Chinese' } : undefined,
  shot_intent: { new_information: `new info at ${id}`, narrative_subject: 'her presence', contains_reaction: opts.reaction === true },
  reference_plan: opts.stage === 'ref2va' ? [{ role: 'identity_subject', target: who, h3_label: who === 'S1' ? '御姐' : '青年' }] : [],
  direction: {
    performance: 'stands tall', staging: 'center frame', cinematography: 'wide push',
    dialogue: opts.line ? { speaker_id: 'S1', line: '你终于来了。', addressee_id: 'S2' } : null,
    micro_performance: 'breath steady',
  },
  continuity_handoff: { positions: 'center', emotion: 'composed', props: 'none', audio: 'city hum' },
  prompt: null,
  audit: null,
});

const BEATS = [
  { id: 'B01', purpose: 'establish', creative_intent: { state_before: 'calm', trigger: 'she enters', state_after: 'alert', audience_takeaway: 'danger' }, location_id: 'L1', character_ids: ['S1', 'S2'],
    shots: [mkShot('B01-S1', 'S1', { line: true }), mkShot('B01-S2', 'S2', { reaction: true })] },
  { id: 'B02', purpose: 'develop', creative_intent: { state_before: 'alert', trigger: 'he follows', state_after: 'suspense', audience_takeaway: 'pursuit' }, location_id: 'L1', character_ids: ['S1', 'S2'],
    shots: [mkShot('B02-S1', 'S2', { stage: 'ref2va' })] },
];

let writerCalls = 0;
const baseDeps = (outDir, overrides = {}) => ({
  scriptAnalystRunner: async () => JSON.stringify(SCRIPT_IR),
  beatDirectorRunner: async () => JSON.stringify({ beats: BEATS }),
  shotWriterRunner: async () => { writerCalls += 1; return JSON.stringify({ shots: [{ what: 'wide shot', who: null, duration: 5, camera: 'wide push in', action: '', micro: '', carry: '', ambient: 'city hum' }] }); },
  auditorRunner: async () => JSON.stringify({ verdict: 'pass', findings: [] }),
  repairerRunner: async () => { throw new Error('repairer 不应被触发'); },
  emit: (ir) => emitEngineering(outDir, ir),
  ...overrides,
});

// ── ① 两段式挂起：awaitUserApproval=true → awaiting_approval，S3 不跑 ──
const outDir = mkdtempSync(join(tmpdir(), 'h3-dist-integration-'));
writerCalls = 0;
const pending = await orchestrateDirecting({ script: SCRIPT_TEXT, project: 'dist-integration', awaitUserApproval: true, rating: 'safe' }, baseDeps(outDir));
check('① 挂起态 status=awaiting_approval', pending.status === 'awaiting_approval', `got ${pending.status}`);
check('① 挂起态 S3 未跑（writer 0 次）', writerCalls === 0, `got ${writerCalls}`);
check('① 挂起态即落盘 storyboard.json（spec §5 有意）', existsSync(join(outDir, 'storyboard.json')));

// ── ② 续跑（R12）：批准方案回灌，S1/S2 桩换成必抛异常证明被跳过 ──
writerCalls = 0;
const done = await orchestrateDirecting(
  { resumeStoryboard: pending.storyboard, project: 'dist-integration', rating: 'safe' },
  baseDeps(outDir, {
    scriptAnalystRunner: async () => { throw new Error('S1 不应重跑'); },
    beatDirectorRunner: async () => { throw new Error('S2 不应重跑'); },
  }),
);
check('② 续跑 status=completed', done.status === 'completed', `got ${done.status}`);
check('② 续跑只跑 S3-S5（writer=3，三镜）', writerCalls === 3, `got ${writerCalls}`);
check('② 全链无 critical gate', !(done.gates ?? []).some((g) => g.severity === 'critical'), JSON.stringify(done.gates ?? []));

const ir = done.storyboard;
const shots = ir.beats.flatMap((b) => b.shots);
const dlgShot = shots.find((s) => s.dialogue);

// ── ③ speaker ID 注入（R2）：对白镜 prompt 含「角色名 (S1)」官方格式 ──
const dlgText = dlgShot?.prompt?.text ?? '';
check('③ 对白镜 prompt 含 speaker 标记 (S1)', /\(S1\)/.test(dlgText), dlgText.slice(0, 120));

// ── ④ 版本台账（R11）：每镜 S3 产出登记 prompt_v1，status=ok ──
const ledger = ir.continuity_ledger ?? [];
check('④ 台账每镜 ≥1 条 shot_prompt_version', shots.every((s) => ledger.some((e) => e.beat_span === s.id && e.check === 'shot_prompt_version' && e.status === 'ok' && String(e.note).startsWith('prompt_v1'))), JSON.stringify(ledger).slice(0, 160));

// ── ⑤ 预算计数（R7）：token_count 为正数 ──
check('⑤ 每镜 token_count>0', shots.every((s) => (s.prompt?.token_count ?? 0) > 0), JSON.stringify(shots.map((s) => s.prompt?.token_count)));

// ── ⑥ 参考绑定（R3）：ref2va 镜（B02-S1）走引用形态，且全链无 G-refbinding critical ──
const refShot = shots.find((s) => s.id === 'B02-S1');
const refText = refShot?.prompt?.text ?? '';
check('⑥ ref2va 镜 prompt 为引用形态且无绑定 critical', (refText.includes('reference generation') || refText.includes('slim')) && !(done.gates ?? []).some((g) => String(g.rule ?? g.code ?? '').includes('refbinding')), refText.slice(0, 160));

// ── ⑦ 三件套落盘（R15）：storyboard.json + prompts/*.txt + continuity-ledger.json ──
const promptsDir = join(outDir, 'prompts');
check('⑦ storyboard.json 可解析（2 Beats）', JSON.parse(readFileSync(join(outDir, 'storyboard.json'), 'utf8')).beats.length === 2);
check('⑦ prompts/ 目录存在且有 .txt', existsSync(promptsDir) && readdirSync(promptsDir).filter((f) => f.endsWith('.txt')).length >= 1);
check('⑦ continuity-ledger.json 存在', existsSync(join(outDir, 'continuity-ledger.json')));

// ── ⑧ 增量重跑（R13）：一镜 prompt 置 null → 只重跑该镜，健康镜文本原样保留 ──
writerCalls = 0;
const kept = shots.find((s) => s.id === 'B01-S1').prompt.text;
const partial = JSON.parse(JSON.stringify(ir));
partial.beats[1].shots[0].prompt = null; // B02-S1（ref2va 镜）置空 → 只重跑它
const resumed = await orchestrateDirecting({ resumeStoryboard: partial, project: 'dist-integration', rating: 'safe' }, baseDeps(outDir));
check('⑧ 增量只重写违规/空镜（writer=1）', writerCalls === 1, `got ${writerCalls}`);
check('⑧ 健康镜 prompt 原样保留', resumed.storyboard.beats[0].shots[0].prompt.text === kept);

console.log(failures.length === 0 ? `\nALL 8 CHECKS PASSED → ${outDir}` : `\n${failures.length} CHECK(S) FAILED: ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
