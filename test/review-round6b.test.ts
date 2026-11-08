// test/review-round6b.test.ts —— 第六轮审查第二批回归（M3 / M10 / I4）。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { variantOnPick } from "../src/gui/model-picker-logic.ts"
import { writeBuiltinOverride, overrideKeyOf, type OverrideCache } from "../src/core/builtin.ts"
import { assertProjectRootExists } from "../src/core/agent-store.ts"

// ---------- M3：重选当前模型不得清掉 variant ----------

test("M3: re-picking the current model keeps the variant", () => {
  assert.equal(variantOnPick("acme/standard", "acme/standard", "high"), "high")
})

test("M3: picking a different model clears the variant", () => {
  assert.equal(variantOnPick("acme/other", "acme/standard", "high"), undefined)
  assert.equal(variantOnPick("acme/standard", undefined, "high"), undefined)
})

// ---------- M10：storage 写失败时缓存不得先变 ----------

function storageSpy(failOn?: "set" | "remove") {
  const calls: string[] = []
  return {
    calls,
    set: async (key: string, _value: string) => {
      calls.push(`set:${key}`)
      if (failOn === "set") throw new Error("storage down")
    },
    remove: async (key: string) => {
      calls.push(`remove:${key}`)
      if (failOn === "remove") throw new Error("storage down")
    },
  }
}

test("M10: successful override write updates storage then cache", async () => {
  const cache: OverrideCache = new Map()
  const spy = storageSpy()
  await writeBuiltinOverride(spy, cache, "general", "acme/standard")
  assert.deepEqual(spy.calls, [`set:${overrideKeyOf("general")}`])
  assert.equal(cache.get(overrideKeyOf("general")), "acme/standard")
})

test("M10: failed storage write leaves the cache untouched", async () => {
  const cache: OverrideCache = new Map([[overrideKeyOf("general"), "old/model"]])
  const spy = storageSpy("set")
  await assert.rejects(writeBuiltinOverride(spy, cache, "general", "new/model"))
  assert.equal(cache.get(overrideKeyOf("general")), "old/model",
    "cache must not diverge from storage after a failed write")
})

test("M10: clearing an override removes storage first, then cache", async () => {
  const cache: OverrideCache = new Map([[overrideKeyOf("explore"), "old/model"]])
  const spy = storageSpy()
  await writeBuiltinOverride(spy, cache, "explore", undefined)
  assert.deepEqual(spy.calls, [`remove:${overrideKeyOf("explore")}`])
  assert.equal(cache.has(overrideKeyOf("explore")), false)
})

test("M10: failed storage remove keeps the cached override", async () => {
  const cache: OverrideCache = new Map([[overrideKeyOf("explore"), "old/model"]])
  const spy = storageSpy("remove")
  await assert.rejects(writeBuiltinOverride(spy, cache, "explore", ""))
  assert.equal(cache.get(overrideKeyOf("explore")), "old/model")
})

// ---------- I4：create 的项目根必须是已存在的目录 ----------

test("I4: assertProjectRootExists accepts an existing directory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osm-r6b-"))
  try {
    await assert.doesNotReject(assertProjectRootExists(tmp))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("I4: assertProjectRootExists rejects missing paths and files with invalid_path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osm-r6b-"))
  try {
    const missing = path.join(tmp, "no-such-project")
    await assert.rejects(assertProjectRootExists(missing), (e: unknown) => (e as { code?: string }).code === "invalid_path")
    const file = path.join(tmp, "a-file")
    fs.writeFileSync(file, "x")
    await assert.rejects(assertProjectRootExists(file), (e: unknown) => (e as { code?: string }).code === "invalid_path")
    assert.ok(!fs.existsSync(path.join(missing, ".opencode")), "must not create the fabricated tree")
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})