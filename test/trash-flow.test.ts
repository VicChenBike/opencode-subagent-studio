// test/trash-flow.test.ts —— 回收站删除的 GUI 流程（可注入依赖，无需 DOM）。
// goal.md §10：二次确认 → 移入同级 agents-trash → toast → 列表重拉 / 返回列表。
import { test } from "node:test"
import assert from "node:assert/strict"
import { trashAgent, deleteConfirmCopy } from "../src/gui/trash-flow.ts"

function fakeDeps(opts: {
  confirmed?: boolean
  removeError?: Error
} = {}) {
  const calls = {
    confirm: [] as unknown[],
    remove: [] as unknown[],
    toast: [] as unknown[],
  }
  return {
    calls,
    deps: {
      confirm: async (input: unknown) => {
        calls.confirm.push(input)
        return opts.confirmed ?? true
      },
      remove: async (input: unknown) => {
        calls.remove.push(input)
        if (opts.removeError) throw opts.removeError
        return { trashPath: "C:/trash/x.md" }
      },
      toast: (input: unknown) => {
        calls.toast.push(input)
      },
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
    },
  }
}

const agent = { id: "reviewer", path: "C:/agents/reviewer.md" }

test("deleteConfirmCopy asks for confirmation with the agent id in the body", () => {
  const copy = deleteConfirmCopy((k, p) => (p ? `${k}|${JSON.stringify(p)}` : k), "reviewer")
  assert.equal(copy.title, "list.delete.title")
  assert.equal(copy.description, 'list.delete.desc|{"id":"reviewer"}')
  assert.equal(copy.danger, true, "trashing must be styled as destructive")
})

test("trashAgent confirms, calls remove, then reports the success toast", async () => {
  const { calls, deps } = fakeDeps({ confirmed: true })
  const result = await trashAgent(deps, agent)
  assert.equal(result, "deleted")
  assert.equal(calls.confirm.length, 1)
  assert.deepEqual(calls.remove, [{ path: "C:/agents/reviewer.md" }])
  assert.deepEqual(calls.toast, [{ title: "toast.deleted", variant: "success" }])
})

test("trashAgent does nothing when the user cancels", async () => {
  const { calls, deps } = fakeDeps({ confirmed: false })
  const result = await trashAgent(deps, agent)
  assert.equal(result, "cancelled")
  assert.equal(calls.remove.length, 0, "remove must not run after cancelling")
  assert.equal(calls.toast.length, 0)
})

test("trashAgent reports the failure without a success toast", async () => {
  const { calls, deps } = fakeDeps({ confirmed: true, removeError: new Error("not_found") })
  const result = await trashAgent(deps, agent)
  assert.equal(result, "failed")
  assert.equal(calls.toast.length, 1)
  const toast = calls.toast[0] as { title: string; variant: string; description?: string }
  assert.equal(toast.variant, "error")
  assert.equal(toast.title, "common.error")
  // 裸 Error 没有 type 字段，无从映射错误码，保留原始 message
  assert.equal(toast.description, "not_found")
})

test("trashAgent surfaces the host error message, not an object dump", async () => {
  const { calls, deps } = fakeDeps({
    confirmed: true,
    removeError: Object.assign(new Error("path outside allowed roots"), { type: "invalid_path" }),
  })
  await trashAgent(deps, agent)
  const toast = calls.toast[0] as { description: string }
  // invalid_path 有专门文案（P3-T8）
  assert.equal(toast.description, "error.invalidPath")
})

test("trashAgent falls back to the raw message for codes without copy", async () => {
  const { calls, deps } = fakeDeps({
    confirmed: true,
    removeError: Object.assign(new Error("bad id"), { type: "invalid_id" }),
  })
  await trashAgent(deps, agent)
  const toast = calls.toast[0] as { description: string }
  assert.equal(toast.description, "bad id", "codes without dedicated copy keep the server message")
})

test("the success toast is only emitted once per delete", async () => {
  const { calls, deps } = fakeDeps({ confirmed: true })
  await trashAgent(deps, agent)
  assert.equal(calls.toast.filter((x) => (x as { variant: string }).variant === "success").length, 1)
})
