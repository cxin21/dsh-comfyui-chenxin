/**
 * 电影摄影词库（spec §7.3）：结构化数据（非 LLM prompt），供扩展引擎引用。
 * 景别/焦段/运镜/光线/色彩分级/构图 六类，每条为可感知名词短语。
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
  shots: ['ECU', 'CU', 'MCU', 'MS', 'FS', 'WS', 'ELS'],
  lenses: ['24mm', '35mm', '50mm', '85mm', '135mm'],
  camera_moves: ['dolly', 'pan', 'tracking', 'orbit', 'crane', 'handheld'],
  lighting: ['黄金时刻', '伦勃朗光', '体积光', '三点布光', '侧逆光', '色温'],
  grading: ['青橙对比', '低饱和', '漂白', '高光暖调', '阴影冷调'],
  composition: ['三分法', '对称构图', '负空间', '前景引导', '画中画'],
}
