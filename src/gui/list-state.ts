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

/**
 * 收到 changed 事件时的处置（goal.md §12.1 末句）。
 *
 * 编辑页打开时一律只提示「磁盘已更新」，不重拉也不覆盖表单：
 * 用户正在编辑的内容一旦被磁盘版本替换，未保存的修改就无声丢失了。
 * 这里不区分 formDirty——编辑页的输入永远算作「可能未保存」。
 */
export function changedAction(input: {
  editorOpen: boolean
  formDirty: boolean
}): "refetch" | "notify" {
  return input.editorOpen ? "notify" : "refetch"
}

export interface AgentRowState {
  /** 行内「已停用」徽标是否显示 */
  showDisabledBadge: boolean
  /** 停用开关是否处于打开态 */
  switchChecked: boolean
  /** 行是否降低不透明度 */
  dimmed: boolean
}

/**
 * 行级显示状态（goal.md §10）。
 *
 * 三种输入必须都判对：无 disabled 字段（= 启用）、`disabled: false`（= 启用）、
 * `disabled: true`（= 停用）。桌面端曾出现全部 7 行都显示「已停用」而文件真值全是启用，
 * 所以这里用严格的 `=== true` 而不是 truthy 判断，并把三个派生值收在一处，
 * 避免徽标 / 开关 / 变灰三处各自判定而走偏。
 */
export function agentRowState(agent: { disabled?: boolean }): AgentRowState {
  const disabled = normalizeFlag(agent.disabled)
  return { showDisabledBadge: disabled, switchChecked: disabled, dimmed: disabled }
}

/**
 * 把传输层可能带来的各种「真」表示收敛成布尔。
 *
 * 契约里 disabled 是 boolean，但 RPC 要跨 JSON/HTTP 两跳，任何一环把布尔写成字符串
 * 都会让 GUI 判错。这里只把**明确的真值**当作 true：布尔 true、字符串 "true"、数字 1。
 * 其余（undefined / null / false / "false" / "0" / 0 / 空串）一律视为启用——
 * 误报「已停用」比漏报更糟：用户会以为代理被停用了。
 */
function normalizeFlag(value: unknown): boolean {
  // 只认「明确为真」的两种表示。数字 1 不认——契约里没有数字形态，
  // 出现它说明数据已经不可信，宁可当启用也不误报停用。
  return value === true || value === "true"
}
