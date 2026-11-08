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

// ---------- P2-T4：写操作 ----------
import {
  createAgentFile, updateAgentFile, setDisabledFile, renameAgentFile, trashAgentFile, readAgentFile,
  previewMigrationFile,
} from "../src/core/agent-store.ts"
import type { AgentPatch } from "../src/rpc.ts"

const MATRIX = {
  defaultEffect: "allow",
  actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow", shell: "allow",
    webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" },
} as const

test("createAgentFile writes v2 file and no-clobbers", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  const p = await createAgentFile({ dir, id: "reviewer", description: "d", body: "b\n", matrix: MATRIX })
  assert.equal(p, path.join(dir, "reviewer.md"))
  const raw = fs.readFileSync(p, "utf8")
  assert.ok(raw.startsWith("---\ndescription: d\nmode: subagent"))
  assert.ok(!raw.includes("name:"))
  // no-clobber：存在即拒绝
  await assert.rejects(
    () => createAgentFile({ dir, id: "reviewer", description: "d2", body: "b\n", matrix: MATRIX }),
    (e: Error & { code?: string }) => e.code === "exists",
  )
  // 非法 ID 拒绝
  await assert.rejects(
    () => createAgentFile({ dir, id: "Bad_Id", description: "d", body: "b\n", matrix: MATRIX }),
    (e: Error & { code?: string }) => e.code === "invalid_id",
  )
  await assert.rejects(
    () => createAgentFile({ dir, id: "general", description: "d", body: "b\n", matrix: MATRIX }),
    (e: Error & { code?: string }) => e.code === "reserved_id",
  )
})

test("updateAgentFile conflicts on hash mismatch and supports force with backup", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  const filePath = await createAgentFile({ dir, id: "reviewer", description: "d", body: "b\n", matrix: MATRIX })
  const patch: AgentPatch = { description: "d2", body: "b2\n", matrix: MATRIX }
  // 旧 hash → conflict
  await assert.rejects(
    () => updateAgentFile({ filePath, roots: [dir], expectedHash: "deadbeefdeadbeef", patch }),
    (e: Error & { code?: string }) => e.code === "conflict",
  )
  // force = 备份到 agents-trash/.backup-*，再写入
  const { hash } = await updateAgentFile({ filePath, roots: [dir], expectedHash: "deadbeefdeadbeef", patch, force: true })
  const trash = trashDirFor(dir)
  const backups = fs.readdirSync(trash).filter((f) => f.startsWith(".backup-"))
  assert.equal(backups.length, 1)
  assert.ok(fs.readFileSync(path.join(trash, backups[0]), "utf8").includes("description: d\n"))
  const second = await readAgentFile(filePath)
  assert.equal(second.hash, hash)
  assert.equal((second.meta as { description: string }).description, "d2")
})

test("setDisabledFile toggles disabled and returns new hash", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  const filePath = await createAgentFile({ dir, id: "reviewer", description: "d", body: "b\n", matrix: MATRIX })
  const off = await setDisabledFile({ filePath, roots: [dir], disabled: true, expectedHash: (await readAgentFile(filePath)).hash })
  const meta = (await readAgentFile(filePath)).meta as Record<string, unknown>
  assert.equal(meta.disabled, true)
  const on = await setDisabledFile({ filePath, roots: [dir], disabled: false, expectedHash: off.hash })
  const meta2 = (await readAgentFile(filePath)).meta as Record<string, unknown>
  assert.ok(!("disabled" in meta2)) // false = 删除字段（goal.md §10）
  assert.notEqual(off.hash, on.hash)
  // V1 文件：拒绝直接写 disabled（必须走迁移预览，goal.md §5.3）
  fs.writeFileSync(path.join(dir, "legacy.md"), "---\ndescription: d\nmode: subagent\n---\n\nb\n")
  const legacyHash = (await readAgentFile(path.join(dir, "legacy.md"))).hash
  await assert.rejects(
    () => setDisabledFile({ filePath: path.join(dir, "legacy.md"), roots: [dir], disabled: true, expectedHash: legacyHash }),
    (e: Error & { code?: string }) => e.code === "migration_required",
  )
})

test("renameAgentFile moves file, rejects duplicates and reserved ids", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  const filePath = await createAgentFile({ dir, id: "old-name", description: "d", body: "b\n", matrix: MATRIX })
  const renamed = await renameAgentFile({ filePath, roots: [dir], newId: "new-name" })
  assert.ok(fs.existsSync(path.join(dir, "new-name.md")))
  assert.ok(!fs.existsSync(filePath))
  await assert.rejects(
    () => renameAgentFile({ filePath: renamed.path, roots: [dir], newId: "new-name" }),
    (e: Error & { code?: string }) => e.code === "exists",
  )
  await assert.rejects(
    () => renameAgentFile({ filePath: renamed.path, roots: [dir], newId: "general" }),
    (e: Error & { code?: string }) => e.code === "reserved_id",
  )
})

test("renameAgentFile drops name field from v1 files (goal.md §6.1)", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  const legacy = path.join(dir, "legacy.md")
  fs.writeFileSync(legacy, "---\nname: legacy\ndescription: d\nmode: subagent\n---\n\nb\n")
  const { path: newPath } = await renameAgentFile({ filePath: legacy, roots: [dir], newId: "renamed" })
  const raw = fs.readFileSync(newPath, "utf8")
  assert.ok(!raw.includes("name:"))
})

test("trashAgentFile moves into sibling agents-trash with timestamp name", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, "victim.md")
  fs.writeFileSync(filePath, "---\ndescription: v\nmode: subagent\n---\n\nb\n")
  const { trashPath } = await trashAgentFile({ filePath, roots: [dir] })
  assert.ok(!fs.existsSync(filePath))
  const name = path.basename(trashPath)
  assert.match(name, /^\d{8}-\d{6}-victim\.md$/)
  assert.equal(fs.readFileSync(trashPath, "utf8").includes("description: v"), true)
  // 回收站绝不位于 agents/ 内（坑 6）
  assert.ok(!trashPath.startsWith(dir + path.sep))
  // 不存在文件 → not_found
  await assert.rejects(
    () => trashAgentFile({ filePath, roots: [dir] }),
    (e: Error & { code?: string }) => e.code === "not_found",
  )
})

// R1 遗留：扫描期间单文件被删不应让整次列表失败（读取竞态）
test("listAgents skips a file that disappears mid-scan instead of failing the whole list", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "stable.md"), "---\ndescription: S\nmode: subagent\n---\n\nx\n")
  const vanishing = path.join(dir, "vanishing.md")
  fs.writeFileSync(vanishing, "---\ndescription: V\nmode: subagent\n---\n\nx\n")

  const { mock } = await import("node:test")
  const fsp = (await import("node:fs/promises")).default
  const original = fsp.readFile
  mock.method(fsp, "readFile", async (p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith("vanishing.md")) {
      const err = new Error("ENOENT: vanished") as Error & { code: string }
      err.code = "ENOENT"
      throw err
    }
    return (original as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
  })
  try {
    const list = await listAgents(dir)
    assert.deepEqual(list.map((a) => a.id), ["stable"])
  } finally {
    mock.restoreAll()
  }
})

test("listAgents still surfaces a malformed file rather than dropping valid ones", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "ok.md"), "---\ndescription: O\nmode: subagent\n---\n\nx\n")
  fs.writeFileSync(path.join(dir, "weird.md"), "---\n- a\n- b\n---\n\nx\n")
  const list = await listAgents(dir)
  assert.deepEqual(list.map((a) => a.id), ["ok"])
})

// 中期审查 P3-2：migratePreview 读不到文件时必须映射成契约错误码 not_found，
// 而不是把 ENOENT 直接抛成 500。
test("previewMigrationFile reports not_found for a missing file", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  await assert.rejects(
    () => previewMigrationFile({ filePath: path.join(dir, "nope.md") }),
    (e: Error & { code?: string }) => e.code === "not_found",
  )
})

test("previewMigrationFile returns before/after/changes for a v1 file", async () => {
  const dir = path.join(tmp, "agents")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "legacy.md")
  fs.writeFileSync(file, "---\nname: legacy\ndescription: d\nmode: subagent\npermission:\n  read: allow\n---\n\nb\n")
  const res = await previewMigrationFile({ filePath: file })
  assert.ok(res.before.includes("name: legacy"))
  assert.ok(!res.after.includes("name:"))
  assert.ok(res.after.includes("permissions:"))
  assert.ok(res.changes.some((c) => c.field === "name"))
})
