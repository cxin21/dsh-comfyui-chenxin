import type { Target } from './types.js'

/**
 * Anima 槽序（前端权重敏感，顺序不得更改）。
 * 逐字提取自 comfyui-chenxin preset:
 * C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\skills\anima-prompt-v1\anima_prompt_v1\types.py L30-40
 * （`SLOT_ORDER: tuple[str, ...]`——"Slot order IS the implicit-weight policy. Front slots weigh more."；
 *  `narrative` 不是槽，始终作为自由散文最后追加，不入此序；
 *  composition.py L87-92：priority = 200 + slot_index * 50，前端 token 权重依赖此序）
 */
export const SLOT_ORDER: string[] = [
  'count_gender',
  'character',
  'artist', // 2026-09 外部基准 B8：画师是 Anima 画风第一杠杆（NewBie/Animagine 实证序：count→character→@artist→特征）。空槽零输出——不设 artist 时 positive/negative 与旧序逐字节一致；segments priority 仅在 artist 在场时后续 +50
  'appearance',
  'clothing',
  'pose_action',
  'expression',
  'camera',
  'scene',
  'detail_mood',
]

export const TARGETS: Target[] = ['anima', 'h3', 'sd', 'generic']

export const THREE_VARIANTS = ['base', 'aesthetic', 'turbo'] as const