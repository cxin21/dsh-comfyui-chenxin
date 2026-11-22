/**
 * LLM 工作流类型（2026-11-22）——把「一条提示词生成流水线」显式建模成
 * **节点图**：每个节点 = 一个角色（role）+ 一份契约（parse）+ 一条执行策略（executor）。
 *
 * ## 为什么要有这一层
 * 此前 prompt-forge 的流水线是**命令式**的：`orchestrateCompositing` /
 * `orchestrateDirecting` 里手写 S1→S5 的控制流，每个角色调用散落在不同分支里。
 * 后果是：
 *   - 「谁在跑、跑的是哪个角色、用的哪种执行器、失败了怎么办」没有单一事实源；
 *   - 加一个新角色要改多个分支 → 角色之间开始漂移（这正是本次审计反复批的 drift 反模式）；
 *   - 换执行器（进程内直连 ↔ 子代理团队）只能逐个调用点打补丁。
 *
 * 工作流层把「角色」升格为一等公民：
 *   node = { id, role, executor, maxAttempts }
 * 引擎负责：执行器解析、失败分类、重试、逐节点 trace。
 * 控制流（循环/门/修复轮）仍留在编排器里——**流程的形状**是业务语义，
 * 不该被引擎吞掉；引擎只管**节点的执行纪律**。
 */
import type { TransportKind } from '../llm/transport.js';

/** 一次角色调用的 runner 形态：taskText → assistant 文本 */
export type RoleRunner = (taskText: string) => Promise<string>;

/** 节点级执行器策略：'auto' = 跟随引擎默认（PM_TRANSPORT / 能力探测） */
export type WorkflowExecutor = TransportKind | 'auto';

export interface WorkflowNodeSpec {
  /** 节点 id（同一工作流内唯一） */
  id: string;
  /** 角色名（persona 语义）：script-analyst / writer / auditor / repairer / critic … */
  role: string;
  /** 节点级执行器策略；缺省 = auto */
  executor?: WorkflowExecutor;
  /** 失败重试次数（不含首次）；缺省 0 */
  maxAttempts?: number;
  /** 节点标签前缀（团队执行器用于 teammate 命名） */
  labelPrefix?: string;
}

export interface WorkflowNodeError {
  /** 失败分类：transport_unavailable / llm_failed / parse_failed / cancelled / unknown */
  code: string;
  message: string;
}

export interface WorkflowNodeOutcome {
  id: string;
  role: string;
  /** 实际使用的执行器；没有可用执行器时为 'none' */
  executor: TransportKind | 'none';
  ok: boolean;
  ms: number;
  attempts: number;
  error?: WorkflowNodeError;
}

export interface WorkflowTrace {
  nodes: WorkflowNodeOutcome[];
  totalMs: number;
}

export interface WorkflowNodeResult<T> {
  ok: boolean;
  value?: T;
  error?: WorkflowNodeError;
  outcome: WorkflowNodeOutcome;
}
