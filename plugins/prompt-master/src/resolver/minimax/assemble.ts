// MiniMax H3 场景组装 — 1:1 移植自 PM minimaxScenarios/assemble.js（3.1.0 保真版）
// 覆盖审计项 X1-X5：五块 user 结构 / media tag lock 文案 / 输出格式四分支 /
// hardConstraints zh 改写 / maxTokens mediaExpandMin 下限 + userExtraPrompt 块

import { resolveExpandMaxTokens } from '../profiles/expand-rules.js';
import { getScenarioByPeId, getScenarioById, type MiniMaxScenario } from './catalog.js';
import { H3_REFERENCE_EN, H3_REFERENCE_ZH, H3_REFERENCE_JA } from './templates/index.js';

/** 与 PM DEFAULT_LOCAL_TOKEN_LIMITS.mediaExpandMin 对齐（media 扩写下限） */
export const DEFAULT_MEDIA_EXPAND_MIN = 4096;

// 模板加载（中英两套 Full-Reference 指南）
const _cachedFullRefGuides: Record<string, string> = {};

function loadFullReferenceGuide(lang: string): string {
  const key = String(lang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  if (_cachedFullRefGuides[key]) return _cachedFullRefGuides[key];
  const guideMap: Record<string, string> = {
    en: H3_REFERENCE_EN,
    zh: H3_REFERENCE_ZH,
    ja: H3_REFERENCE_JA,
  };
  const text = guideMap[key] || guideMap.zh;
  _cachedFullRefGuides[key] = text;
  return _cachedFullRefGuides[key];
}

// === 媒体枚举 — 移植 PM utils/expandMedia.js enumerateTaggedMedia ===
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg']);

export function classifyMediaPath(filePath: string): 'image' | 'video' | 'audio' | 'file' {
  const s = String(filePath || '');
  const m = s.match(/\.([A-Za-z0-9]+)$/);
  const ext = m ? '.' + m[1].toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

export interface TaggedMediaItem {
  path: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  n: number;
  tag: string;
  base: string;
}

export function enumerateTaggedMedia(mediaPaths: string[] | undefined | null): TaggedMediaItem[] {
  const list = Array.isArray(mediaPaths) ? mediaPaths : [];
  const counts: Record<string, number> = { image: 0, video: 0, audio: 0, file: 0 };
  const items: TaggedMediaItem[] = [];
  for (const raw of list) {
    const p = String(raw || '').trim();
    if (!p) continue;
    const kind = classifyMediaPath(p);
    counts[kind] += 1;
    const n = counts[kind];
    let tag = `<File ${n}>`;
    if (kind === 'image') tag = `<Picture ${n}>`;
    else if (kind === 'video') tag = `<Video ${n}>`;
    else if (kind === 'audio') tag = `<Audio ${n}>`;
    items.push({ path: p, kind, n, tag, base: p.split(/[/\\]/).pop() || p });
  }
  return items;
}

function formatMediaList(mediaPaths: string[] | undefined): string[] {
  return enumerateTaggedMedia(mediaPaths).map(
    (item) => `- ${item.tag} ${item.base}（路径：${item.path}）`
  );
}

// ShowIf 条件匹配
function matchShowIf(cond: any, form: Record<string, any>): boolean {
  if (!cond) return true;
  if (Array.isArray(cond.all) && cond.all.length) {
    return cond.all.every((c: any) => matchShowIf(c, form));
  }
  if (Array.isArray(cond.any) && cond.any.length) {
    return cond.any.some((c: any) => matchShowIf(c, form));
  }
  const cur = form[cond.key];
  if (Object.prototype.hasOwnProperty.call(cond, 'equals')) {
    return String(cur) === String(cond.equals);
  }
  if (Object.prototype.hasOwnProperty.call(cond, 'notEquals')) {
    return String(cur) !== String(cond.notEquals);
  }
  if (Object.prototype.hasOwnProperty.call(cond, 'gte')) {
    const n = Number(cur);
    const t = Number(cond.gte);
    return Number.isFinite(n) && Number.isFinite(t) && n >= t;
  }
  if (Object.prototype.hasOwnProperty.call(cond, 'lte')) {
    const n = Number(cur);
    const t = Number(cond.lte);
    return Number.isFinite(n) && Number.isFinite(t) && n <= t;
  }
  return true;
}

export function fieldVisible(field: any, form: Record<string, any>): boolean {
  if (!field || !field.showIf) return true;
  return matchShowIf(field.showIf, form);
}

function isDirectorCustomPlan(form: Record<string, any>): boolean {
  return String((form && form.plan_mode) || 'ai') === 'custom';
}

// 表单标准化
export function normalizeForm(scenario: MiniMaxScenario, rawForm: Record<string, any>): Record<string, any> {
  const form = { ...(rawForm || {}) };
  for (const f of scenario.formFields || []) {
    if (form[f.key] == null || form[f.key] === '') {
      if (f.default != null && f.default !== '') form[f.key] = f.default;
    }
  }
  return form;
}

// Form → 行
function formToLines(scenario: MiniMaxScenario, form: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const f of scenario.formFields || []) {
    if (!fieldVisible(f, form)) continue;
    const v = form[f.key];
    if (v == null || String(v).trim() === '') continue;
    let display = String(v);
    if (Array.isArray(f.options)) {
      const opt = f.options.find((o: any) => String(o.value) === String(v));
      if (opt && opt.label) display = `${opt.label} (${opt.value})`;
    }
    lines.push(`- ${f.label}: ${display}`);
  }
  return lines;
}

// 素材标签锁（X2：完整文案 + 扩展名分类）
function buildMediaTagLock(mediaPaths: string[] | undefined, lang: string, outputMode: string, form: Record<string, any>): string[] {
  const items = enumerateTaggedMedia(mediaPaths);
  const lines: string[] = [];
  const r2vLock =
    outputMode === 'full_reference' ||
    (outputMode === 'director_segments' && String((form && form.prompt_kind) || '') === 'r2v');

  if (!items.length) {
    if (outputMode === 'director_segments') {
      if (lang === 'zh') {
        lines.push('## 参考素材（当前：无附件）');
        lines.push('用户未附带图片/视频/音频。公共「主体定义」可用 <Subject N> 文字锁身份，严禁编造 <Picture N>/<Video N>/<Audio N>。');
      } else {
        lines.push('## Reference media (none attached)');
        lines.push('No media attached. Public subject_definitions may use <Subject N> in prose. Do NOT invent <Picture N>, <Video N>, or <Audio N>.');
      }
      lines.push('');
      return lines;
    }
    if (lang === 'zh') {
      lines.push('## 参考素材（当前：无附件）');
      lines.push('用户未附带任何图片/视频/音频。严禁编造或输出 <Picture N>、<Subject N>、<Video N>、<Audio N> 等参考标签。直接用自然语言描述主体即可。');
    } else {
      lines.push('## Reference media (none attached)');
      lines.push('No media attached. Do NOT invent <Picture N>, <Subject N>, <Video N>, or <Audio N> tags. Describe subjects in plain language only.');
    }
    lines.push('');
    return lines;
  }

  const tags = items.map((x) => x.tag);
  if (lang === 'zh') {
    lines.push('## 参考素材标记（最高优先级，有素材时强制）');
    lines.push(`用户已附带 ${items.length} 个参考素材：${tags.join('、')}。输出中必须使用这些尖括号标签，禁止写成 Picture 1 / picture1 / 图1 等变体。`);
    if (r2vLock) {
      lines.push('在「主体定义」中必须逐条定义每个素材标签，并建立主体映射，例如：');
      lines.push('<Picture 1> 是……（说明该图角色/用途）');
      lines.push('<Subject 1> 是 <Picture 1> 中的……（外观特征）');
      lines.push('在「保留分析」「详细描述」中引用同一套 <Picture N>/<Subject N>；禁止只在文字里描述角色却不出现标签。');
    } else {
      lines.push('在正文中按需引用上述标签锚定外观；不要额外虚构未提供的 <Picture N>。');
    }
  } else {
    lines.push('## Reference media tags (ABSOLUTE when media attached)');
    lines.push(`User attached ${items.length} media asset(s): ${tags.join(', ')}. Use these exact angle-bracket tags; never write Picture 1 / picture1 without brackets.`);
    if (r2vLock) {
      lines.push('In subject_definitions, define every media tag and map subjects, e.g. <Picture 1> / <Subject 1>.');
      lines.push('Reuse the same tags in retention_analysis and detailed_description.');
    } else {
      lines.push('Reference these tags in the prompt body to ground appearance; do not invent extra <Picture N> not provided.');
    }
  }
  lines.push('');
  return lines;
}

// 主体组装 system prompt（X3：输出格式四分支 + X4：hardConstraints zh 改写）
export function buildSystem(scenario: MiniMaxScenario, form: Record<string, any>, outputLang: string, mediaPaths: string[] | undefined): string {
  const lang = String(outputLang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  const parts: string[] = [];

  if (lang === 'zh') {
    parts.push('你是 PromptMaster 的 MiniMax-H3 场景提示词工程师。');
    parts.push(`场景：${scenario.name}（${scenario.id}）`);
    parts.push(`Skill 来源：${scenario.skillSource || scenario.id}`);
  } else {
    parts.push('You are PromptMaster\'s MiniMax-H3 scenario prompt engineer.');
    parts.push(`Scenario: ${scenario.name} (${scenario.id})`);
    parts.push(`Skill source: ${scenario.skillSource || scenario.id}`);
  }
  parts.push('');
  parts.push(...buildMediaTagLock(mediaPaths, lang, scenario.outputMode, form));

  // 输出语言
  parts.push(lang === 'zh' ? '## 输出语言（最高优先级）' : '## Output language (highest priority)');
  if (scenario.outputMode === 'full_reference') {
    if (lang === 'zh') {
      parts.push('用户选择【中文】。六段标题与正文都必须用简体中文。');
      parts.push('六段中文标题（强制）：主体定义: / 摘要: / 保留分析: / 详细描述: / 整体声景: / 非叙事配乐: —— 禁止输出 subject_definitions:、summary: 等英文章节标题。');
      parts.push('仅在有参考素材时才使用 <Picture N>/<Subject N>；关系标记 fully_preserved、镜头 [Shot N]、任务前缀 [reference generation] 保持英文。禁止整段英文叙述。');
      parts.push('画面广告文案：约 4–12 字、单行、Apple 风（除非用户已提供英文文案）。');
    } else {
      parts.push('User selected 【English】. Write all six section bodies, shot descriptions, sound, and on-screen advertising copy in English.');
      parts.push('In-frame advertising copy: 3–5 English words, single line, Apple-style tone.');
    }
  } else if (scenario.outputMode === 'director_segments') {
    if (lang === 'zh') {
      parts.push('用户选择【中文】。章节标题必须用中文六段式：主体定义 / 摘要 / 保留分析 / 详细描述 / 整体声景 / 非叙事配乐。');
      parts.push('禁止输出 subject_definitions:、summary: 等英文章节标题。正文简体中文。');
      parts.push('参考标签 <Subject N>/<Picture N>、关系标记 fully_preserved、镜头 [Shot N] 保持英文。');
    } else {
      parts.push('User selected 【English】. Use English Full-Reference keys. Write all section bodies in English.');
    }
  } else if (lang === 'zh') {
    parts.push('用户选择【中文】。正文必须用简体中文。禁止整段英文叙述。');
    parts.push('本场景不是 Full-Reference 六段式：不要输出「主体定义/摘要/保留分析/详细描述/整体声景/非叙事配乐」章节标题。');
    if (mediaPaths && mediaPaths.length) {
      parts.push('用户已提供参考素材：正文必须用 <Picture N>/<Subject N> 锚定外观，并写完整分镜、动作、运镜与声景的**自然语言段落**（可用 [Shot N] 标记镜头）；禁止只列标签名、禁止 XML/空壳结构而无正文。');
    } else {
      parts.push('无参考素材时不要编造 <Picture N>/<Subject N>。');
    }
  } else {
    parts.push('User selected 【English】. Write the prompt body in English.');
    parts.push('This scenario is NOT Full-Reference six-section format. Do not use subject_definitions:/summary: section headers.');
    if (mediaPaths && mediaPaths.length) {
      parts.push('Reference media attached: anchor with <Picture N>/<Subject N> and write full shot/action/camera/audio as **prose paragraphs** ([Shot N] allowed). No tag-only lists, no XML shells without body text.');
    } else {
      parts.push('Do not invent <Picture N>/<Subject N> when no media is attached.');
    }
  }
  parts.push('');

  // 输出格式（四分支）
  if (scenario.outputMode === 'full_reference') {
    if (lang === 'zh') {
      parts.push('## 输出格式（最高优先级）');
      parts.push('仅输出 MiniMax-H3 Full-Reference 标准六段（中文标题）：主体定义 → 摘要 → 保留分析 → 详细描述 → 整体声景 → 非叙事配乐。');
      parts.push('绝对纯净输出：以「主体定义:」开头，以「非叙事配乐:」内容结束。不要 Markdown 代码围栏，不要寒暄。');
      parts.push('章节标题用中文；参考标签/关系标记/镜头标记保持英文；正文以中文指南为准。');
      if (form.expand_mode === 'expand') {
        parts.push('用户允许扩写：可补充必要的视觉/听觉/时间细节，使提示词可直接生成。');
      } else {
        parts.push('默认严格改写：不要编造用户未给出或未强烈暗示的情节/动作/角色。');
      }
      parts.push('');
      parts.push('## Full-Reference 中文指南（请严格遵循）');
      parts.push(loadFullReferenceGuide('zh'));
    } else {
      parts.push('## Output format (HIGHEST PRIORITY)');
      parts.push('Produce MiniMax-H3 Full-Reference Mode standardized 6 sections ONLY: subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music.');
      parts.push('Absolute pure output: start with subject_definitions: end with non_diegetic_music:. No markdown fences, no greetings.');
      parts.push('Keep English keys/labels/tags as in the guide. Section bodies in English.');
      if (form.expand_mode === 'expand') {
        parts.push('User allowed expansion: you may add necessary visual/audio/temporal details to make a playable prompt.');
      } else {
        parts.push('Strict rewrite by default: do NOT invent plot/actions/characters not stated or strongly implied.');
      }
      parts.push('');
      parts.push('## Full-Reference Guide (English edition — follow strictly)');
      parts.push(loadFullReferenceGuide('en'));
    }
  } else if (scenario.outputMode === 'director_segments') {
    const n = Math.max(2, parseInt(String(form.segment_count || '4'), 10) || 4);
    const kind = String(form.prompt_kind || 't2v') === 'r2v' ? 'r2v' : 't2v';
    const customPlan = isDirectorCustomPlan(form);
    const sec = String(form.segment_seconds || '5');
    if (lang === 'zh') {
      parts.push('## 输出格式（最高优先级）');
      parts.push(`严格按「公共设定 + ${n} 组六段式（去主体定义）」输出，不要 Markdown，不要寒暄。`);
      if (customPlan) {
        parts.push('分段方式=自定义：每段剧情严格按用户填写的「第 N 段在干什么」；不要擅自改情节主线。');
      } else {
        parts.push(
          '分段方式=AI智能分段：用户只给了总段数和「创作需求」。你必须自行把创作需求拆成恰好 ' +
            `${n} 段连续剧情（起承转合，段间无硬切），并为每段选定合适时长（5 / 10 / 15 秒，导演台常用）。`
        );
        parts.push('在每组「摘要:」里写明本段约几秒。补全运镜、动作、对白、声画。禁止向用户追问各段内容，禁止输出空壳或「待补充」。');
      }
      parts.push('### 第一部分：公共设定（只出现一次，可贴导演台「公共参数」）');
      parts.push('分隔行：===== 公共设定 =====');
      parts.push('本块只写「主体定义:」，不要摘要/分镜/声景。');
      if (kind === 'r2v' || (mediaPaths && mediaPaths.length)) {
        parts.push('有参考图时逐条：<Subject N> 来自 <Picture N> 的……身份与穿着完全锁定参考图：…… 可同时定义 <Picture N> 用途。');
      } else {
        parts.push('无参考图时用自然语言定义 <Subject N> 的身份与穿着，禁止编造 <Picture N>。');
      }
      parts.push(
        customPlan
          ? `### 第二部分：${n} 段提示词（每段约 ${sec} 秒，可贴导演台各「提示词组」）`
          : `### 第二部分：${n} 段提示词（每段时长由你定，5/10/15 秒，可贴导演台各「提示词组」）`
      );
      parts.push('每组分隔行：===== 提示词组 k =====');
      parts.push('每组必须按 MiniMax 六段式输出，但禁止再写「主体定义:」。固定顺序：摘要: → 保留分析: → 详细描述: → 整体声景: → 非叙事配乐:');
      parts.push('各段只引用公共设定里已有的 <Subject N>，不要重复外貌/服装圣经。保留分析只写本段出场主体及 fully_preserved 等关系。');
      parts.push('第 2 组起，「详细描述:」第一句必须是「无硬切。紧接上一段。」本段时间码从 00:00 起算。段末写「段末停在…」。详细描述最后一行：不要乱说话');
      parts.push('配乐主题跨组连续；除最后一组外段末不要淡出。');
      parts.push('');
      parts.push('## Full-Reference 中文指南（章节写法请遵循；主体定义只允许出现在第一部分）');
      parts.push(loadFullReferenceGuide('zh'));
    } else {
      parts.push('## Output format (HIGHEST PRIORITY)');
      parts.push(`Output public settings once, then exactly ${n} Full-Reference groups without repeating subject_definitions.`);
      if (customPlan) {
        parts.push('Plan mode=custom: follow each user-provided segment beat and duration.');
      } else {
        parts.push(`Plan mode=AI: user only gave segment count ${n} and the creative brief. Split it into exactly ${n} continuous beats yourself; pick 5/10/15s per group; write the duration in each summary. Do not ask for per-segment notes.`);
      }
      parts.push('Part 1: ===== 公共设定 ===== containing ONLY subject_definitions:');
      parts.push('If media attached: <Subject N> is from <Picture N>, identity and wardrobe fully locked to the reference.');
      parts.push(
        customPlan
          ? `Part 2: ===== 提示词组 k ===== × ${n} (~${sec}s each)`
          : `Part 2: ===== 提示词组 k ===== × ${n} (you pick 5/10/15s each)`
      );
      parts.push('Each group: summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music. NEVER repeat subject_definitions in a group.');
      parts.push('Group 2+ detailed_description starts with "No hard cut. Immediately following the previous section." End with a freeze-frame handoff and the line 不要乱说话.');
      parts.push('');
      parts.push('## Full-Reference Guide (English edition — subject_definitions only in Part 1)');
      parts.push(loadFullReferenceGuide('en'));
    }
  } else if (scenario.outputMode === 'timeline_template') {
    if (lang === 'zh') {
      parts.push('## 输出格式（最高优先级）');
      parts.push('输出一份可直接生成的完整 MiniMax-H3 时间轴/事件框架视频提示词。不要 Markdown 代码围栏，不要闲聊。');
      parts.push('正文用简体中文（若场景要求 CONTINUE 等固定英文 UI 词可保留）。');
    } else {
      parts.push('## Output format (HIGHEST PRIORITY)');
      parts.push('Output ONE complete MiniMax-H3 timeline / event-framework video prompt ready to generate. No markdown fences, no chat.');
      parts.push('Prompt body language: English.');
    }
  } else {
    if (lang === 'zh') {
      parts.push('## 输出格式（最高优先级）');
      parts.push('输出一份完整、可直接使用的场景化 MiniMax-H3 视频提示词。不要 Markdown 代码围栏，不要闲聊，不要过程叙述。');
      parts.push('严格按本场景硬约束与 Assembly hints 的段落顺序输出；不要套用 Full-Reference 六段标题。');
    } else {
      parts.push('## Output format (HIGHEST PRIORITY)');
      parts.push('Output ONE complete scenario-structured MiniMax-H3 video prompt ready to use. No markdown fences, no chat, no process narration.');
      parts.push('Follow this scenario hard constraints and assembly hints section order; do NOT wrap into Full-Reference six sections.');
    }
  }

  parts.push('');
  parts.push('## Scenario hard constraints');
  for (const c of scenario.hardConstraints || []) {
    // 产品广告里写死 English copy 时，按输出语言改写该条（X4）
    if (lang === 'zh' && /In-frame copy:\s*English/i.test(c)) {
      parts.push('- In-frame copy: concise Simplified Chinese (约 4–12 字), single line only; never two rows or bottom subtitles.');
      continue;
    }
    parts.push(`- ${c}`);
  }

  if (scenario.assembleHints) {
    parts.push('');
    parts.push('## Assembly hints');
    parts.push(scenario.assembleHints);
  }

  return parts.join('\n');
}

// 主体组装 user prompt（X1：五块结构）
function buildUser(scenario: MiniMaxScenario, form: Record<string, any>, shortText: string, mediaPaths: string[] | undefined, outputLang: string): string {
  const lang = String(outputLang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  const userParts: string[] = [];
  userParts.push('【场景】' + scenario.name);
  userParts.push('【输出语言】' + (lang === 'en' ? '英文' : '中文') + ' — 这是强制要求，不是偏好；正文语言必须与此一致。');
  if (scenario.outputMode === 'full_reference') {
    userParts.push(
      lang === 'zh'
        ? '【强制】六段标题用中文（主体定义/摘要/保留分析/详细描述/整体声景/非叙事配乐），正文与画面文案用简体中文；禁止英文章节标题。无附图时禁止编造 <Picture N>。'
        : '【强制】Write detailed_description / summary / retention_analysis / sound sections and on-screen copy in English. Do not invent <Picture N> when no media is attached.'
    );
  } else if (scenario.outputMode === 'director_segments') {
    const n = Math.max(2, parseInt(String(form.segment_count || '4'), 10) || 4);
    const kind = String(form.prompt_kind || 't2v') === 'r2v' ? 'r2v' : 't2v';
    const customPlan = isDirectorCustomPlan(form);
    userParts.push(
      lang === 'zh'
        ? `【强制】先输出 ===== 公共设定 =====（仅「主体定义:」），再输出 ${n} 组 ===== 提示词组 k =====。每组按六段式但禁止再写主体定义，只写摘要/保留分析/详细描述/整体声景/非叙事配乐。方式=${kind === 'r2v' ? '参考图锁角色' : '文生锁角色'}。分段=${customPlan ? '自定义（按各段说明）' : 'AI智能分段（按创作需求自行拆成 ' + n + ' 段）'}。`
        : `【REQUIRED】Part 1 ===== 公共设定 ===== (subject_definitions only). Part 2 = ${n} Full-Reference groups without repeating subject_definitions. Mode=${kind}. Plan=${customPlan ? 'custom beats' : 'AI split from brief'}.`
    );
    if (!customPlan) {
      userParts.push(
        lang === 'zh'
          ? '【智能分段】不要等待「第 N 段在干什么」。根据下方创作需求自行设计每段事件、时长与衔接。'
          : '【AI split】Do not wait for per-segment beats. Invent each group from the brief below.'
      );
    }
  } else {
    userParts.push(
      lang === 'zh'
        ? '【强制】按本场景段落顺序输出纯视频提示词正文（简体中文）。禁止套用六段式标题，禁止在无附图时编造 <Picture N>/<Subject N>。'
        : '【强制】Output a plain scenario video prompt in English. Do NOT use Full-Reference six sections. Do not invent <Picture N>/<Subject N> without attached media.'
    );
  }
  userParts.push('【表单参数】');
  const formLines = formToLines(scenario, form);
  userParts.push(formLines.length ? formLines.join('\n') : '- （无额外表单填写）');

  userParts.push('');
  userParts.push('【创作需求 / User request】');
  userParts.push(String(shortText || '').trim() || '(empty)');

  const mediaItems = enumerateTaggedMedia(mediaPaths);
  const mediaLines = formatMediaList(mediaPaths);
  if (mediaLines.length) {
    userParts.push('');
    userParts.push('【参考素材 / Reference media】');
    userParts.push(...mediaLines);
    userParts.push('');
    if (lang === 'zh') {
      userParts.push('【强制·素材标签】主体定义必须以如下标签逐条起笔（可按实际素材增减）：');
      for (const item of mediaItems) {
        userParts.push(`${item.tag} …`);
      }
      if (scenario.outputMode === 'full_reference') {
        userParts.push('并为每个主要角色/产品写 <Subject N> 是 <Picture N> 中的……；后续段落必须复用这些标签。禁止只写角色名而不出现 <Picture N>。');
      } else {
        userParts.push('在正文中引用上述标签锚定外观；不要虚构额外未提供的素材标签。');
      }
    } else {
      userParts.push('【REQUIRED media tags】Use these exact tags in the prompt body:');
      for (const item of mediaItems) {
        userParts.push(`${item.tag} …`);
      }
      if (scenario.outputMode === 'full_reference') {
        userParts.push('Also define <Subject N> is from <Picture N> … and reuse these tags in later sections.');
      } else {
        userParts.push('Do not invent extra media tags beyond the list above.');
      }
    }
  } else {
    userParts.push('');
    if (scenario.outputMode === 'director_segments') {
      userParts.push(
        lang === 'zh'
          ? '【强制】本次无参考图：公共设定可用 <Subject N> 文字锁身份，严禁编造 <Picture N>/<Video N>/<Audio N>。'
          : '【REQUIRED】No media: public subject_definitions may use <Subject N> in prose. Do not invent <Picture N>/<Video N>/<Audio N>.'
      );
    } else {
      userParts.push(
        lang === 'zh'
          ? '【强制】本次无参考素材附件：输出中不得出现 <Picture N>/<Subject N>/<Video N>/<Audio N>。'
          : '【REQUIRED】No media attached: do not output <Picture N>/<Subject N>/<Video N>/<Audio N>.'
      );
    }
  }

  userParts.push('');
  userParts.push('【任务】根据场景硬约束 + 表单参数 + 创作需求 + 参考素材，输出最终提示词。');
  return userParts.join('\n');
}

// 判定是否是 MiniMax Scenario Profile（upstream assemble.js isMinimaxScenarioProfile）
export function isMinimaxScenarioProfile(profile: any): boolean {
  if (!profile || profile.kind !== 'expand') return false;
  if (profile.minimaxScenarioId) return true;
  if (String(profile.outputFormat || '') === 'minimax') return true;
  return !!getScenarioByPeId(profile?.id);
}

// 主体组装：MiniMax 场景的扩写管线（X5：maxTokens 下限 / userExtraPrompt / form 兼容 / peId 兜底 / 返回字段）
export interface MinimaxExpandResult {
  system: string;
  user: string;
  maxTokens: number;
  ruleId: string;
  minimaxScenarioId: string;
  mediaExpandLayout: boolean;
}

export function resolveMinimaxScenarioExpand(profile: any, params: any): MinimaxExpandResult | null {
  const scenario =
    getScenarioByPeId(profile && profile.id) ||
    getScenarioById(profile && profile.minimaxScenarioId) ||
    getScenarioByPeId(params && (params.peId || params.ruleId));
  if (!scenario) return null;

  // X5c：params.minimaxForm 直传（upstream）与 { form_fields, output_lang } 嵌套（插件工具面）两种都兼容
  const rawForm = params?.minimaxForm?.form_fields ?? params?.minimaxForm ?? {};
  const form = normalizeForm(scenario, rawForm);
  const shortText = String((params && params.shortText) || '').trim();
  const mediaPaths = Array.isArray(params && params.mediaPaths) ? params.mediaPaths : [];
  const expandLen = (params && params.expandLen) || 'long';
  const expandLenChars = params && params.expandLenChars;
  const userExtraPrompt = String((params && params.userExtraPrompt) || '').trim();
  const outputLangRaw =
    (params && params.outputLang) || (params && params.minimaxForm && params.minimaxForm.output_lang) || 'zh';
  const outputLang = String(outputLangRaw).toLowerCase() === 'en' ? 'en' : 'zh';

  let system = buildSystem(scenario, form, outputLang, mediaPaths);
  if (userExtraPrompt) {
    system += `\n\n【User additional requirements】${userExtraPrompt}`;
  }

  const tokenLimits: any = (params && params.tokenLimits) || null;
  const mediaMin =
    (tokenLimits && Number.isFinite(Number(tokenLimits.mediaExpandMin)) && Number(tokenLimits.mediaExpandMin)) ||
    DEFAULT_MEDIA_EXPAND_MIN;
  const maxTokens = Math.max(resolveExpandMaxTokens(expandLen, expandLenChars, tokenLimits), mediaMin);

  return {
    system,
    user: buildUser(scenario, form, shortText, mediaPaths, outputLang),
    maxTokens,
    ruleId: scenario.peId,
    minimaxScenarioId: scenario.id,
    mediaExpandLayout: true,
  };
}
