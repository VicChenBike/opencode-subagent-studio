// test/review-round7.test.ts —— 第七轮审查回归（R7-1 … R7-13）。
// 先写测试后修实现（TDD）：这些用例在修复前应当失败，修复后必须全绿。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ACTIONS } from "../src/rpc.ts"
import { splitFrontmatter, parseAgentFile, applyPatchToSource, migrateContent } from "../src/core/frontmatter.ts"
import { matrixFromRules, rulesFromMatrix } from "../src/core/permissions.ts"
import {
  assertAllowedPath, listAgents, readAgentFile, resolveAgentsDir, setDisabledFile, trashAgentFile,
} from "../src/core/agent-store.ts"
import { validateNewId } from "../src/gui/rename-flow.ts"
import { isValidBuiltinModel } from "../src/core/builtin.ts"

const allowMatrix = () => ({
  defaultEffect: "allow" as const,
  actions: Object.fromEntries(ACTIONS.map((a) => [a, "allow"])) as Record<(typeof ACTIONS)[number], "allow">,
})
const patch = (body = "line1\nline2") => ({ description: "y", body, matrix: allowMatrix() })

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `osm-r7-${tag}-`))
}

// ---------- R7-1：畸形 YAML（未解析别名 / 循环引用）不得炸掉整次扫描 ----------

test("R7-1: unresolved alias does not throw and is flagged invalid", () => {
  const parsed = parseAgentFile("---\nmode: subagent\nalias: *nope\n---\n\nbody\n")
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.invalid, true)
})

test("R7-1: recursive alias is flagged invalid and JSON.stringify-safe", () => {
  const parsed = parseAgentFile("---\nmode: subagent\nloop: &a [*a]\n---\n\nb\n")
  assert.equal(parsed.invalid, true)
  assert.doesNotThrow(() => JSON.stringify(parsed.meta))
})

test("R7-1: listAgents skips unparseable files", async () => {
  const root = tmpDir("list")
  try {
    const dir = path.join(root, "agents")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "good.md"), "---\ndescription: ok\nmode: subagent\n---\n\nx\n")
    fs.writeFileSync(path.join(dir, "bad.md"), "---\nmode: subagent\nalias: *nope\n---\n\nx\n")
    const list = await listAgents(dir)
    assert.deepEqual(list.map((a) => a.id), ["good"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("R7-1: readAgentFile maps an unparseable file to invalid_format", async () => {
  const root = tmpDir("read-bad")
  try {
    const file = path.join(root, "bad.md")
    fs.writeFileSync(file, "---\nmode: subagent\nalias: *nope\n---\n\nx\n")
    await assert.rejects(readAgentFile(file), (e: unknown) => (e as { code?: string }).code === "invalid_format")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("R7-1: migrateContent rejects an unparseable file with invalid_format", () => {
  assert.throws(
    () => migrateContent("---\nname: x\nalias: *nope\n---\n\nb\n"),
    (e: unknown) => (e as { code?: string }).code === "invalid_format",
  )
})

test("R7-1: applyPatchToSource rejects an unparseable file with invalid_format", () => {
  assert.throws(
    () => applyPatchToSource("---\nmode: subagent\nalias: *nope\n---\n\nbody\n", patch()),
    (e: unknown) => (e as { code?: string }).code === "invalid_format",
  )
})

// ---------- R7-2：缺失文件必须是 not_found，而不是裸 ENOENT ----------

test("R7-2: readAgentFile maps ENOENT to not_found", async () => {
  const root = tmpDir("not-found")
  try {
    await assert.rejects(
      readAgentFile(path.join(root, "missing.md")),
      (e: unknown) => (e as { code?: string }).code === "not_found",
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------- R7-3：嵌套代理 ID 的重命名不得因为 basename 相同被当成未改变 ----------

test("R7-3: validateNewId compares nested ids against their basename", () => {
  assert.equal(validateNewId("reviewer", "team/reviewer"), "unchanged")
  assert.equal(validateNewId("other", "team/reviewer"), undefined)
  assert.equal(validateNewId("reviewer", "reviewer"), "unchanged")
})

// ---------- R7-4：同一秒内的同名文件进回收站不得互相覆盖 ----------

test("R7-4: trashAgentFile dedupes same-second same-name targets", async () => {
  const root = tmpDir("trash-dup")
  try {
    const agents = path.join(root, "agents")
    fs.mkdirSync(path.join(agents, "a"), { recursive: true })
    fs.mkdirSync(path.join(agents, "b"), { recursive: true })
    const aPath = path.join(agents, "a", "reviewer.md")
    const bPath = path.join(agents, "b", "reviewer.md")
    const aContent = "---\ndescription: A\nmode: subagent\n---\n\nagent-a\n"
    const bContent = "---\ndescription: B\nmode: subagent\n---\n\nagent-b\n"
    fs.writeFileSync(aPath, aContent)
    fs.writeFileSync(bPath, bContent)
    const first = await trashAgentFile({ filePath: aPath, roots: [root] })
    const second = await trashAgentFile({ filePath: bPath, roots: [root] })
    assert.notEqual(first.trashPath, second.trashPath, "same-name files must not share one trash path")
    assert.equal(fs.readFileSync(first.trashPath, "utf8"), aContent)
    assert.equal(fs.readFileSync(second.trashPath, "utf8"), bContent)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------- R7-9：.env 保护按文件原值判断，不能被默认档误删 / 误加 ----------

test("R7-9: .env protection survives a default-effect change when read was untouched", () => {
  const baseline = [{ action: "read", resource: "*", effect: "allow" as const }]
  const matrix = { defaultEffect: "deny" as const, actions: allowMatrix().actions }
  const rules = rulesFromMatrix(matrix, baseline)
  assert.ok(
    rules.some((r) => r.action === "read" && r.resource === "*.env" && r.effect === "ask"),
    "read stayed allow → .env ask protection must be kept",
  )
})

test("R7-9: .env protection is not added when read is deny", () => {
  const baseline = [{ action: "read", resource: "*", effect: "deny" as const }]
  const matrix = {
    defaultEffect: "deny" as const,
    actions: Object.fromEntries(ACTIONS.map((a) => [a, "deny"])) as Record<(typeof ACTIONS)[number], "deny">,
  }
  const rules = rulesFromMatrix(matrix, baseline)
  assert.ok(!rules.some((r) => r.resource.endsWith(".env")), "read=deny must not gain an ask rule")
})

// ---------- R7-10：CRLF 文件写回后必须仍是 CRLF ----------

test("R7-10: applyPatchToSource keeps CRLF line endings", () => {
  const raw = "---\r\ndescription: x\r\nmode: subagent\r\n---\r\n\r\nline1\r\nline2\r\n"
  const out = applyPatchToSource(raw, patch())
  assert.doesNotMatch(out, /[^\r]\n/, "output must not contain a bare LF")
})

test("R7-10: setDisabledFile keeps CRLF line endings", async () => {
  const root = tmpDir("crlf-v2")
  try {
    const file = path.join(root, "v2.md")
    fs.writeFileSync(file, "---\r\ndescription: x\r\nmode: subagent\r\npermissions:\r\n  - action: read\r\n    resource: \"*\"\r\n    effect: allow\r\n---\r\n\r\nline1\r\nline2\r\n")
    await setDisabledFile({ filePath: file, roots: [root], disabled: true })
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /[^\r]\n/, "setDisabledFile must keep CRLF")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("R7-10: migrateContent keeps CRLF line endings", () => {
  const out = migrateContent("---\r\nname: t\r\nmode: subagent\r\npermission:\r\n  read: allow\r\n---\r\n\r\nbody\r\n").content
  assert.doesNotMatch(out, /[^\r]\n/, "migrateContent must keep CRLF")
})

// ---------- R7-11：空 frontmatter 必须被识别 ----------

test("R7-11: splitFrontmatter recognises an empty frontmatter block", () => {
  assert.deepEqual(splitFrontmatter("---\n---\nbody\n"), { frontmatter: "", body: "body\n" })
  assert.deepEqual(splitFrontmatter("---\r\n---\r\nbody\r\n"), { frontmatter: "", body: "body\r\n" })
})

// ---------- R7-14：V1 顶层 "*" 是默认档，不是动作 ----------

test("V1 top-level '*' becomes the default effect, not a duplicated action rule", () => {
  assert.equal(matrixFromRules(undefined, { "*": "deny", read: "allow" }).defaultEffect, "deny")
  const migrated = migrateContent(
    "---\nname: t\nmode: subagent\npermission:\n  \"*\": deny\n  read: allow\n---\n\nbody\n",
  ).content
  const rules = (parseAgentFile(migrated).meta.permissions ?? []) as Array<{
    action: string
    resource: string
    effect: string
  }>
  const star = rules.filter((r) => r.action === "*")
  assert.equal(star.length, 1, "exactly one '*' rule")
  assert.equal(rules[0].action, "*", "'*' must stay at the head of the rule array")
  assert.equal(rules[0].effect, "deny")
  assert.ok(rules.some((r) => r.action === "read" && r.resource === "*" && r.effect === "allow"))
})

// ---------- R7-6：project 作用域必须带 projectPath ----------

test("R7-6: resolveAgentsDir validates the project scope input", () => {
  const invalidPath = (e: unknown) => (e as { code?: string }).code === "invalid_path"
  assert.throws(() => resolveAgentsDir("project"), invalidPath)
  assert.throws(() => resolveAgentsDir("project", "   "), invalidPath)
  const userDir = resolveAgentsDir("user")
  assert.equal(typeof userDir, "string")
  assert.ok(userDir.endsWith("agents"))
})

// ---------- R7-7：内置模型覆盖值必须校验 ----------

test("R7-7: isValidBuiltinModel accepts empty and well-formed refs only", () => {
  assert.equal(isValidBuiltinModel(undefined), true)
  assert.equal(isValidBuiltinModel(""), true)
  assert.equal(isValidBuiltinModel("acme/standard"), true)
  assert.equal(isValidBuiltinModel("acme/standard#high"), true)
  assert.equal(isValidBuiltinModel("acme"), false)
  assert.equal(isValidBuiltinModel("a/b#x#y"), false)
  assert.equal(isValidBuiltinModel("a/b#"), false)
})

// ---------- R7-13：win32 下路径白名单必须大小写不敏感 ----------

test("R7-13: win32 path whitelist is case-insensitive", () => {
  if (process.platform !== "win32") return
  const root = path.join(os.homedir(), ".config", "opencode", "agents")
  const target = path.join(root, "x.md")
  assert.doesNotThrow(() => assertAllowedPath(target, [root.toUpperCase()], "write"))
  assert.throws(
    () => assertAllowedPath(path.join(path.parse(root).root, "evil", "x.md"), [root], "write"),
    (e: unknown) => (e as { code?: string }).code === "invalid_path",
  )
})
