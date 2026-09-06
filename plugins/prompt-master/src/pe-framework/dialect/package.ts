/**
 * 方言包规范（spec §9）：DialectContract 升级为方言包声明。
 * DialectPackage 要求 capabilities/constraints/aesthetics 三字段（license 可选）；
 * getDialectPackage 从注册表方言读取，未声明完整包 → undefined。
 */
import type {
  DialectContract,
  DialectCapabilities,
  DialectConstraints,
  DialectAesthetics,
  DialectLicense,
} from './contract.js'
import { getDialect } from './registry.js'
import type { Target } from '../types.js'

export type { DialectCapabilities, DialectConstraints, DialectAesthetics, DialectLicense }

export interface DialectPackage extends DialectContract {
  capabilities: DialectCapabilities
  constraints: DialectConstraints
  aesthetics: DialectAesthetics
  license?: DialectLicense
}

/**
 * 读取方言包声明；target 未注册或未声明完整包（capabilities/constraints/aesthetics 任一缺失）→ undefined。
 * target 参数放宽为 string：未知方言名返回 undefined（计划测试用例 getDialectPackage('flux')）。
 */
export function getDialectPackage(target: string): DialectPackage | undefined {
  const d = getDialect(target as Target)
  if (!d) return undefined
  if (d.capabilities === undefined || d.constraints === undefined || d.aesthetics === undefined) return undefined
  return d as unknown as DialectPackage
}
