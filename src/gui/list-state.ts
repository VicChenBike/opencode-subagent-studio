// src/gui/list-state.ts —— 列表页视图状态推导（纯逻辑，无 DOM，可单测）。
// 桌面端实测（2026-11-07）：list RPC 返回 500 时页面整页空白。
// 把「资源状态 + 查询词」映射成显式视图状态，错误必须落到 error 分支。
import type { AgentSummary } from "../rpc"

export interface ListViewInput {
  loading: boolean
  error: unknown
  agents: readonly AgentSummary[]
  query: string
}

export type ListViewState =
  | { kind: "error"; message: string }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "emptySearch"; query: string }
  | { kind: "rows"; agents: AgentSummary[] }

/** 从任意错误值取出可展示的文案：Error、带 message 的对象、字符串、其他原值的 String()。 */
export function errorMessage(error: unknown): string {
  if (error === null || error === undefined) return ""
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/** 错误优先于 loading：错误态必须能覆盖仍在 loading 的资源。 */
export function listViewState(input: ListViewInput): ListViewState {
  if (input.error !== undefined && input.error !== null) {
    return { kind: "error", message: errorMessage(input.error) }
  }
  if (input.loading) return { kind: "loading" }
  const query = input.query.trim()
  if (input.agents.length === 0) {
    return query ? { kind: "emptySearch", query } : { kind: "empty" }
  }
  return { kind: "rows", agents: [...input.agents] }
}
