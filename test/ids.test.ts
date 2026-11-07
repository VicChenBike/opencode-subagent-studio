// test/ids.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { ID_PATTERN, RESERVED_IDS, isValidAgentId, isReservedId } from "../src/core/ids.ts"

test("ID_PATTERN accepts valid ids", () => {
  for (const id of ["a", "reviewer", "code-reviewer", "a1-2b", "x".repeat(64)]) {
    assert.match(id, ID_PATTERN)
    assert.equal(isValidAgentId(id), true, id)
  }
})

test("ID_PATTERN rejects invalid ids", () => {
  for (const id of ["", "Upper", "1abc", "-abc", "ab_c", "has space", "a/b", "x".repeat(65), "ab.md"]) {
    assert.equal(isValidAgentId(id), false, id)
  }
})

test("reserved ids are detected", () => {
  assert.deepEqual([...RESERVED_IDS].sort(),
    ["build", "compaction", "explore", "general", "plan", "summary", "title"].sort())
  assert.equal(isReservedId("general"), true)
  assert.equal(isReservedId("reviewer"), false)
})
