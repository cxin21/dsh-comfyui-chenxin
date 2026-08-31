import type { DialectContract } from './contract.js'

export type { DialectContract }
import type { Target } from '../types.js'

const dialects = new Map<Target, DialectContract>()

export function registerDialect(contract: DialectContract): void {
  if (dialects.has(contract.id)) throw new Error(`dialect already registered: ${contract.id}`)
  dialects.set(contract.id, contract)
}
export function getDialect(target: Target): DialectContract | undefined {
  return dialects.get(target)
}
export function isDialectReady(target: Target): boolean {
  return dialects.has(target)
}
/** 仅测试用：清空注册表（模块级单例在 vitest 间的隔离） */
export function __resetDialectsForTests(): void { dialects.clear() }
