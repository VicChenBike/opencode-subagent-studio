// src/gui/list-state.ts —— 列表页视图状态推导（纯逻辑，无 DOM，可单测）。
// 桌面端实测（2026-11-07）：list RPC 返回 500 时页面整页空白。
// 把「资源状态 + 查询词」映射成显式视图状态，错误必须落到 error 分支。
import type { AgentSummary } from "../rpc"
import { messageOf } from "./error-copy.ts"

/** 从任意错误值取出可展示的文案（与 error-copy 共用一份实现）。 */
export const errorMessage = messageOf

export interface ListViewInput {
  loading: boolean
  error: unknown
  agents: readonly AgentSummary[]
  query: string
  /**
   * 是否已经有上一次成功加载的数据（resource 已 resolve 过）。
   * 省略视为 false，保持第十一轮「首次加载显示 Loader」的行为。
   */
  hasData?: boolean
}

export type ListViewState =
  | { kind: "error"; message: string }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "emptySearch"; query: string }
  | { kind: "rows"; agents: AgentSummary[] }


/**
 * 列表内容的推导（与 loading / error 无关的部分）。
 * 搜索词与行数据都来自当前作用域，因此「已有数据时的刷新」直接复用它。
 */
function contentState(input: ListViewInput): ListViewState {
  const query = input.query.trim()
  if (input.agents.length === 0) {
    return query ? { kind: "emptySearch", query } : { kind: "empty" }
  }
  return { kind: "rows", agents: [...input.agents] }
}

/**
 * 列表视图状态。
 *
 * 优先级（第十二轮 G-12-4 / G-12-5）：
 * 1. 首次加载（还没有任何已加载数据）：一律 loading。
 *    切作用域时 error 仍是上一个作用域的旧值，不能盖住新来源的加载过程。
 * 2. 刷新中但已有数据：保持现有内容（行 / 空态 / 搜索空态），不闪 Loader，
 *    也不让旧 error 把整页替换成错误视图——否则每次写操作后列表都会整体消失一次。
 * 3. 加载结束后 error 优先（goal.md §12.1：500 时不能整页空白）。
 * 4. 其余按内容落到 empty / emptySearch / rows。
 */
export function listViewState(input: ListViewInput): ListViewState {
  const hasData = input.hasData === true
  if (input.loading) {
    return hasData ? contentState(input) : { kind: "loading" }
  }
  if (input.error !== undefined && input.error !== null) {
    return { kind: "error", message: errorMessage(input.error) }
  }
  return contentState(input)
}

/**
 * 收到 changed 事件时的处置（goal.md §12.1 末句）。
 *
 * 编辑页打开时一律只提示「磁盘已更新」，不重拉也不覆盖表单：
 * 用户正在编辑的内容一旦被磁盘版本替换，未保存的修改就无声丢失了。
 * 这里不区分 formDirty——编辑页的输入永远算作「可能未保存」。
 *
 * 第十二轮 G-12-3：服务端每次写操作都是「先 emit changed 再返回 RPC 结果」，
 * 所以编辑页自己的保存 / 重命名会先收到一条 changed。这条事件不是「磁盘被别人改了」，
 * 提示「磁盘已更新」会误导用户。编辑页在发起写 RPC 前把 selfWrite 置位、响应后复位，
 * 期间到达的 changed 直接忽略（编辑页里已由自己的 toast 反馈结果）。
 * selfWrite 只在编辑页打开时有意义：列表页自己的写操作本来就该重拉。
 */
export function changedAction(input: {
  editorOpen: boolean
  formDirty: boolean
  selfWrite?: boolean
}): "refetch" | "notify" | "ignore" {
  if (!input.editorOpen) return "refetch"
  return input.selfWrite === true ? "ignore" : "notify"
}

export interface AgentRowState {
  /** 行内「已停用」徽标是否显示 */
  showDisabledBadge: boolean
  /** 启用开关是否处于打开态（checked = 启用；与数据层 disabled 相反） */
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
 *
 * 开关语义（2026-11-07 用户决定）：开关是「启用」开关，遵循宿主惯例
 * 蓝色（checked）= 启用；停用时开关回落白色 + 整行变暗 + 「已停用」徽标。
 * 因此 switchChecked = !disabled，onChange 侧用 switchEventToDisabled 做逆映射。
 */
export function agentRowState(agent: { disabled?: boolean }): AgentRowState {
  const disabled = normalizeFlag(agent.disabled)
  return { showDisabledBadge: disabled, switchChecked: !disabled, dimmed: disabled }
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
