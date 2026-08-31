// {{variable}} 模板渲染引擎 — 1:1 移植自 PromptMaster
// 源: promptEngineeringResolver.js renderTemplate()

export function renderTemplate(tpl: string, vars: Record<string, string | undefined>): string {
  let s = String(tpl || '');
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{{${k}}}`).join(v == null ? '' : String(v));
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

export function blockOrEmpty(line: string | undefined | null): string {
  const t = String(line || '').trim();
  return t ? `${t}\n\n` : '';
}

export function userTemplateHasInputPlaceholder(tpl: string | undefined | null): boolean {
  return /\{\{\s*user_input\s*\}\}/i.test(String(tpl || ''));
}

/**
 * 自定义用户模板未包含 {{user_input}} 时，强制附上待扩写原文
 * 源: promptEngineeringResolver.js appendExpandSourceBlock()
 */
export function appendExpandSourceBlock(
  userBody: string | undefined | null,
  shortText: string | undefined | null,
  outputLang: string
): string {
  const t = String(shortText || '').trim();
  if (!t) {
    return String(userBody || '').trim();
  }
  const useEn = resolveUseEnglishOutput(outputLang, t);
  const taskTitle = useEn ? 'Task' : '任务';
  const srcTitle = useEn ? 'Source text to expand' : '待扩写原文';
  const taskNote = useEn
    ? 'Apply the rules above to expand ONLY the source text below into an image-generation prompt. Output the expanded prompt only—no essays about style or methodology. If an example in the rules differs from the source text below, use the source text below.'
    : '请按上文扩写规则，仅扩写下方「待扩写原文」为 AI 绘图正向提示词。只输出扩写正文，不要写关于风格/方法论的说明文。若上文举例与下文不一致，以下方为准。';
  const body = String(userBody || '').trim();
  return `${body}\n\n【${taskTitle}】${taskNote}\n\n【${srcTitle}】\n${t}`;
}

export function resolveUseEnglishOutput(outputLang: string, shortText: string): boolean {
  const lang = String(outputLang || 'zh').toLowerCase();
  if (lang === 'en') return true;
  if (lang === 'zh') return false;
  return !/[\u4e00-\u9fff]/.test(String(shortText || ''));
}

export function getOutputLangUserLock(outputLang: string): string {
  const lang = String(outputLang || '').toLowerCase();
  if (lang === 'zh') {
    return (
      '【输出语言】已锁定为中文（最高优先级）。即使用户输入是英文单词或 tag（如 1girl、solo），' +
      '也必须用中文自然语言扩写；禁止输出英文 tag 串、禁止整段英文逗号关键词列表。'
    );
  }
  if (lang === 'en') {
    return (
      '【Output language】Locked to English (highest priority). Even if input is Chinese, ' +
      'output must be English only; no Chinese sentences as main content.'
    )
  }
  return '';
}