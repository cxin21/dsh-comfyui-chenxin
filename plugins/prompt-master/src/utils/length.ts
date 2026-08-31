// 长度/token 工具
// 中文 1字符 ≈ 1 token，英文 1词 ≈ 1.3 token

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 拆分为中英文混合计算
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - chinese;
  return Math.ceil(chinese + other / 4);
}

export function countChars(text: string): number {
  return text ? text.length : 0;
}

export function isUnderBudget(text: string, maxChars: number): boolean {
  return text.length <= maxChars;
}