/**
 * R24（spec §3 方言解耦注册面）：directing 编排器的单一编译 seam。
 * 编排器只 import 本模块，不直接依赖具体方言实现——第二方言接入时在此扩为
 * registry 分派（Speculative Generality 防御：不预建 registry 包，裁决记入
 * spec §3 修订记录）。现委托 compileH3（h3 唯一在途方言）。
 */
import { compileH3 } from '../dialect/h3.js';

/** 编译入参（随方言实现投影，零重复声明） */
export type DirectingCompileInput = Parameters<typeof compileH3>[0];
/** 编译上下文（stage / speakerIds / references / depth 等，随方言实现投影） */
export type DirectingCompileCtx = Parameters<typeof compileH3>[1];

/** 逐镜编译：DirectingIr shot 内容 → 分 stage 官方格式提示词 */
export function compileDirectingShot(...args: Parameters<typeof compileH3>): ReturnType<typeof compileH3> {
  return compileH3(...args);
}
