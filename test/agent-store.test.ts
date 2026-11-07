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

// —— 回归：list RPC 500（真实桌面端）——
// 宿主对 handler 输出按 output schema 做 encode，声明为 string 的可选字段若以
// 「值为 undefined 的自有属性」形式存在，会抛 Expected string，整个 list 变 500。
test("listAgents omits optional fields instead of leaving undefined own properties", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  // 有 color/model
  fs.writeFileSync(path.join(dir, "with-both.md"), "---\ndescription: B\nmode: subagent\ncolor: \"#ff0000\"\nmodel: acme/standard\n---\n\nx\n")
  // 无 color / 无 model
  fs.writeFileSync(path.join(dir, "plain.md"), "---\ndescription: P\nmode: subagent\n---\n\nx\n")
  const list = await listAgents(dir)
  const plain = list.find((a) => a.id === "plain")!
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "color"), false, "color must not be an own property when absent")
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "model"), false, "model must not be an own property when absent")
  const both = list.find((a) => a.id === "with-both")!
  assert.equal(both.color, "#ff0000")
  assert.equal(both.model, "acme/standard")
})

// —— goal.md §5.2：列表只显示 mode 精确等于 subagent 的文件 ——
// primary（主代理本体）、all、无 mode（AGENTS.md §3.3：新建默认 primary）、
// 以及 frontmatter 缺失/畸形（降级为 {} meta）的文件都必须排除。
test("listAgents keeps only files whose mode is exactly subagent", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "is-primary.md"), "---\ndescription: P\nmode: primary\n---\n\nx\n")
  fs.writeFileSync(path.join(dir, "is-subagent.md"), "---\ndescription: S\nmode: subagent\n---\n\nx\n")
  fs.writeFileSync(path.join(dir, "is-all.md"), "---\ndescription: A\nmode: all\n---\n\nx\n")
  fs.writeFileSync(path.join(dir, "no-mode.md"), "---\ndescription: N\n---\n\nx\n")
  fs.writeFileSync(path.join(dir, "no-frontmatter.md"), "Just a body, no frontmatter\n")
  fs.writeFileSync(path.join(dir, "scalar-frontmatter.md"), "---\njust-a-scalar\n---\n\nx\n")

  const list = await listAgents(dir)
  assert.deepEqual(list.map((a) => a.id), ["is-subagent"])
})

test("listAgents excludes primary agents even when they carry color and model", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  // 真实用户级目录里 superpowers.md 就是这种形态：mode: primary + color + model
  fs.writeFileSync(path.join(dir, "superpowers.md"), "---\ndescription: Primary\nmodel: acme/standard\nmode: primary\ncolor: \"#8b5cf6\"\n---\n\nx\n")
  fs.writeFileSync(path.join(dir, "helper.md"), "---\ndescription: Helper\nmodel: acme/mini\nmode: subagent\nhidden: true\n---\n\nx\n")
  const list = await listAgents(dir)
  assert.deepEqual(list.map((a) => a.id), ["helper"])
})

test("listAgents still scans nested subdirectories and applies the mode filter there", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(path.join(dir, "team"), { recursive: true })
  fs.writeFileSync(path.join(dir, "team", "reviewer.md"), "---\ndescription: R\nmode: subagent\n---\n\nx\n")
  fs.writeFileSync(path.join(dir, "team", "lead.md"), "---\ndescription: L\nmode: primary\n---\n\nx\n")
  const list = await listAgents(dir)
  assert.deepEqual(list.map((a) => a.id), ["team/reviewer"])
})
