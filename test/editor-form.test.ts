// test/editor-form.test.ts —— 编辑表单的纯逻辑：模型串拆合、patch 构造、校验。
// GUI 组件本身无法在 node --test 里渲染，把可判定的逻辑抽出来单测。
import { test } from "node:test"
import assert from "node:assert/strict"
import { splitModelRef, buildPatch, optionalFieldsOf, validateEditor, patchFromRead, conflictAction } from "../src/gui/editor-form.ts"
import type { ReadOutput } from "../src/rpc.ts"

const MATRIX = {
  defaultEffect: "allow" as const,
  actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow", shell: "allow",
    webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } as const,
}

test("splitModelRef separates provider/model from the variant", () => {
  assert.deepEqual(splitModelRef("acme/standard#high"), { model: "acme/standard", variant: "high" })
  assert.deepEqual(splitModelRef("acme/standard"), { model: "acme/standard", variant: undefined })
  assert.deepEqual(splitModelRef(undefined), { model: undefined, variant: undefined })
  assert.deepEqual(splitModelRef(""), { model: undefined, variant: undefined })
})

test("buildPatch joins model and variant into provider/model#variant", () => {
  const patch = buildPatch({ description: "d", body: "b", model: "acme/standard", variant: "high", matrix: MATRIX })
  assert.equal(patch.model, "acme/standard#high")
  const plain = buildPatch({ description: "d", body: "b", model: "acme/standard", matrix: MATRIX })
  assert.equal(plain.model, "acme/standard")
  const inherit = buildPatch({ description: "d", body: "b", matrix: MATRIX })
  assert.equal(inherit.model, undefined)
})

test("buildPatch drops hidden when false and parses steps", () => {
  const off = buildPatch({ description: "d", body: "b", hidden: false, matrix: MATRIX })
  assert.equal(off.hidden, undefined)
  const on = buildPatch({ description: "d", body: "b", hidden: true, matrix: MATRIX })
  assert.equal(on.hidden, true)
  const noSteps = buildPatch({ description: "d", body: "b", stepsText: "", matrix: MATRIX })
  assert.equal(noSteps.steps, undefined)
  const steps = buildPatch({ description: "d", body: "b", stepsText: "8", matrix: MATRIX })
  assert.equal(steps.steps, 8)
})

test("optionalFieldsOf omits absent values so RPC input stays schema-clean", () => {
  const fields = optionalFieldsOf({ description: "d", body: "b", matrix: MATRIX })
  assert.deepEqual(Object.keys(fields).sort(), ["body", "description", "matrix"])
  const full = optionalFieldsOf({ description: "d", body: "b", model: "a/b", color: "#fff", hidden: true, steps: 2, matrix: MATRIX })
  assert.deepEqual(Object.keys(full).sort(), ["body", "color", "description", "hidden", "matrix", "model", "steps"])
})

test("validateEditor flags invalid, reserved and duplicate ids", () => {
  assert.equal(validateEditor({ mode: "create", id: "Bad_Id", description: "d", stepsText: "", existingIds: [] }).idError, "invalid")
  assert.equal(validateEditor({ mode: "create", id: "general", description: "d", stepsText: "", existingIds: [] }).idError, "reserved")
  assert.equal(validateEditor({ mode: "create", id: "taken", description: "d", stepsText: "", existingIds: ["taken"] }).idError, "duplicate")
  assert.equal(validateEditor({ mode: "create", id: "fresh", description: "d", stepsText: "", existingIds: [] }).idError, undefined)
  // 编辑模式不校验 id
  assert.equal(validateEditor({ mode: "edit", id: "general", description: "d", stepsText: "", existingIds: [] }).idError, undefined)
})

test("validateEditor requires a description and a positive integer step count", () => {
  assert.equal(validateEditor({ mode: "create", id: "fresh", description: "  ", stepsText: "", existingIds: [] }).descriptionError, "required")
  assert.equal(validateEditor({ mode: "create", id: "fresh", description: "d", stepsText: "0", existingIds: [] }).stepsError, "invalid")
  assert.equal(validateEditor({ mode: "create", id: "fresh", description: "d", stepsText: "-2", existingIds: [] }).stepsError, "invalid")
  assert.equal(validateEditor({ mode: "create", id: "fresh", description: "d", stepsText: "1.5", existingIds: [] }).stepsError, "invalid")
  assert.equal(validateEditor({ mode: "create", id: "fresh", description: "d", stepsText: "8", existingIds: [] }).stepsError, undefined)
})

test("validateEditor reports canSave false while loading", () => {
  const ok = validateEditor({ mode: "create", id: "fresh", description: "d", stepsText: "", existingIds: [] })
  assert.equal(ok.canSave, true)
  const loading = validateEditor({ mode: "edit", id: "x", description: "d", stepsText: "", existingIds: [], loading: true })
  assert.equal(loading.canSave, false)
})

// P2-T4 复用要求：从 read 结果构造「内容不变」的 patch（V1 开关迁移路径）
test("patchFromRead builds an unchanged patch from a read result", () => {
  const res: ReadOutput = {
    meta: {
      description: "D",
      model: "acme/standard#high",
      color: "#ff0000",
      hidden: true,
      steps: 4,
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    },
    body: "the body\n",
    format: "v2",
    hash: "0123456789abcdef",
    mtime: 1,
  }
  const patch = patchFromRead(res)
  assert.equal(patch.description, "D")
  assert.equal(patch.body, "the body\n")
  assert.equal(patch.model, "acme/standard#high")
  assert.equal(patch.color, "#ff0000")
  assert.equal(patch.hidden, true)
  assert.equal(patch.steps, 4)
  assert.equal(patch.matrix.defaultEffect, "allow")
})

test("patchFromRead reads a v1 permission map", () => {
  const res: ReadOutput = {
    meta: { description: "D", permission: { read: "allow", edit: "deny" } },
    body: "b\n",
    format: "v1",
    hash: "0123456789abcdef",
    mtime: 1,
  }
  const patch = patchFromRead(res)
  assert.equal(patch.matrix.actions.read, "allow")
  assert.equal(patch.matrix.actions.edit, "deny")
})

// 中期审查 P2-1：冲突弹窗选「重新加载」后必须离开编辑页。
// 否则页面停留在旧 hash 上，再点保存必然再次冲突。
test("conflictAction sends reload back to the list and only overwrite stays", () => {
  assert.equal(conflictAction("reload"), "back")
  assert.equal(conflictAction(undefined), "back", "dismissing the dialog must also leave")
  assert.equal(conflictAction("overwrite"), "overwrite")
})
