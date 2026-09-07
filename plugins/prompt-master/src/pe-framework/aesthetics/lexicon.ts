/**
 * 电影摄影词库（spec §7.3）：结构化数据（非 LLM prompt），供扩展引擎引用。
 * 景别/焦段/运镜/光线/色彩分级/构图 六类，每条为可感知名词短语。
 * Phase 2 内容深化：每类扩充至 ≥8 项，来源对齐 spec §7.3 与调研二——
 *   景别/焦段/运镜：可灵运镜词汇表、Veo 运镜库、ai-shortfilm-prompts（摄影机型号+焦段强制）
 *   光线：黄金时刻/伦勃朗光/体积光/色温/三点布光（spec §7.3 列举）
 *   色彩分级：ai-boost/awesome-prompts 分级模板（高光/中间调/阴影 + 青橙对比）
 *   构图：三分法/对称/负空间/前景引导/画中画（spec §7.3 列举）
 */
export interface CinemaLexicon {
  shots: string[]
  lenses: string[]
  camera_moves: string[]
  lighting: string[]
  grading: string[]
  composition: string[]
}

export const CINEMA_LEXICON: CinemaLexicon = {
  shots: ['ECU', 'CU', 'MCU', 'MS', 'FS', 'WS', 'ELS', 'OS', 'POV'],
  lenses: ['16mm', '24mm', '28mm', '35mm', '50mm', '85mm', '100mm', '135mm', '200mm'],
  camera_moves: ['dolly', 'pan', 'tracking', 'orbit', 'crane', 'handheld', 'tilt', 'zoom', 'push-in', 'pull-back'],
  lighting: ['黄金时刻', '蓝色时刻', '伦勃朗光', '体积光', '三点布光', '侧逆光', '背光', '顶光', '边缘光', '色温'],
  grading: ['青橙对比', '低饱和', '漂白', '高光暖调', '阴影冷调', '中间调暖调', '胶片颗粒', '褪色复古'],
  composition: ['三分法', '对称构图', '负空间', '前景引导', '画中画', '框架构图', '对角构图', '中心构图', '黄金分割'],
}
