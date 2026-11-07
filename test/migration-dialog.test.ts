// test/migration-dialog.test.ts —— 迁移预览弹窗的纯逻辑（changes → i18n 键）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { changeLabelKey, changeLines, shouldPromptMigration, saveStep } from "../src/gui/migration-logic.ts"
import type { MigrateChange } from "../src/rpc.ts"

const change = (field: string, action: MigrateChange["action"] = "convert"): MigrateChange => ({ field, action })

test("changeLabelKey maps every goal.md 9.2 row to its copy key", () => {
  assert.equal(changeLabelKey(change("name", "delete")), "migrate.change.name")
  assert.equal(changeLabelKey(change("permission")), "migrate.change.permission")
  assert.equal(changeLabelKey(change("disable", "rename")), "migrate.change.disable")
  assert.equal(changeLabelKey(change("model", "merge")), "migrate.change.model")
  assert.equal(changeLabelKey(change("temperature", "delete")), "migrate.change.temperature")
  assert.equal(changeLabelKey(change("top_p", "delete")), "migrate.change.temperature")
  assert.equal(changeLabelKey(change("options", "delete")), "migrate.change.temperature")
  assert.equal(changeLabelKey(change("tools")), "migrate.change.tools")
  assert.equal(changeLabelKey(change("maxSteps", "rename")), "migrate.change.maxSteps")
  assert.equal(changeLabelKey(change("prompt", "merge")), "migrate.change.prompt")
})

test("changeLabelKey falls back to the generic copy for unknown fields", () => {
  assert.equal(changeLabelKey(change("some-future-field")), "migrate.change.other")
  assert.equal(changeLabelKey(change("steps")), "migrate.change.other")
})

test("changeLines keeps order and resolves one key per change", () => {
  const changes: MigrateChange[] = [
    change("name", "delete"),
    change("permission"),
    change("maxSteps", "rename"),
  ]
  assert.deepEqual(changeLines(changes), [
    "migrate.change.name",
    "migrate.change.permission",
    "migrate.change.maxSteps",
  ])
})

test("changeLines returns an empty list when nothing changes", () => {
  assert.deepEqual(changeLines([]), [])
})

// goal.md 9.1：只有 V1 文件且尚未确认迁移时才弹预览
test("shouldPromptMigration only fires for a v1 file that has not been confirmed", () => {
  assert.equal(shouldPromptMigration({ format: "v1", migrateConfirmed: false }), true)
  assert.equal(shouldPromptMigration({ format: "v1", migrateConfirmed: true }), false)
  assert.equal(shouldPromptMigration({ format: "v2", migrateConfirmed: false }), false)
  assert.equal(shouldPromptMigration({ format: "v2", migrateConfirmed: true }), false)
})

// R4 修复：迁移预览不能把保存流程挂在一个永不 resolve 的 Promise 上。
// 宿主 Ui.Dialog 的 closable={false} 只隐藏关闭按钮，Esc 与点外仍会关闭且没有回调，
// 所以流程必须是「先弹预览、确认后才保存」，而不是 await 预览结果。
test("saveStep asks for a preview first, then saves once confirmed", () => {
  assert.equal(saveStep({ mode: "edit", format: "v1", migrateConfirmed: false }), "preview")
  assert.equal(saveStep({ mode: "edit", format: "v1", migrateConfirmed: true }), "save")
})

test("saveStep never asks for a preview for v2 files or for a new agent", () => {
  assert.equal(saveStep({ mode: "edit", format: "v2", migrateConfirmed: false }), "save")
  assert.equal(saveStep({ mode: "create", format: "v1", migrateConfirmed: false }), "save")
})
