// test/builtin.test.ts —— 内置代理模型覆盖（纯逻辑，goal.md §11）。
// general / explore 只换模型，不改提示词与权限；覆盖值存 storage，键 builtin-model.<id>。
import { test } from "node:test"
import assert from "node:assert/strict"
import { applyBuiltinOverrides, overrideKeyOf, builtinIdOf, parseOverride } from "../src/core/builtin.ts"
import type { AgentInfoLike } from "../src/core/builtin.ts"

function fakeEditor(agents: AgentInfoLike[]) {
  const calls: { id: string; fn: (a: AgentInfoLike) => void }[] = []
  return {
    calls,
    editor: {
      list: () => agents,
      get: (id: string) => agents.find((a) => a.id === id),
      default: () => {},
      update: (id: string, fn: (a: AgentInfoLike) => void) => { calls.push({ id, fn }) },
      remove: () => {},
    },
  }
}

const general: AgentInfoLike = {
  id: "general", name: "general", mode: "subagent", hidden: false, permissions: [], request: {},
}

test("overrideKeyOf builds the storage key for a builtin", () => {
  assert.equal(overrideKeyOf("general"), "builtin-model.general")
  assert.equal(overrideKeyOf("explore"), "builtin-model.explore")
})

test("builtinIdOf recognises only general and explore", () => {
  assert.equal(builtinIdOf("builtin-model.general"), "general")
  assert.equal(builtinIdOf("builtin-model.explore"), "explore")
  assert.equal(builtinIdOf("builtin-model.build"), undefined)
  assert.equal(builtinIdOf("other.key"), undefined)
})

test("parseOverride splits provider/model and optional variant", () => {
  assert.deepEqual(parseOverride("acme/standard"), { providerID: "acme", modelID: "standard", variant: undefined })
  assert.deepEqual(parseOverride("acme/standard#high"), { providerID: "acme", modelID: "standard", variant: "high" })
})

test("parseOverride rejects garbage", () => {
  assert.equal(parseOverride("noslash"), undefined)
  assert.equal(parseOverride(""), undefined)
  assert.equal(parseOverride(undefined), undefined)
  assert.equal(parseOverride("acme/standard#high#low"), undefined)
})

test("applyBuiltinOverrides updates the named builtin with the parsed model", () => {
  const { calls, editor } = fakeEditor([general])
  applyBuiltinOverrides(editor, { "builtin-model.general": "acme/standard#high" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, "general")
  const agent = { ...general }
  calls[0].fn(agent)
  assert.deepEqual(agent.model, { id: "standard", providerID: "acme", variant: "high" })
})

test("applyBuiltinOverrides skips invalid refs and unknown keys", () => {
  const { calls, editor } = fakeEditor([general])
  applyBuiltinOverrides(editor, { "builtin-model.general": "garbage", "other.key": "acme/mini" })
  assert.equal(calls.length, 0)
})

test("applyBuiltinOverrides handles empty overrides", () => {
  const { calls, editor } = fakeEditor([general])
  applyBuiltinOverrides(editor, {})
  assert.equal(calls.length, 0)
})

test("applyBuiltinOverrides ignores a builtin the editor does not list", () => {
  const { calls, editor } = fakeEditor([])
  applyBuiltinOverrides(editor, { "builtin-model.general": "acme/standard" })
  assert.equal(calls.length, 0)
})

test("removing an override leaves the builtin's model untouched", () => {
  const existing: AgentInfoLike = { ...general, model: { id: "native", providerID: "native" } }
  const { calls, editor } = fakeEditor([existing])
  applyBuiltinOverrides(editor, {})
  assert.equal(calls.length, 0, "no override means no transform call")
})

test("both builtins can be overridden at once", () => {
  const explore: AgentInfoLike = { ...general, id: "explore", name: "explore" }
  const { calls, editor } = fakeEditor([general, explore])
  applyBuiltinOverrides(editor, {
    "builtin-model.general": "acme/standard",
    "builtin-model.explore": "acme/mini#low",
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.id).sort(), ["explore", "general"])
})

test("a builtin without an override keeps whatever model it already has", () => {
  const existing: AgentInfoLike = { ...general, model: { id: "native", providerID: "native" } }
  const { calls, editor } = fakeEditor([existing])
  applyBuiltinOverrides(editor, { "builtin-model.explore": "acme/mini" })
  assert.equal(calls.length, 0, "general has no override, so it must not be touched")
})

// P1-1（审查）：宿主 Transform 回调是同步的 `(input) => void`。
// 若回调内部 await storage，第一个 await 挂起后 applyBuiltinOverrides 会落到 transform pass
// 之后执行，覆盖可能不生效或非确定生效。所以 setup 时把覆盖读进闭包缓存，回调同步读缓存。
test("createBuiltinTransform applies overrides synchronously from a cache", async () => {
  const { createBuiltinTransform } = await import("../src/core/builtin.ts")
  const cache = new Map<string, string>([["builtin-model.general", "acme/standard#high"]])
  const transform = createBuiltinTransform(() => cache)
  const agents: AgentInfoLike[] = [{ ...general }]
  const { calls, editor } = fakeEditor(agents)
  // 关键：不 await —— 同步调用结束时就应已经产生 update
  const returned = transform(editor)
  assert.equal(returned, undefined, "the transform callback must return void, not a promise")
  assert.equal(calls.length, 1, "the override must be applied before the callback returns")
})

test("the transform cache reflects a new pick without waiting for storage", async () => {
  const { createBuiltinTransform, applyBuiltinOverrideToCache } = await import("../src/core/builtin.ts")
  const cache = new Map<string, string>()
  const transform = createBuiltinTransform(() => cache)
  applyBuiltinOverrideToCache(cache, "general", "acme/mini")
  const { calls, editor } = fakeEditor([{ ...general }])
  transform(editor)
  assert.equal(calls.length, 1)
  const agent = { ...general }
  calls[0].fn(agent)
  assert.deepEqual(agent.model, { id: "mini", providerID: "acme" })
})

test("clearing the cache entry makes the transform skip the builtin", async () => {
  const { createBuiltinTransform, applyBuiltinOverrideToCache } = await import("../src/core/builtin.ts")
  const cache = new Map<string, string>([["builtin-model.general", "acme/standard"]])
  const transform = createBuiltinTransform(() => cache)
  applyBuiltinOverrideToCache(cache, "general", undefined)
  const { calls, editor } = fakeEditor([{ ...general }])
  transform(editor)
  assert.equal(calls.length, 0, "inherit-default must stop rewriting the model")
})
