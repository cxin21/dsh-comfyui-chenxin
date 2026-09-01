// ANIMA3 提示词生成 — 1:1 移植自 PM anima3PromptEngineering.js

// tag 行清洗统一走共享模块 tagLineSanitize.ts（1:1 移植自 PM tagLineSanitize.js），
// 避免与 router.ts 重复维护两份 cleanTagLineBody 实现。
import { cleanTagLineBody } from './tagLineSanitize.js';
// A1：字数档解析统一走 CaptionLen（PM anima3PromptEngineering.js:15 直接委托
// CaptionLen.resolveAnima3TagCountBand——内联版丢失 custom 分支，此处改为委托 length.ts 的 1:1 移植）
import { resolveAnima3TagCountBand } from './length.js';

// ANIMA3 主逻辑

function isZh(caption: any): boolean {
  return (caption.caption_lang || 'en') === 'zh';
}

function resolveTagCountBand(caption: any): { band: string; tier: string } {
  return resolveAnima3TagCountBand(caption);
}

const PRIORITY_ZH =
  '【最高优先级·ANIMA3 v3.0】以下规则优先于 ComfyUI 还原检查表、中文逗号标签、叙事描写等一切其它打标约定；冲突时严格执行 ANIMA3。';
const PRIORITY_EN =
  '[TOP PRIORITY · ANIMA3 v3.0] These rules OVERRIDE ComfyUI fidelity checklists, Chinese comma tags, and any other caption conventions.';

const NO_META_ZH =
  '【严禁输出】自检/分析/小标题/Markdown（含 ** 标题）、self-check、fidelity analysis；内心完成检查，回复有且仅能是一行 tag。';
const NO_META_EN =
  '[FORBIDDEN OUTPUT] No self-check, fidelity analysis, headings, markdown—internal checks only; reply MUST be ONE tag line.';

function buildRoleBlock(zh: boolean): string {
  if (zh) {
    return (
      ' 【§1 ROLE】你是 Anima3 提示词工程师。唯一职责：把所见画面转写为一条英文 prompt（仅 content 部分）。' +
      ' 必须：按 §4 槽位顺序填 tag；按 §2 格式输出；内心完成 §3 自检与 §3.1 互斥检查。' +
      ' 禁止：解释、寒暄、Markdown、质量词、画师名、权重语法、光线/光影/色调类 tag（脚本与 LoRA 已处理）。'
    );
  }
  return (
    ' [§1 ROLE] You are an Anima3 prompt engineer. Sole job: ONE English content prompt from the image.' +
    ' MUST: §4 slot order; §2 output protocol; §3/§3.1 internal self-check & conflicts.' +
    ' FORBIDDEN: prose, markdown, quality tags, @artist, weights, lighting/color-grade tags (handled elsewhere).'
  );
}

function buildOutputProtocolBlock(zh: boolean): string {
  if (zh) {
    return (
      ' 【§2 OUTPUT PROTOCOL】仅 1 行、无换行；标签间 ", "（逗号+空格）；全部 lowercase（score_ 保留下划线）；' +
      ' 禁止用方括号包裹 tag（错误示例：[girl]、[black hood]；正确：1girl, black_hood）；' +
      ' 禁止 masterpiece/best quality/score_*、@artist、(tag:1.2) 权重；' +
      ' 禁止 sunlight/moonlight/rim light/warm lighting/god rays/backlighting 等光线光影色调（允许 rain/snow/fog/steam/night 等天气）；' +
      ' 纯文本一行，无 code fence；tag 说不清时用英文短句补充，且必须放在所有 tag 之后。'
    );
  }
  return (
    ' [§2 OUTPUT PROTOCOL] Exactly 1 line; ", " separators; all lowercase; NO square brackets around tags (use 1girl, black_hood—not [girl]); no quality/artist/weights;' +
    ' no lighting/color-grade tags (weather like rain/snow/fog OK); NL supplement only AFTER all tags.'
  );
}

function buildSelfCheckBlock(zh: boolean): string {
  if (zh) {
    return (
      ' 【§3 内心自检·勿写出】①人数与 count 一致 ②无 §3.1 互斥 ③无重复 tag ④场景与动作物理合理 ⑤无光线禁令 tag ⑥总量在 §4.2 范围。'
    );
  }
  return (
    ' [§3 INTERNAL SELF-CHECK] count match; no §3.1 conflicts; no duplicates; scene-action OK; no banned lighting; tag count in §4.2 range.'
  );
}

function buildConflictBlock(zh: boolean): string {
  if (zh) {
    return (
      ' 【§3.1 互斥速查】视角：from front↔from behind、looking at viewer↔facing away、pov↔full body、close-up↔full body；' +
      ' 身份：solo↔hetero/1boy、sleeping↔looking at viewer、blindfold↔rolling eyes；' +
      ' 服装：completely nude↔具体服装、pantyhose↔barefoot（torn pantyhose 除外）、blindfold↔glasses；' +
      ' 动作：missionary↔doggystyle、spread legs↔legs together；同部位细节 tag ≤2 且不矛盾（禁 spread toes+toe scrunch）。'
    );
  }
  return (
    ' [§3.1 CONFLICTS] No front+behind; solo+hetero; nude+clothing; pantyhose+barefoot; missionary+doggystyle; spread legs+legs together; ≤2 detail tags/body part, no contradictions.'
  );
}

function buildSlotOrderBlock(zh: boolean, band: string, tier: string): string {
  const order =
    'count/gender → character/series → appearance → clothing/state → pose/action/sex → expression/reaction → camera/shot → scene/environment → detail/mood → NL tail';
  if (zh) {
    return (
      ` 【§4 SLOT ORDER】严格顺序：${order}。靠前槽位权重更高。` +
      ` 【§4.2 总量】约 ${band} 个 tag（${tier}：简单16-30/标准22-38/复杂30-48）；服装槽可略多，其余精简，禁止重复 tag。` +
      ' 【§4.1 风格一致】服装/场景/detail 同一世界观（禁 hanfu+cyberpunk 混搭）。' +
      ' 【§4.3 视线】单人默认 direct eye contact, facing viewer（除非背影/侧脸）；多人用 looking at another，勿强行全员看镜头。' +
      ' 【§4.4 自然语言】仅 tag 无法表达多人归属/复杂构图/特殊姿势/分镜时，英文短句放 prompt 末尾。' +
      ' 【§4.6 多人】每角色须有发色+瞳色+关键特征短语，再写共享 pose/scene；关系放末尾 NL。'
    );
  }
  return (
    ` [§4 SLOT ORDER] ${order}; front slots weigh more.` +
    ` [§4.2 COUNT] ~${band} tags (${tier}).` +
    ' [§4.1] Consistent worldview across clothing/scene/mood.' +
    ' [§4.3] SOLO: direct eye contact, facing viewer unless back/profile.' +
    ' [§4.4] NL phrase at END only when tags insufficient.' +
    ' [§4.6] Multi-subject: per-character appearance before shared tags.'
  );
}

function buildAssemblyTreeBlock(zh: boolean): string {
  if (zh) {
    return (
      ' 【§5 决策树·先匹配再填槽】5.1单人展示 5.2双人前戏 5.3双人正戏 5.4特殊体位(睡奸/催眠/femdom/过激) 5.5多人 5.6百合 5.7特殊主题(先查§14配方再填)；' +
      ' 按匹配类型侧重各槽位（appearance/clothing/pose/expression/camera/scene/detail），勿堆无关 tag。'
    );
  }
  return (
    ' [§5 ASSEMBLY] Match 5.1 solo / 5.2 foreplay / 5.3 sex / 5.4 special pose / 5.5 group / 5.6 yuri / 5.7 special theme—fill slots accordingly.'
  );
}

function buildDanbooruPrefixBlock(zh: boolean): string {
  if (zh) {
    return (
      ' 【Danbooru·置于 count 之前】artist:, copyright:, character:, meta:（不确定 artist:unknown、copyright:original；无角色 character:none）；' +
      ' IP 角色须 ≥5 外观锚点；禁止编造未知角色特征。'
    );
  }
  return (
    ' [Danbooru PREFIX before count] artist:/copyright:/character:/meta:; unknown/original/none; ≥5 appearance anchors for IP; no invented traits.'
  );
}

export function buildPrimarySystemPrompt(caption: any, media_target: string, opts: { danbooru?: boolean } = {}): string {
  const zh = isZh(caption);
  const video = (media_target || caption.media_target || 'image') === 'video';
  const { band, tier } = resolveTagCountBand(caption);
  const media = video ? (zh ? '视频关键帧' : 'video') : zh ? '图像' : 'image';

  let out = zh ? ` ${PRIORITY_ZH}` : ` ${PRIORITY_EN}`;
  out += zh ? ` ${NO_META_ZH}` : ` ${NO_META_EN}`;
  out += buildRoleBlock(zh);
  out += buildOutputProtocolBlock(zh);
  out += buildSelfCheckBlock(zh);
  out += buildConflictBlock(zh);
  out += buildSlotOrderBlock(zh, band, tier);
  out += buildAssemblyTreeBlock(zh);
  if (opts.danbooru) out += buildDanbooruPrefixBlock(zh);
  if (video) {
    out += zh
      ? ' 【视频】pose/action 与 camera/shot 须写动作、运镜、运动模糊（motion lines 与 motion blur 二选一）。'
      : ' [VIDEO] Include motion, camera move, one of motion lines/motion blur.';
  }
  out += zh
    ? ` 观察${media}可见事实填槽，输出一条英文 prompt（约 ${band} tags）。`
    : ` Observe this ${media}; output one English prompt (~${band} tags).`;
  return out;
}

export function buildSystemAddons(caption: any, media_target: string): string {
  const zh = isZh(caption);
  return zh
    ? ' 【执行】仅按 ANIMA3 组装，勿改用 ComfyUI 中文关键词或分段分析。'
    : ' [EXECUTE] ANIMA3 only—do not revert to ComfyUI checklist prose or Chinese comma tags.';
}

export function buildUserTaskLead(caption: any, media_target: string): string {
  const zh = isZh(caption);
  const video = (media_target || caption.media_target || 'image') === 'video';
  const { band } = resolveTagCountBand(caption);
  if (zh) {
    return video
      ? `【ANIMA3 任务】按 §5 决策树与 §4 槽位顺序分析视频画面，直接输出约 ${band} 个英文 tag 的一行 prompt，勿写分析过程。 `
      : `【ANIMA3 任务】按 §5 决策树与 §4 槽位顺序分析图像，直接输出约 ${band} 个英文 tag 的一行 prompt，勿写分析过程。 `;
  }
  return video
    ? `[ANIMA3 TASK] Match §5 scene type, fill §4 slots from video, output one English line (~${band} tags). `
    : `[ANIMA3 TASK] Match §5 scene type, fill §4 slots from image, output one English line (~${band} tags). `;
}

export function buildOutputConstraints(caption: any): string {
  const { band } = resolveTagCountBand(caption);
  const zh = isZh(caption);
  if (zh) {
    return ` 【ANIMA3 最终契约】有且仅一行英文 lowercase tag（约 ${band} 个），", " 分隔，严格 §4 槽位顺序；${NO_META_ZH}`;
  }
  return ` [ANIMA3 FINAL] One lowercase English line (~${band} tags), ", " separated, §4 slot order. ${NO_META_EN}`;
}

export function buildUserTaskBody(caption: any, opts: { danbooru?: boolean } = {}): string {
  const zh = isZh(caption);
  const { band } = resolveTagCountBand(caption);
  const danbooru = opts.danbooru === true;
  if (zh) {
    let s = `工作流：§5 匹配场景→§4 按槽位从画面提取→§3/§3.1 内心自检→输出一行英文 tag（约 ${band} 个）。`;
    if (danbooru) s += ' 先 Danbooru 前缀再 count/gender。';
    return s;
  }
  let s = `Workflow: §5 pick scene→§4 fill slots→§3 internal check→one English line (~${band} tags).`;
  if (danbooru) s += ' Danbooru prefixes first.';
  return s;
}

export function buildUserTailAddon(): string {
  return ' 现在只输出最终一行 tag，不要任何其它文字。';
}

function countSeparators(s: string): number {
  return (String(s || '').match(/[,，]/g) || []).length;
}

function isMetaCaptionLine(line: string): boolean {
  const l = String(line || '').trim();
  if (!l) return true;
  if (/^#{1,6}\s/.test(l)) return true;
  if (/^\*\*[^*]+\*\*$/i.test(l)) return true;
  if (
    /self[- ]?check|fidelity\s*analysis|checklist|quality\s*assurance|还原检查|自检|分析过程|thought\s*process|§\d/i.test(l)
  ) return true;
  const seps = countSeparators(l);
  if (seps === 0 && !/^(artist|copyright|character|meta|score_|1girl|1boy|2girl|\d+girls?)/i.test(l)) return true;
  return false;
}

function isMetaTagFragment(frag: string): boolean {
  const t = String(frag || '').trim();
  if (!t) return true;
  if (/^\*\*[^*]+\*\*$/i.test(t)) return true;
  if (/^(?:self[- ]?check|fidelity\s*analysis|checklist|还原检查|自检|§\d)/i.test(t)) return true;
  return false;
}

function normalizeTagFragment(frag: string): string {
  const t = String(frag || '').trim().replace(/^\*\*|\*\*$/g, '');
  if (!t || isMetaTagFragment(t)) return '';
  if (/^(artist|copyright|character|meta|score_):/i.test(t)) {
    const idx = t.indexOf(':');
    return t.slice(0, idx + 1).toLowerCase() + t.slice(idx + 1).trim().toLowerCase();
  }
  return t.toLowerCase();
}

export function sanitizeTagLine(text: string): string {
  let s = String(text || '').trim();
  if (!s) return s;

  const lines = s
    .split(/\r?\n/)
    .map((l) => l.replace(/^\*\*|\*\*$/g, '').trim())
    .filter((l) => l && !isMetaCaptionLine(l));

  let best = lines[0] || '';
  let bestSeps = countSeparators(best);
  for (let i = 1; i < lines.length; i++) {
    const c = countSeparators(lines[i]);
    if (c > bestSeps) { bestSeps = c; best = lines[i]; }
  }

  if (!best || isMetaCaptionLine(best)) {
    const inline = s.replace(/\r?\n/g, ' ').replace(/\*\*/g, '').trim();
    if (countSeparators(inline) >= 1) best = inline;
    else if (!isMetaCaptionLine(inline) && inline.length > 0) best = inline;
    else return '';
  }

  best = best.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  const cleaned = cleanTagLineBody(best);
  if (!cleaned) return '';

  const parts = cleaned.split(/[,，]\s*/).map(normalizeTagFragment).filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  return normalizeTagFragment(cleaned);
}