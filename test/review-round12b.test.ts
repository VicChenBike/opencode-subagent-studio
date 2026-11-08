// test/review-round12b.test.ts —— 第十二轮 GUI 审查回归（2026-11-08）。
// 覆盖可测纯逻辑：G-12-4/5 列表视图优先级、G-12-3 自致 changed 事件、
// G-12-6 行级 in-flight 登记、G-12-7 模型弹窗单开守卫、
// G-12-8 read 装载时的非法 color/model 净化、G-12-9 表单 dirty 判定、
// G-12-10→R-12-1 model-picker-logic 与宿主首斜杠切分语义一致。
// 先写测试后修实现（TDD）：这些用例在修复前应当失败，修复后必须全绿。
import { test } from "node:test"
import assert from "node:assert/strict"
import { listViewState, changedAction } from "../src/gui/list-state.ts"
import {
  buildPatch,
  patchFromRead,
  sanitizeLoadedColor,
  sanitizeLoadedModelRef,
  formValuesEqual,
  type EditorFormValues,
} from "../src/gui/editor-form.ts"
import {
  filterProviders,
  providerOfModel,
  variantsOf,
  modelPartsOf,
  acquirePickerGuard,
  releasePickerGuard,
  renewPickerGuard,
  resetPickerGuard,
} from "../src/gui/model-picker-logic.ts"
import { beginInFlight, endInFlight, isInFlight, resetInFlight } from "../src/gui/inflight.ts"
import { ACTIONS } from "../src/rpc.ts"
import type { AgentSummary, PermissionMatrix, ProviderSummary } from "../src/rpc.ts"

const agent = (id: string): AgentSummary => ({
  id,
  path: `/agents/${id}.md`,
  description: id,
  disabled: false,
  hidden: false,
  format: "v2",
  hash: "0123456789abcdef",
  mtime: 1,
})

const MATRIX: PermissionMatrix = {
  defaultEffect: "allow",
  actions: Object.fromEntries(ACTIONS.map((a) => [a, "allow"])) as PermissionMatrix["actions"],
}

// ---------- G-12-4：refetch 期间保持现有行，不闪 Loader ----------

test("R12b-G4a: a refetch with existing rows keeps rendering the rows", () => {
  const state = listViewState({
    loading: true,
    error: undefined,
    agents: [agent("a")],
    query: "",
    hasData: true,
  })
  assert.equal(state.kind, "rows")
})

test("R12b-G4b: a refetch with previously loaded empty data keeps the empty state", () => {
  const state = listViewState({
    loading: true,
    error: undefined,
    agents: [],
    query: "",
    hasData: true,
  })
  assert.equal(state.kind, "empty", "a loaded empty scope must not flash the loader on refetch")
})

test("R12b-G4c: the first load (no data yet) still shows the loader", () => {
  const state = listViewState({
    loading: true,
    error: undefined,
    agents: [],
    query: "",
    hasData: false,
  })
  assert.equal(state.kind, "loading")
})

test("R12b-G4d: omitting hasData keeps the old first-load behaviour", () => {
  assert.equal(listViewState({ loading: true, error: undefined, agents: [], query: "" }).kind, "loading")
})

// ---------- G-12-5：loading 期间不得显示上一个作用域的旧错误 ----------

test("R12b-G5a: a stale error is not shown while the new scope is still loading", () => {
  const state = listViewState({
    loading: true,
    error: new Error("old scope exploded"),
    agents: [],
    query: "",
    hasData: false,
  })
  assert.equal(state.kind, "loading")
})

test("R12b-G5b: a stale error does not replace existing rows during a refetch", () => {
  const state = listViewState({
    loading: true,
    error: new Error("old scope exploded"),
    agents: [agent("a")],
    query: "",
    hasData: true,
  })
  assert.equal(state.kind, "rows")
})

test("R12b-G5c: once loading ends the error is shown again", () => {
  const state = listViewState({
    loading: false,
    error: new Error("boom"),
    agents: [],
    query: "",
    hasData: false,
  })
  assert.equal(state.kind, "error")
  assert.equal(state.kind === "error" && state.message, "boom")
})

// ---------- G-12-3：编辑页自致写操作的 changed 事件必须被忽略 ----------

test("R12b-G3a: a changed event caused by the editor itself is ignored", () => {
  assert.equal(
    changedAction({ editorOpen: true, formDirty: true, selfWrite: true }),
    "ignore",
  )
})

test("R12b-G3b: an external change with the editor open still notifies", () => {
  assert.equal(changedAction({ editorOpen: true, formDirty: true, selfWrite: false }), "notify")
})

test("R12b-G3c: a self-write with no editor open still refetches the list", () => {
  assert.equal(changedAction({ editorOpen: false, formDirty: false, selfWrite: true }), "refetch")
})

test("R12b-G3d: omitting selfWrite keeps the round-11 behaviour", () => {
  assert.equal(changedAction({ editorOpen: true, formDirty: true }), "notify")
  assert.equal(changedAction({ editorOpen: false, formDirty: false }), "refetch")
})

// ---------- G-12-6：行级 in-flight 必须是模块级、按 path 键的登记 ----------

test("R12b-G6: the in-flight registry survives a row remount and blocks a second toggle", () => {
  resetInFlight()
  const key = "/agents/a.md"
  assert.equal(isInFlight(key), false)
  assert.equal(beginInFlight(key), true, "the first toggle acquires the slot")
  assert.equal(isInFlight(key), true)
  // 行组件被 refetch 重挂载后仍能看见同一条登记（模块级状态，不随实例归零）
  assert.equal(beginInFlight(key), false, "a second toggle on the same path must be refused")
  endInFlight(key)
  assert.equal(isInFlight(key), false, "finishing the flow releases the slot")
  assert.equal(beginInFlight(key), true, "the row can be toggled again afterwards")
  endInFlight(key)
})

test("R12b-G6b: different paths do not block each other", () => {
  resetInFlight()
  assert.equal(beginInFlight("/agents/a.md"), true)
  assert.equal(beginInFlight("/agents/b.md"), true)
  endInFlight("/agents/a.md")
  endInFlight("/agents/b.md")
  assert.equal(isInFlight("/agents/a.md"), false)
})

// ---------- G-12-7：模型弹窗单开守卫 ----------

test("R12b-G7: the model picker guard refuses a second open until released", () => {
  resetPickerGuard()
  assert.equal(acquirePickerGuard(), true, "the first double-click opens one dialog")
  assert.equal(acquirePickerGuard(), false, "the second click must be swallowed")
  releasePickerGuard()
  assert.equal(acquirePickerGuard(), true, "after closing the picker can open again")
  releasePickerGuard()
})

// 宿主把弹窗渲染延到 transition：若 owner 在此之前结束，弹窗永不渲染、onCleanup 不跑，
// 纯布尔锁会把模型弹窗永久锁死。守卫因此带 TTL，残留占用超时后可重新获取。
test("R12b-G7b: a stale guard does not lock the picker forever", () => {
  resetPickerGuard()
  assert.equal(acquirePickerGuard(1_000), true)
  assert.equal(acquirePickerGuard(1_500), false, "within the TTL the second click is still swallowed")
  assert.equal(acquirePickerGuard(10_000), true, "a stale hold is reclaimed")
  releasePickerGuard()
})

// 已经渲染出来的弹窗必须一直持锁：否则开着的弹窗超过 TTL 后再点一次会叠出第二个。
test("R12b-G7c: a rendered picker holds the guard past the TTL", () => {
  resetPickerGuard()
  assert.equal(acquirePickerGuard(1_000), true)
  renewPickerGuard()
  assert.equal(acquirePickerGuard(60_000), false, "a rendered dialog still blocks a second open")
  releasePickerGuard()
  assert.equal(acquirePickerGuard(60_000), true, "closing releases the guard")
  releasePickerGuard()
})

// ---------- G-12-8：read 装载时净化非法 color / model ----------

test("R12b-G8a: a valid hex color is kept, anything else is treated as unset", () => {
  assert.equal(sanitizeLoadedColor("#ff0000"), "#ff0000")
  assert.equal(sanitizeLoadedColor("#FFAA00"), "#FFAA00", "hex colors are case-insensitive")
  assert.equal(sanitizeLoadedColor("#f00"), undefined, "three-digit hex is not a valid agent color")
  assert.equal(sanitizeLoadedColor("red"), undefined)
  assert.equal(sanitizeLoadedColor("#gggggg"), undefined)
  assert.equal(sanitizeLoadedColor(undefined), undefined)
  assert.equal(sanitizeLoadedColor(42), undefined)
})

test("R12b-G8b: a malformed model reference is treated as unset; nested model ids are kept", () => {
  assert.deepEqual(sanitizeLoadedModelRef({ model: "acme/standard#high" }, "v2"), {
    model: "acme/standard",
    variant: "high",
  })
  assert.deepEqual(sanitizeLoadedModelRef({ model: "acme/standard", variant: "high" }, "v1"), {
    model: "acme/standard",
    variant: "high",
  })
  // R-12-1：modelID 含 "/" 是宿主合法引用（首斜杠切分），不得被净化掉
  assert.deepEqual(sanitizeLoadedModelRef({ model: "acme/org/mini" }, "v2"), {
    model: "acme/org/mini",
    variant: undefined,
  })
  // 真坏值（服务端 parseModelRef 拒绝的形态）：GUI 不能把它们显示成已设置，否则首次保存必被 invalid_format 拒绝
  assert.deepEqual(sanitizeLoadedModelRef({ model: "noslash" }, "v2"), {
    model: undefined,
    variant: undefined,
  })
  assert.deepEqual(sanitizeLoadedModelRef({ model: "acme/standard#high#low" }, "v2"), {
    model: undefined,
    variant: undefined,
  })
  assert.deepEqual(sanitizeLoadedModelRef({ model: 42 }, "v2"), { model: undefined, variant: undefined })
  assert.deepEqual(sanitizeLoadedModelRef({}, "v2"), { model: undefined, variant: undefined })
})

test("R12b-G8c: the sanitized values produce a patch without the illegal keys (server deletes them)", () => {
  // R-12-1：多斜杠 model id 不净化，原样进入 patch
  const nested = sanitizeLoadedModelRef({ model: "acme/org/mini" }, "v2")
  const nestedPatch = buildPatch({
    description: "d",
    body: "b\n",
    model: nested.model,
    variant: nested.variant,
    color: undefined,
    matrix: MATRIX,
  })
  assert.equal(nestedPatch.model, "acme/org/mini", "a nested model ref must survive into the patch")

  const ref = sanitizeLoadedModelRef({ model: "noslash" }, "v2")
  const patch = buildPatch({
    description: "d",
    body: "b\n",
    model: ref.model,
    variant: ref.variant,
    color: sanitizeLoadedColor("red"),
    matrix: MATRIX,
  })
  assert.equal("model" in patch, false, "an illegal model must be removed on the first save")
  assert.equal("color" in patch, false, "an illegal color must be removed on the first save")
})

// V1 开关迁移路径用 patchFromRead 原样回写整份文件：非法 color / model 必须在
// 这一步就被剔除，否则迁移本身会以 invalid_format 失败，用户连停用都做不到。
test("R12b-G8d: patchFromRead drops illegal color and model values", () => {
  const bad = patchFromRead({
    meta: { description: "D", model: "noslash", color: "red", steps: 2 },
    body: "b\n",
    format: "v2",
    hash: "0123456789abcdef",
    mtime: 1,
  })
  assert.equal("model" in bad, false)
  assert.equal("color" in bad, false)
  assert.equal(bad.steps, 2, "legal fields are untouched")

  // R-12-1：多斜杠 model id 是宿主合法引用，原样回写
  const nested = patchFromRead({
    meta: { description: "D", model: "acme/org/mini", steps: 2 },
    body: "b\n",
    format: "v2",
    hash: "0123456789abcdef",
    mtime: 1,
  })
  assert.equal(nested.model, "acme/org/mini")

  const good = patchFromRead({
    meta: { description: "D", model: "acme/standard#high", color: "#FF0000" },
    body: "b\n",
    format: "v2",
    hash: "0123456789abcdef",
    mtime: 1,
  })
  assert.equal(good.model, "acme/standard#high")
  assert.equal(good.color, "#FF0000")
})

// ---------- G-12-9：重命名成功后的 dirty 判定 ----------

const FORM: EditorFormValues = {
  description: "d",
  body: "b\n",
  model: "acme/standard",
  variant: "high",
  color: "#ff0000",
  hidden: false,
  stepsText: "8",
  matrix: MATRIX,
}

test("R12b-G9a: an untouched form is not dirty", () => {
  assert.equal(formValuesEqual({ ...FORM, matrix: { ...MATRIX, actions: { ...MATRIX.actions } } }, FORM), true)
})

test("R12b-G9b: any user edit makes the form dirty", () => {
  assert.equal(formValuesEqual({ ...FORM, description: "changed" }, FORM), false)
  assert.equal(formValuesEqual({ ...FORM, body: "other\n" }, FORM), false)
  assert.equal(formValuesEqual({ ...FORM, model: "acme/mini" }, FORM), false)
  assert.equal(formValuesEqual({ ...FORM, variant: undefined }, FORM), false)
  assert.equal(formValuesEqual({ ...FORM, color: undefined }, FORM), false)
  assert.equal(formValuesEqual({ ...FORM, hidden: true }, FORM), false)
  assert.equal(formValuesEqual({ ...FORM, stepsText: "9" }, FORM), false)
  assert.equal(
    formValuesEqual({ ...FORM, matrix: { ...MATRIX, actions: { ...MATRIX.actions, read: "deny" } } }, FORM),
    false,
  )
})

test("R12b-G9c: steps text differences that mean the same number are not dirty", () => {
  assert.equal(formValuesEqual({ ...FORM, stepsText: " 8 " }, FORM), true, "whitespace is not an edit")
  assert.equal(formValuesEqual({ ...FORM, stepsText: undefined }, { ...FORM, stepsText: "" }), true)
})

// ---------- G-12-10 → R-12-1：model-picker-logic 与宿主首斜杠切分语义一致 ----------

const PROVIDERS: ProviderSummary[] = [
  {
    id: "acme",
    name: "Acme",
    models: [
      { id: "standard", name: "Standard", variants: ["high", "low"] },
      { id: "org/mini", name: "Nested Mini", variants: ["high"] },
    ],
  },
  {
    id: "globex",
    name: "Globex",
    models: [{ id: "turbo", name: "Turbo", variants: ["max"] }],
  },
]

test("R12b-G10a: modelPartsOf splits on the first slash so nested model ids stay valid", () => {
  assert.deepEqual(modelPartsOf("acme/standard"), { providerID: "acme", modelID: "standard" })
  assert.deepEqual(
    modelPartsOf("acme/org/mini"),
    { providerID: "acme", modelID: "org/mini" },
    "host Model.Ref.parse splits on the first slash only (models.dev ids may nest)",
  )
  assert.deepEqual(modelPartsOf("acme//mini"), { providerID: "acme", modelID: "/mini" })
  assert.equal(modelPartsOf("noslash"), undefined)
  assert.equal(modelPartsOf("/mini"), undefined)
  assert.equal(modelPartsOf("acme/"), undefined)
  assert.equal(modelPartsOf(undefined), undefined)
})

test("R12b-G10b: variantsOf resolves nested model ids via the first-slash split", () => {
  assert.deepEqual(variantsOf(PROVIDERS, "acme/standard"), ["high", "low"])
  assert.deepEqual(variantsOf(PROVIDERS, "acme/org/mini"), ["high"], "nested model ids are selectable")
})

test("R12b-G10c: providerOfModel returns the provider half of the first-slash split", () => {
  assert.equal(providerOfModel("acme/standard"), "acme")
  assert.equal(providerOfModel("acme/org/mini"), "acme")
  assert.equal(providerOfModel("noslash"), undefined)
  assert.equal(providerOfModel(undefined), undefined)
})

test("R12b-G10d: the picker lists nested model ids untouched (HEAD behaviour)", () => {
  const all = filterProviders(PROVIDERS, "")
  assert.deepEqual(all.map((p) => p.id), ["acme", "globex"])
  assert.deepEqual(all[0].models.map((m) => m.id), ["standard", "org/mini"], "nested model ids are shown and selectable")
  assert.deepEqual(filterProviders(PROVIDERS, "mini").map((p) => p.id), ["acme"], "search finds nested ids")
  assert.deepEqual(filterProviders(PROVIDERS, "standard").map((p) => p.id), ["acme"])
})

// 宿主数据里 providerID 不含 "/"；万一出现，弹窗按 HEAD 行为原样展示，
// 不在 GUI 侧二次猜测（选中后由服务端/宿主同一套首斜杠语义解析）。
test("R12b-G10e: a provider whose id contains a slash is displayed verbatim", () => {
  const weird: ProviderSummary[] = [
    { id: "team/acme", name: "Team", models: [{ id: "standard", name: "Standard", variants: [] }] },
  ]
  const out = filterProviders(weird, "")
  assert.deepEqual(out.map((p) => p.id), ["team/acme"], "host data is shown as-is, no GUI-side second-guessing")
})
