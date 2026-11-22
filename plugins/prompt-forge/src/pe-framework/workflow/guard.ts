/**
 * 工作流重入守卫（2026-11-23）。
 *
 * ## 为什么需要
 * 团队形态（subagent-v2）下，每个角色节点 = 一个 teammate。teammate 继承父 agent 的
 * 工具面——如果父 agent 所在会话挂着本插件，teammate 也就**能看见 prompt_author**。
 * 于是出现一条自指的回路：prompt_author → 角色节点 → teammate → prompt_author → …
 * 旧 seam 有 `toolFilter: {allow: []}` 做架构级隔离；新 seam 的 spec 里**没有工具白名单**，
 * 只能靠「不发起」来断环。
 *
 * ## 判据（为什么不是简单的布尔标记）
 * 朴素的「工作流执行期间 = 禁止再入」会**误伤合法的并发调用**：
 * 同一会话里两个互不相关的 prompt_author 调用（第二个由用户直接发起），
 * 第一个正在跑节点时，第二个会被当成嵌套调用拒掉。
 *
 * 正确的判据是**调用者身份**：
 *   - teammate 调 prompt_author → 调用者的 agent ≠ 工作流发起者 → 拒绝（自指回路）；
 *   - 同一会话的另一个顶层调用 → 调用者的 agent = 工作流发起者 → 放行；
 *   - 另一个会话 → 另一个 ctx（preset 树按会话挂载）→ 不在同一 scope → 放行。
 *
 * scope 按 ctx 记录（WeakMap，不泄漏）：{ ownerAgentId, depth }。
 */
interface WorkflowScope {
  /** 工作流发起者的 agent id（顶层调用者） */
  ownerAgentId?: string;
  /** 嵌套深度（顶层调用期间重入） */
  depth: number;
}

const scopes = new WeakMap<object, WorkflowScope>();

function keyOf(ctx: unknown): object | undefined {
  return typeof ctx === 'object' && ctx !== null ? (ctx as object) : undefined;
}

/** 开始一次工作流作用域（顶层 prompt_author 调用期间）。成对调用 endWorkflowScope。 */
export function beginWorkflowScope(ctx: unknown, ownerAgentId?: string): void {
  const key = keyOf(ctx);
  if (!key) return;
  const scope = scopes.get(key);
  if (scope) {
    scope.depth += 1;
    return;
  }
  scopes.set(key, { ownerAgentId, depth: 1 });
}

/** 结束一次工作流作用域。 */
export function endWorkflowScope(ctx: unknown): void {
  const key = keyOf(ctx);
  if (!key) return;
  const scope = scopes.get(key);
  if (!scope) return;
  scope.depth -= 1;
  if (scope.depth <= 0) scopes.delete(key);
}

/**
 * 这次调用是不是「工作流派生出的自指回路」？
 * @param callerAgentId 调用者的 agent id（exec.agent?.id）
 */
export function isNestedWorkflowCall(ctx: unknown, callerAgentId?: string): boolean {
  const key = keyOf(ctx);
  if (!key) return false;
  const scope = scopes.get(key);
  if (!scope || scope.depth <= 0) return false;
  if (scope.ownerAgentId === undefined || callerAgentId === undefined) return false;
  return scope.ownerAgentId !== callerAgentId;
}

/** 当前是否处于某个工作流作用域内（诊断用）。 */
export function isInsideWorkflow(ctx: unknown): boolean {
  const key = keyOf(ctx);
  if (!key) return false;
  const scope = scopes.get(key);
  return scope !== undefined && scope.depth > 0;
}
