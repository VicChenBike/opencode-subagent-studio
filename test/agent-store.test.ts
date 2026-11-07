// test/agent-store.test.ts
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  userAgentsDir, projectAgentsDir, trashDirFor,
  assertAllowedPath, hashOf, listAgents,
} from "../src/core/agent-store.ts"

let tmp: string

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osm-store-")) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

test("dir helpers derive standard locations", () => {
  const home = os.homedir()
  assert.equal(userAgentsDir(), path.join(home, ".config", "opencode", "agents"))
  assert.equal(projectAgentsDir(path.join(tmp, "proj")), path.join(tmp, "proj", ".opencode", "agents"))
  // 回收站与 agents/ 同级，绝不在 agents/ 内（坑 6）
  assert.equal(trashDirFor(userAgentsDir()), path.join(home, ".config", "opencode", "agents-trash"))
  assert.equal(trashDirFor(projectAgentsDir(path.join(tmp, "proj"))), path.join(tmp, "proj", ".opencode", "agents-trash"))
})

test("assertAllowedPath accepts roots and children, rejects traversal and outsiders", () => {
  const root = path.join(tmp, "agents")
  fs.mkdirSync(root, { recursive: true })
  const roots = [root]
  assert.doesNotThrow(() => assertAllowedPath(path.join(root, "a.md"), roots))
  assert.doesNotThrow(() => assertAllowedPath(root, roots))
  assert.throws(() => assertAllowedPath(path.join(root, "..", "escape.md"), roots))
  assert.throws(() => assertAllowedPath(path.join(tmp, "other.md"), roots))
  assert.throws(() => assertAllowedPath(path.join(root, "sub", "..", "..", "..", "win.md"), roots))
})

test("assertAllowedPath read mode allows any <x>/.opencode/agents shape, write mode rejects", () => {
  const proj = path.join(tmp, "someproject", ".opencode", "agents", "a.md")
  assert.doesNotThrow(() => assertAllowedPath(proj, [], "read"))
  assert.throws(() => assertAllowedPath(proj, [], "write"))
  assert.throws(() => assertAllowedPath(path.join(tmp, "plain", "a.md"), [], "read"))
})

test("hashOf is sha256 hex truncated to 16 chars", () => {
  const h = hashOf("hello")
  assert.match(h, /^[0-9a-f]{16}$/)
  assert.equal(h, hashOf("hello"))
  assert.notEqual(h, hashOf("world"))
})

test("listAgents scans recursively, sorts by id, skips non-md", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(path.join(dir, "team"), { recursive: true })
  fs.writeFileSync(path.join(dir, "zeta.md"), "---\ndescription: Z\nmode: subagent\n---\n\nBody Z\n")
  fs.writeFileSync(path.join(dir, "alpha.md"), "---\ndescription: A\nmode: subagent\nhidden: true\n---\n\nBody A\n")
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an agent")
  fs.writeFileSync(path.join(dir, "team", "reviewer.md"), "---\ndescription: R\nmode: subagent\nmodel: acme/standard#high\n---\n\nBody R\n")
  const list = await listAgents(dir)
  assert.deepEqual(list.map((a) => a.id), ["alpha", "team/reviewer", "zeta"])
  const alpha = list[0]
  assert.equal(alpha.hidden, true)
  assert.equal(alpha.description, "A")
  assert.equal(alpha.format, "v1")
  const nested = list[1]
  assert.equal(nested.id, "team/reviewer")
  assert.equal(nested.model, "acme/standard#high")
  assert.match(nested.hash, /^[0-9a-f]{16}$/)
  assert.ok(nested.mtime > 0)
})

test("listAgents reports disabled and v2 format", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "off.md"), "---\ndescription: Off\nmode: subagent\ndisabled: true\npermissions: []\n---\n\nx\n")
  const [a] = await listAgents(dir)
  assert.equal(a.disabled, true)
  assert.equal(a.format, "v2")
})

test("listAgents on missing dir returns empty array", async () => {
  assert.deepEqual(await listAgents(path.join(tmp, "nope")), [])
})
