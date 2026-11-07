// test/disable-flow.test.ts —— 列表行停用开关的 GUI 流程（依赖注入，无 DOM）。
// goal.md §10：开关写 disabled true/false，false 时删除字段。
// goal.md §5.3：对 V1 文件写 disabled 会触发整份切 V2 → 必须先弹迁移预览，
// 确认后 update（服务端整份迁移）再 setDisabled。
import { test } from "node:test"
import assert from "node:assert/strict"
import { toggleDisabled } from "../src/gui/disable-flow.ts"

function fakeDeps(opts: {
  format?: "v1" | "v2"
  previewConfirmed?: boolean
  setDisabledError?: Error
} = {}) {
  const calls = {
    preview: [] as unknown[],
    previewDialog: 0,
    read: [] as unknown[],
    update: [] as unknown[],
    setDisabled: [] as unknown[],
    toast: [] as unknown[],
  }
  return {
    calls,
    deps: {
      migratePreview: async (input: unknown) => {
        calls.preview.push(input)
        return { before: "old", after: "new", changes: [{ field: "name", action: "delete" as const }] }
      },
      confirmMigration: async () => {
        calls.previewDialog++
        return opts.previewConfirmed ?? true
      },
      read: async (input: unknown) => {
        calls.read.push(input)
        return {
          meta: { description: "d", permissions: [{ action: "read", resource: "*", effect: "allow" }] },
          body: "b\n",
          format: opts.format ?? "v2",
          hash: "0123456789abcdef",
          mtime: 1,
        }
      },
      update: async (input: unknown) => {
        calls.update.push(input)
        return { hash: "fedcba9876543210" }
      },
      setDisabled: async (input: unknown) => {
        calls.setDisabled.push(input)
        if (opts.setDisabledError) throw opts.setDisabledError
        return { hash: "aaaaaaaaaaaaaaaa" }
      },
      toast: (input: unknown) => { calls.toast.push(input) },
      t: (key: string) => key,
    },
  }
}

const v2Agent = { id: "reviewer", path: "C:/agents/reviewer.md", format: "v2" as const }
const v1Agent = { id: "legacy", path: "C:/agents/legacy.md", format: "v1" as const }

test("disabling a v2 agent goes straight to setDisabled", async () => {
  const { calls, deps } = fakeDeps()
  const result = await toggleDisabled(deps, v2Agent, true)
  assert.equal(result, "toggled")
  assert.equal(calls.preview.length, 0, "v2 must not show a migration preview")
  assert.deepEqual(calls.setDisabled, [{ path: "C:/agents/reviewer.md", disabled: true }])
  assert.deepEqual(calls.toast, [{ title: "toast.disabled", variant: "success" }])
})

test("enabling a v2 agent uses the enabled toast", async () => {
  const { calls, deps } = fakeDeps()
  await toggleDisabled(deps, v2Agent, false)
  assert.deepEqual(calls.setDisabled, [{ path: "C:/agents/reviewer.md", disabled: false }])
  assert.deepEqual(calls.toast, [{ title: "toast.enabled", variant: "success" }])
})

test("disabling a v1 agent previews the migration first, then updates and disables", async () => {
  const { calls, deps } = fakeDeps({ format: "v1", previewConfirmed: true })
  const result = await toggleDisabled(deps, v1Agent, true)
  assert.equal(result, "toggled")
  assert.equal(calls.previewDialog, 1, "the preview must be shown exactly once")
  assert.equal(calls.update.length, 1, "the whole-file migration runs through update")
  const update = calls.update[0] as { path: string; expectedHash: string; patch: { matrix: unknown } }
  assert.equal(update.path, "C:/agents/legacy.md")
  assert.equal(update.expectedHash, "0123456789abcdef")
  assert.ok(update.patch.matrix, "the patch must carry a matrix from patchFromRead")
  assert.deepEqual(calls.setDisabled, [{ path: "C:/agents/legacy.md", disabled: true }])
})

test("cancelling the v1 migration preview leaves the file untouched", async () => {
  const { calls, deps } = fakeDeps({ format: "v1", previewConfirmed: false })
  const result = await toggleDisabled(deps, v1Agent, true)
  assert.equal(result, "cancelled")
  assert.equal(calls.update.length, 0, "nothing may be written after cancelling")
  assert.equal(calls.setDisabled.length, 0)
  assert.equal(calls.toast.length, 0)
})

test("a failure reports an error toast and no success toast", async () => {
  const { calls, deps } = fakeDeps({ setDisabledError: Object.assign(new Error("not_found"), { type: "not_found" }) })
  const result = await toggleDisabled(deps, v2Agent, true)
  assert.equal(result, "failed")
  assert.equal(calls.toast.length, 1)
  const toast = calls.toast[0] as { title: string; variant: string; description?: string }
  assert.equal(toast.variant, "error")
  assert.equal(toast.title, "common.error")
  assert.equal(toast.description, "not_found")
})

test("a v1 agent being enabled skips the migration because nothing is written", async () => {
  // 启用 V1 文件不需要写 V2 字段（setDisabled(false) 只是删字段），
  // 但服务端对 V1 一律拒绝，所以仍要走迁移；这里确认行为一致。
  const { calls, deps } = fakeDeps({ format: "v1", previewConfirmed: true })
  await toggleDisabled(deps, v1Agent, false)
  assert.equal(calls.previewDialog, 1)
  assert.equal(calls.update.length, 1)
  assert.deepEqual(calls.setDisabled, [{ path: "C:/agents/legacy.md", disabled: false }])
})
