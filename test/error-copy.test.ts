// test/error-copy.test.ts —— RPC 错误码 → 可读文案键（P3-T8）。
// goal.md §14.2 的七种错误码都应有对应的可读提示，而不是把原始 message 直接抛给用户。
import { test } from "node:test"
import assert from "node:assert/strict"
import { errorCopyKey, errorDescription } from "../src/gui/error-copy.ts"

const t = (key: string) => key

test("every declared error code maps to its own copy key", () => {
  assert.equal(errorCopyKey({ type: "invalid_path" }), "error.invalidPath")
  assert.equal(errorCopyKey({ type: "exists" }), "error.exists")
  assert.equal(errorCopyKey({ type: "not_found" }), "error.notFound")
  assert.equal(errorCopyKey({ type: "conflict" }), "error.conflict")
})

test("codes without dedicated copy fall back to the generic message", () => {
  assert.equal(errorCopyKey({ type: "invalid_id" }), undefined)
  assert.equal(errorCopyKey({ type: "reserved_id" }), undefined)
  assert.equal(errorCopyKey({ type: "migration_required" }), undefined)
  assert.equal(errorCopyKey(new Error("boom")), undefined)
  assert.equal(errorCopyKey(undefined), undefined)
})

test("a nested or wrapped type is still recognised", () => {
  assert.equal(errorCopyKey({ type: "rpc.internal", data: { type: "conflict" } }), "error.conflict")
  assert.equal(errorCopyKey({ cause: { type: "not_found" } }), "error.notFound")
})

test("errorDescription prefers the translated copy over the raw message", () => {
  assert.equal(errorDescription(t, { type: "conflict", message: "file changed on disk" }), "error.conflict")
})

test("errorDescription keeps the raw message when no copy exists", () => {
  assert.equal(errorDescription(t, { type: "invalid_id", message: "bad id" }), "bad id")
  assert.equal(errorDescription(t, new Error("boom")), "boom")
  assert.equal(errorDescription(t, "plain"), "plain")
  assert.equal(errorDescription(t, undefined), "")
})
