/**
 * 工作流注册表（2026-11-22）——让「在调用期才解析 transport」的组件（intent provider、
 * critic provider）也能挂到**当前这次调用**的工作流引擎上，从而在 trace 里留下节点记录。
 *
 * 为什么不直接传引擎：intent/critic provider 是**模块级单例**（插件 apply 期装配），
 * 它们在每次调用时才拿到 exec（会话路由/父 agent 都在 exec 上）。所以用 ctx → engine
 * 的弱映射做「本次调用的上下文」传递：execute 期间注册，结束注销。
 */
import type { WorkflowEngine } from './engine.js';

const engines = new WeakMap<object, WorkflowEngine>();

export function setWorkflowEngine(ctx: unknown, engine: WorkflowEngine): void {
  if (typeof ctx === 'object' && ctx !== null) engines.set(ctx as object, engine);
}

export function clearWorkflowEngine(ctx: unknown): void {
  if (typeof ctx === 'object' && ctx !== null) engines.delete(ctx as object);
}

export function getWorkflowEngine(ctx: unknown): WorkflowEngine | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  return engines.get(ctx as object);
}
