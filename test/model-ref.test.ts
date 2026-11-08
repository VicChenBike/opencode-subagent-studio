// test/model-ref.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseModelRef, formatModelRef } from "../src/core/model-ref.ts"

test("parse plain provider/model", () => {
  assert.deepEqual(parseModelRef("acme/standard"), { providerID: "acme", modelID: "standard", variant: undefined })
})

test("parse provider/model#variant", () => {
  assert.deepEqual(parseModelRef("acme/standard#high"), { providerID: "acme", modelID: "standard", variant: "high" })
})

// R-12-1 回退：宿主 Model.Ref.parse 按第一个 "/" 切分，modelID 可含 "/"
// （models.dev 目录 id 如 openrouter/anthropic/claude-sonnet-4，宿主可解析）。
// 第十二轮 S-12-8 曾误判其为坏值，最终 Code Review 实证宿主后回退。
test("model id may contain slashes; split on first slash only", () => {
  assert.deepEqual(parseModelRef("acme/org/mini"), { providerID: "acme", modelID: "org/mini", variant: undefined })
  assert.deepEqual(parseModelRef("acme//mini"), { providerID: "acme", modelID: "/mini", variant: undefined })
})

test("parse rejects garbage", () => {
  assert.equal(parseModelRef(undefined), null)
  assert.equal(parseModelRef(""), null)
  assert.equal(parseModelRef("noslash"), null)
  assert.equal(parseModelRef("acme/standard#high#low"), null) // 多个 # 视为非法
  assert.equal(parseModelRef("acme/standard#"), null) // 空 variant 非法
})

test("format round-trips", () => {
  assert.equal(formatModelRef({ providerID: "acme", modelID: "standard" }), "acme/standard")
  assert.equal(formatModelRef({ providerID: "acme", modelID: "standard", variant: "high" }), "acme/standard#high")
})
