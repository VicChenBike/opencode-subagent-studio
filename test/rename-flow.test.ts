// test/rename-flow.test.ts —— 重命名流程（依赖注入，无 DOM）。
// goal.md §6.1：改 ID 会让其他代理或提示词里的引用失效，必须二次确认。
import { test } from "node:test"
import assert from "node:assert/strict"
import { renameAgent, renameConfirmCopy, validateNewId } from "../src/gui/rename-flow.ts"

function fakeDeps(opts: { confirmed?: boolean; renameError?: Error } = {}) {
  const calls = { confirm: [] as unknown[], rename: [] as unknown[], toast: [] as unknown[] }
  return {
    calls,
    deps: {
      confirm: async (input: unknown) => { calls.confirm.push(input); return opts.confirmed ?? true },
      rename: async (input: unknown) => {
        calls.rename.push(input)
        if (opts.renameError) throw opts.renameError
        return { path: "C:/agents/new-id.md" }
      },
      toast: (input: unknown) => { calls.toast.push(input) },
      t: (key: string, params?: Record<string, string | number | boolean>) =>
        params ? `${key}|${JSON.stringify(params)}` : key,
    },
  }
}

test("renameConfirmCopy warns that the agent id will change", () => {
  const copy = renameConfirmCopy((k, p) => (p ? `${k}|${JSON.stringify(p)}` : k), "old-id")
  assert.equal(copy.title, "editor.rename.title")
  assert.equal(copy.description, "editor.rename.desc")
  assert.equal(copy.danger, true, "renaming breaks references, so style it as destructive")
})

test("validateNewId rejects an invalid pattern", () => {
  assert.equal(validateNewId("Bad_Id", "old"), "invalid")
  assert.equal(validateNewId("", "old"), "invalid")
  assert.equal(validateNewId("a/b", "old"), "invalid")
})

test("validateNewId rejects reserved ids", () => {
  assert.equal(validateNewId("general", "old"), "reserved")
  assert.equal(validateNewId("build", "old"), "reserved")
})

test("validateNewId rejects an unchanged id", () => {
  assert.equal(validateNewId("same", "same"), "unchanged")
})

test("validateNewId accepts a fresh valid id", () => {
  assert.equal(validateNewId("new-id", "old"), undefined)
  assert.equal(validateNewId("a", "old"), undefined)
})

test("renameAgent confirms, renames, and reports success", async () => {
  const { calls, deps } = fakeDeps()
  const result = await renameAgent(deps, { id: "old-id", path: "C:/agents/old-id.md" }, "new-id")
  assert.equal(result, "renamed")
  assert.equal(calls.confirm.length, 1)
  assert.deepEqual(calls.rename, [{ path: "C:/agents/old-id.md", newId: "new-id" }])
  assert.deepEqual(calls.toast, [{ title: "toast.renamed", variant: "success" }])
})

test("renameAgent does nothing when the user cancels", async () => {
  const { calls, deps } = fakeDeps({ confirmed: false })
  const result = await renameAgent(deps, { id: "old-id", path: "C:/agents/old-id.md" }, "new-id")
  assert.equal(result, "cancelled")
  assert.equal(calls.rename.length, 0)
  assert.equal(calls.toast.length, 0)
})

test("renameAgent refuses to call the RPC for an invalid id", async () => {
  const { calls, deps } = fakeDeps()
  const result = await renameAgent(deps, { id: "old-id", path: "C:/agents/old-id.md" }, "general")
  assert.equal(result, "invalid")
  assert.equal(calls.rename.length, 0, "a reserved id must never reach the server")
  assert.equal(calls.confirm.length, 0, "no point confirming an invalid id")
})

test("renameAgent surfaces a target-exists failure", async () => {
  const { calls, deps } = fakeDeps({
    renameError: Object.assign(new Error("target already exists"), { type: "exists" }),
  })
  const result = await renameAgent(deps, { id: "old-id", path: "C:/agents/old-id.md" }, "taken")
  assert.equal(result, "failed")
  const toast = calls.toast[0] as { title: string; variant: string; description?: string }
  assert.equal(toast.variant, "error")
  assert.equal(toast.description, "target already exists")
})

test("a successful rename returns the new path so the caller can follow it", async () => {
  const { deps } = fakeDeps()
  const result = await renameAgent(deps, { id: "old-id", path: "C:/agents/old-id.md" }, "new-id")
  assert.equal(result, "renamed")
})
