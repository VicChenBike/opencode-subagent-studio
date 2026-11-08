// src/gui/inflight.ts —— 行级写操作的共享 in-flight 登记（纯逻辑，无 DOM / 无 Solid，可单测）。
//
// 第十二轮 G-12-6：旧实现把「开关流程进行中」的 busy 放在 AgentRow 组件实例里。
// 列表用 <For> 按引用 keyed，任何 refetch 都会重挂载行组件、把 busy 归零；
// 用户在 V1 迁移流程中途再点开关，就会并发第二个 setDisabled 并撞 CAS conflict。
// 守卫必须比组件生命周期长，因此按 path 键记在模块级；流程结束（含失败 / 取消）后清理。
const inFlight = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * 订阅登记变化（占用 / 释放都会触发）。
 * 组件侧据此刷新渲染（Solid 信号不直接暴露在这里，保持本模块无框架依赖、可单测）。
 * 返回取消订阅函数。
 */
export function onInFlightChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 尝试占用某行的写操作槽位。已在流程中返回 false（调用方应直接忽略这次点击）。 */
export function beginInFlight(key: string): boolean {
  if (inFlight.has(key)) return false
  inFlight.add(key)
  notify()
  return true
}

/** 释放槽位。流程的 finally 里必须调用，否则该行永久不可操作。 */
export function endInFlight(key: string): void {
  if (inFlight.delete(key)) notify()
}

/** 该行是否已有写操作在进行中（用于渲染禁用态）。 */
export function isInFlight(key: string): boolean {
  return inFlight.has(key)
}

/** 仅供测试：清空登记表，避免用例间串扰。 */
export function resetInFlight(): void {
  inFlight.clear()
  notify()
}
