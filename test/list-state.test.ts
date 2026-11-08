// test/list-state.test.ts —— 列表页视图状态推导（纯逻辑，无 DOM）。
// 桌面端实测（2026-11-07）：list RPC 返回 500 时，页面整页空白。
// 资源错误必须落到显式的错误态，而不是渲染成空列表或永远 loading。
import { test } from "node:test"
import assert from "node:assert/strict"
import { listViewState, errorMessage } from "../src/gui/list-state.ts"
import type { AgentSummary } from "../src/rpc.ts"

const agent = (id: string): AgentSummary => ({
  id,
  path: `/agents/${id}.md`,
  description: id,
  disabled: false,
  hidden: false,
  format: "v1",
  hash: "0123456789abcdef",
  mtime: 1,
})

test("error wins over everything else once loading has finished", () => {
  const state = listViewState({ loading: false, error: new Error("boom"), agents: [], query: "" })
  assert.equal(state.kind, "error")
  assert.equal(state.kind === "error" && state.message, "boom")
})

// 第十二轮 G-12-5：切作用域时 error 仍是上一个作用域的旧值，
// 加载新来源期间不能显示旧错误视图（旧断言「error while still loading is still an error」已作废）。
test("a stale error yields to loading while the new source is still being fetched", () => {
  const state = listViewState({ loading: true, error: new Error("boom"), agents: [], query: "" })
  assert.equal(state.kind, "loading")
})

test("loading without error is the loading state", () => {
  assert.equal(listViewState({ loading: true, error: undefined, agents: [], query: "" }).kind, "loading")
})

test("no agents and no query is the plain empty state", () => {
  assert.equal(listViewState({ loading: false, error: undefined, agents: [], query: "" }).kind, "empty")
  assert.equal(listViewState({ loading: false, error: undefined, agents: [], query: "   " }).kind, "empty")
})

test("no matching agents with a query is the search empty state", () => {
  const state = listViewState({ loading: false, error: undefined, agents: [], query: "zzz" })
  assert.equal(state.kind, "emptySearch")
  assert.equal(state.kind === "emptySearch" && state.query, "zzz")
})

test("agents present yield rows", () => {
  const state = listViewState({ loading: false, error: undefined, agents: [agent("a")], query: "" })
  assert.equal(state.kind, "rows")
  assert.equal(state.kind === "rows" && state.agents.length, 1)
})

test("errorMessage reads Error, string and unknown values", () => {
  assert.equal(errorMessage(new Error("disk gone")), "disk gone")
  assert.equal(errorMessage("plain text"), "plain text")
  assert.equal(errorMessage({ type: "rpc.invalid_output", message: "Expected string" }), "Expected string")
  assert.equal(errorMessage(null), "")
  assert.equal(errorMessage(undefined), "")
  assert.equal(errorMessage(42), "42")
})

test("listViewState keeps the error message for the UI to show", () => {
  const state = listViewState({
    loading: false,
    error: { type: "rpc.invalid_output", message: "Expected string at agents[1].color" },
    agents: [],
    query: "",
  })
  assert.equal(state.kind, "error")
  assert.equal(state.kind === "error" && state.message, "Expected string at agents[1].color")
})

// ---------- P3-T3：changed 事件到达时的处置 ----------
import { changedAction } from "../src/gui/list-state.ts"

test("changed refetches the list when no editor is open", () => {
  assert.equal(changedAction({ editorOpen: false, formDirty: false }), "refetch")
  assert.equal(changedAction({ editorOpen: false, formDirty: true }), "refetch")
})

test("changed never overwrites an open editor, it only notifies", () => {
  assert.equal(changedAction({ editorOpen: true, formDirty: false }), "notify")
  assert.equal(changedAction({ editorOpen: true, formDirty: true }), "notify")
})
