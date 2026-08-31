// MiniMax H3 场景组装 — 1:1 移植自 PM minimaxScenarios/assemble.js
// 简化版：完整保留 form 处理 + media tag lock + 6 段 H3 模板拼装

import { resolveExpandMaxTokens } from '../profiles/expand-rules.js';
import { getScenarioByPeId, getScenarioById, type MiniMaxScenario } from './catalog.js';
import { H3_REFERENCE_EN, H3_REFERENCE_ZH, H3_REFERENCE_JA } from './templates/index.js';

// 模板加载（中英两套 Full-Reference 指南）
const _cachedFullRefGuides: Record<string, string> = {};

// 内置最小化 Full-Reference 指南（避免 60K 模板文件依赖）
const MINIMAL_GUIDE_ZH = `# MiniMax-H3 Full-Reference 中文指南

六段标题（强制）：
1. 主体定义: — 列出 <Subject N>/<Picture N>，每个主体描述身份、外观、穿着
2. 摘要: — 一句话描述视频主体内容
3. 保留分析: — 各镜头的保留/部分保留评估
4. 详细描述: — 每个 [Shot N] 段的开头、镜头、动作、运镜
5. 整体声景: — 完整声场（含环境音、动作音、对话）
6. 非叙事配乐: — 背景音乐的风格、节奏、情绪

约束：参考标签 <Subject N>/<Picture N>、关系标记 fully_preserved、镜头 [Shot N] 保持英文。`;

const MINIMAL_GUIDE_EN = `# MiniMax-H3 Full-Reference English Guide

Six section headers (mandatory):
1. subject_definitions: — list <Subject N>/<Picture N>, each with identity, appearance, wardrobe
2. summary: — one-sentence video summary
3. retention_analysis: — per-shot fully/partially preserved evaluation
4. detailed_description: — each [Shot N] segment opening, camera, action, movement
5. overall_soundscape: — full sound stage (ambient, action, dialogue)
6. non_diegetic_music: — background music style, rhythm, mood

Keep all reference tags <Subject N>/<Picture N>, relation markers fully_preserved, [Shot N] shots in English.`;

function loadFullReferenceGuide(lang: string): string {
  const key = String(lang || 'zh').toLowerCase();
  if (_cachedFullRefGuides[key]) return _cachedFullRefGuides[key];
  // 从 templates/ 目录加载完整模板（默认中文），失败时回退到内联精简版
  const guideMap: Record<string, string> = {
    en: H3_REFERENCE_EN,
    zh: H3_REFERENCE_ZH,
    ja: H3_REFERENCE_JA,
  };
  const text = guideMap[key] || guideMap.zh;
  _cachedFullRefGuides[key] = text || MINIMAL_GUIDE_ZH;
  return _cachedFullRefGuides[key];
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

// 素材标签锁
function buildMediaTagLock(mediaPaths: string[] | undefined, lang: string, outputMode: string, form: Record<string, any>): string[] {
  const items = (mediaPaths || []).map((p, i) => ({ tag: p.includes('Picture') ? p : `<Picture ${i + 1}>`, path: p, base: p.split(/[/\\]/).pop() || p }));
  const lines: string[] = [];
  const r2vLock = outputMode === 'full_reference' || (outputMode === 'director_segments' && String((form && form.prompt_kind) || '') === 'r2v');

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
      lines.push('用户未附带任何图片/视频/音频。严禁编造或输出 <Picture N>、<Subject N>、<Video N>、<Audio N> 等参考标签。');
    } else {
      lines.push('## Reference media (none attached)');
      lines.push('No media attached. Do NOT invent <Picture N>, <Subject N>, <Video N>, or <Audio N> tags.');
    }
    lines.push('');
    return lines;
  }

  const tags = items.map((x) => x.tag);
  if (lang === 'zh') {
    lines.push('## 参考素材标记（最高优先级）');
    lines.push(`用户已附带 ${items.length} 个参考素材：${tags.join('、')}。输出中必须使用这些尖括号标签。`);
    if (r2vLock) {
      lines.push('在「主体定义」中必须逐条定义每个素材标签，并建立主体映射，例如：');
      lines.push('<Picture 1> 是……（说明该图角色/用途）');
      lines.push('<Subject 1> 是 <Picture 1> 中的……（外观特征）');
    }
  } else {
    lines.push('## Reference media tags (ABSOLUTE when media attached)');
    lines.push(`User attached ${items.length} media asset(s): ${tags.join(', ')}. Use these exact angle-bracket tags.`);
    if (r2vLock) {
      lines.push('In subject_definitions, define every media tag and map subjects.');
    }
  }
  lines.push('');
  return lines;
}

// 主体组装 system prompt
function buildSystem(scenario: MiniMaxScenario, form: Record<string, any>, outputLang: string, mediaPaths: string[] | undefined): string {
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
      parts.push('六段中文标题（强制）：主体定义: / 摘要: / 保留分析: / 详细描述: / 整体声景: / 非叙事配乐:');
      parts.push('禁止输出 subject_definitions:、summary: 等英文章节标题。');
    } else {
      parts.push('User selected 【English】. Write all six section bodies in English.');
    }
  } else if (scenario.outputMode === 'director_segments') {
    if (lang === 'zh') {
      parts.push('用户选择【中文】。章节标题必须用中文六段式。');
      parts.push('禁止输出 subject_definitions:、summary: 等英文章节标题。');
    } else {
      parts.push('User selected 【English】. Use English Full-Reference keys.');
    }
  } else if (lang === 'zh') {
    parts.push('用户选择【中文】。正文必须用简体中文。');
    parts.push('本场景不是 Full-Reference 六段式。');
  } else {
    parts.push('User selected 【English】. Write the prompt body in English.');
    parts.push('This scenario is NOT Full-Reference six-section format.');
  }
  parts.push('');

  // 输出格式
  if (scenario.outputMode === 'full_reference') {
    if (lang === 'zh') {
      parts.push('## 输出格式（最高优先级）');
      parts.push('仅输出 MiniMax-H3 Full-Reference 标准六段（中文标题）：主体定义 → 摘要 → 保留分析 → 详细描述 → 整体声景 → 非叙事配乐。');
      parts.push('绝对纯净输出：以「主体定义:」开头，以「非叙事配乐:」内容结束。不要 Markdown 代码围栏。');
      parts.push('章节标题用中文；参考标签/关系标记/镜头标记保持英文。');
      if (form.expand_mode === 'expand') {
        parts.push('用户允许扩写：可补充必要的视觉/听觉/时间细节。');
      } else {
        parts.push('默认严格改写：不要编造用户未给出或未强烈暗示的情节。');
      }
      parts.push('');
      parts.push('## Full-Reference 中文指南（请严格遵循）');
      parts.push(loadFullReferenceGuide('zh'));
    } else {
      parts.push('## Output format (HIGHEST PRIORITY)');
      parts.push('Produce MiniMax-H3 Full-Reference Mode standardized 6 sections ONLY.');
      parts.push('Absolute pure output: start with subject_definitions: end with non_diegetic_music:.');
      parts.push('');
      parts.push('## Full-Reference Guide (English edition)');
      parts.push(loadFullReferenceGuide('en'));
    }
  } else if (scenario.outputMode === 'director_segments') {
    const n = Math.max(2, parseInt(String(form.segment_count || '4'), 10) || 4);
    const kind = String(form.prompt_kind || 't2v') === 'r2v' ? 'r2v' : 't2v';
    const customPlan = String(form.plan_mode || 'ai') === 'custom';
    const sec = String(form.segment_seconds || '5');
    if (lang === 'zh') {
      parts.push('## 输出格式（最高优先级）');
      parts.push(`严格按「公共设定 + ${n} 组六段式（去主体定义）」输出。`);
      if (customPlan) {
        parts.push('分段方式=自定义：每段剧情严格按用户填写的「第 N 段在干什么」。');
      } else {
        parts.push('分段方式=AI 智能：模型按创作需求自由分段。');
      }
      parts.push(`Part 2 = ${n} 组提示词（每段约 ${sec} 秒）。`);
      parts.push('===== 公共设定 ===== 块仅放 主体定义：');
      parts.push('===== 提示词组 k ===== 块中其余五段（摘要/保留分析/详细描述/整体声景/非叙事配乐）。');
    } else {
      parts.push(`Output Format: Public subject_definitions + ${n} Full-Reference groups. Each group uses summary/retention_analysis/detailed_description/overall_soundscape/non_diegetic_music.`);
      parts.push(`===== Public ===== block uses subject_definitions:.`);
      parts.push(`===== Group k ===== block uses other 5 sections.`);
    }
  } else if (lang === 'zh') {
    parts.push('## 输出格式（最高优先级）');
    parts.push('本场景不是 Full-Reference 六段式，不要输出六段标题。');
    parts.push('按场景专属结构（time-section / template / prose paragraph）输出，遵循场景硬约束。');
  } else {
    parts.push('## Output format (HIGHEST PRIORITY)');
    parts.push('This scenario is NOT Full-Reference six-section format.');
    parts.push('Follow the scenario-specific structure (time-section / template / prose).');
  }

  // 场景硬约束
  parts.push('');
  parts.push('## 场景硬约束（必须全部遵守）');
  for (const hc of scenario.hardConstraints) {
    parts.push(`- ${hc}`);
  }

  // 表单字段
  const formLines = formToLines(scenario, form);
  if (formLines.length) {
    parts.push('');
    parts.push('## 当前表单输入');
    parts.push(...formLines);
  }

  return parts.join('\n');
}

// 主体组装 user prompt
function buildUser(scenario: MiniMaxScenario, form: Record<string, any>, outputLang: string, mediaPaths: string[] | undefined): string {
  const lang = String(outputLang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  const parts: string[] = [];

  if (lang === 'zh') {
    parts.push('请按以上系统提示与场景硬约束，输出可直接投喂 MiniMax-H3 视频模型的提示词正文。');
    parts.push('仅输出最终正文；不要解释过程、不要 Markdown。');
  } else {
    parts.push('Follow the system prompt and scenario hard constraints above; output the ready-to-use MiniMax-H3 prompt body.');
    parts.push('Output only the final body; no explanation, no markdown.');
  }
  parts.push('');

  if (scenario.outputMode === 'director_segments') {
    const n = Math.max(2, parseInt(String(form.segment_count || '4'), 10) || 4);
    if (lang === 'zh') {
      parts.push(`请输出 ${n} 段：Part 1 = 公共设定（===== 公共设定 =====）；Part 2 = ${n} 个提示词组（===== 提示词组 1..${n} =====）。`);
    } else {
      parts.push(`Output ${n} segments: Part 1 = Public subject_definitions; Part 2 = ${n} groups.`);
    }
  }

  if (scenario.assembleHints) {
    parts.push('');
    parts.push(`## 组装提示：${scenario.assembleHints}`);
  }

  return parts.join('\n');
}

// 判定是否是 MinMax Scenario Profile
export function isMinimaxScenarioProfile(profile: any): boolean {
  return !!(profile && profile.minimaxScenarioId);
}

// 主体组装：MinMax 场景的扩写管线
export function resolveMinimaxScenarioExpand(
  profile: any,
  params: any,
): { system: string; user: string; maxTokens: number; ruleId: string } | null {
  const scenarioId = profile?.minimaxScenarioId || params?.minimaxForm?.scenario_id;
  if (!scenarioId) return null;

  const scenario = getScenarioById(scenarioId) || getScenarioByPeId(profile.id);
  if (!scenario) return null;

  const outputLang = (params?.minimaxForm?.output_lang || params?.outputLang || 'zh') as 'zh' | 'en';
  const form = normalizeForm(scenario, params?.minimaxForm?.form_fields || {});
  const mediaPaths = params?.mediaPaths || [];

  const system = buildSystem(scenario, form, outputLang, mediaPaths);
  const user = buildUser(scenario, form, outputLang, mediaPaths);
  const maxTokens = resolveExpandMaxTokens('long'); // MiniMax 场景总是需要较长输出

  return { system, user, maxTokens, ruleId: profile.id || scenario.id };
}