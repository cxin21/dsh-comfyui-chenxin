/**
 * 宽松 JSON 提取（2026-09-16 活跑实证 gen_1789522875279：LLM 在 JSON 后追加说明文字，
 * `首{到尾}`切片跨越边界 → JSON.parse "Unexpected non-whitespace character after JSON"）。
 * 平衡花括号扫描：尊重字符串/转义，截取**第一个完整 JSON 对象**的精确切片。
 * 所有 one-shot 产出解析器（semantic/writer/enrich patch）统一换用——替代各自的首尾切片。
 */
export function extractFirstJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  if (start < 0) return raw;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  // 未闭合（截断输出）→ 退回首尾切片（调用方 JSON.parse 会报原有错误）
  return raw.slice(start);
}
