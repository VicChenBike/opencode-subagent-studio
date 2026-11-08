// test/review-round12.test.ts —— 第十二轮服务端审查回归（2026-11-08）。
// 覆盖：S-12-1 契约错误声明、S-12-2 路径形状大小写、S-12-3 unlink 重试+回滚、
// S-12-4 项目根索引错位、S-12-5 冗余存在性预检查、S-12-6 EISDIR/EACCES 映射、
// S-12-7 硬链接不可用时的降级路径、S-12-8→R-12-1 modelID 含斜杠（宿主首斜杠语义）、
// S-12-9 variant 合并校验、S-12-10 映射形态 permissions 保留、G-12-2 rename EPERM 重试。
// 先写测试后修实现（TDD）：这些用例在修复前应当失败，修复后必须全绿。
import { test, mock } from "node:test"
import assert from "node:assert/strict"
import fsSync from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertAllowedPath, createAgentFile, renameAgentFile, trashAgentFile, updateAgentFile,
  readAgentFile, previewMigrationFile, hashOf, setRetryDelayForTests,
} from "../src/core/agent-store.ts"
import { parseModelRef } from "../src/core/model-ref.ts"
import { migrateContent, applyPatchToSource, parseAgentFile } from "../src/core/frontmatter.ts"
import { matrixFromRules } from "../src/core/permissions.ts"
import { Subagents, ACTIONS } from "../src/rpc.ts"
import type { PermissionMatrix, PermissionRule } from "../src/rpc.ts"
import { projectRootOf } from "../src/index.ts"

function tempDir(tag: string): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), `osm-r12-${tag}-`))
}

const FULL_MATRIX: PermissionMatrix = {
  defaultEffect: "allow",
  actions: Object.fromEntries(ACTIONS.map((a) => [a, "allow"])) as PermissionMatrix["actions"],
}

const V2_FILE = "---\ndescription: d\nmode: subagent\npermissions: []\n---\n\nbody\n"

function errWithCode(code: string, message = `${code}: injected`): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

// 重试退避可注入：测试用零延迟，避免依赖真实定时器造成 flaky。
function withZeroRetryDelay(): void {
  setRetryDelayForTests(async () => {})
}

// ---------- S-12-1：create 契约必须声明 invalid_format ----------

test("R12-S1: create declares invalid_format (write-side assertValidPatch can throw it)", () => {
  const errors = Subagents.methods.create.errors ?? {}
  assert.ok("invalid_format" in errors, "create.errors must declare invalid_format")
  for (const name of ["update", "rename", "setDisabled"] as const) {
    assert.ok("invalid_format" in (Subagents.methods[ name ].errors ?? {}), `${name} already declares it`)
  }
})

// ---------- S-12-2：read 模式的 <x>/.opencode/agents 形状必须大小写不敏感 ----------

test("R12-S2: read-mode project shape is case-insensitive like the write whitelist", () => {
  const root = tempDir("s2")
  try {
    const mixed = path.join(root, ".OpenCode", "Agents", "a.md")
    assert.doesNotThrow(() => assertAllowedPath(mixed, [], "read"), "mixed-case project shape must be readable")
    assert.doesNotThrow(() => assertAllowedPath(path.join(root, ".OpenCode", "Agents", "team", "x.md"), [], "read"))
    // 写路径仍然只认白名单根：大小写放宽不能顺带放宽写入
    assert.throws(
      () => assertAllowedPath(mixed, [], "write"),
      (e: unknown) => (e as { code?: string }).code === "invalid_path",
    )
    // 形状不匹配的普通路径仍被拒
    assert.throws(
      () => assertAllowedPath(path.join(root, "plain", "a.md"), [], "read"),
      (e: unknown) => (e as { code?: string }).code === "invalid_path",
    )
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true })
  }
})

// ---------- S-12-3：unlink 失败必须回滚刚占位的目标 ----------

test("R12-S3a: rename rolls back the placed target when unlink keeps failing", async () => {
  const dir = tempDir("s3a")
  withZeroRetryDelay()
  let unlinkCalls = 0
  mock.method(fsp, "unlink", async () => {
    unlinkCalls++
    throw errWithCode("EBUSY", "EBUSY: resource busy or locked")
  })
  try {
    const source = path.join(dir, "one.md")
    await fsp.writeFile(source, V2_FILE, "utf8")
    await assert.rejects(
      () => renameAgentFile({ filePath: source, roots: [dir], newId: "two" }),
      (e: unknown) => (e as { code?: string }).code === "EBUSY",
      "the original error must surface (fail-loud)",
    )
    assert.equal(unlinkCalls, 3, "unlink must be retried a short number of times")
    const entries = await fsp.readdir(dir)
    assert.deepEqual(entries.sort(), ["one.md"], "target must be rolled back, source must survive")
  } finally {
    mock.restoreAll()
    setRetryDelayForTests(null)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("R12-S3b: trash rolls back the placed trash file when unlink keeps failing", async () => {
  const dir = tempDir("s3b")
  withZeroRetryDelay()
  mock.method(fsp, "unlink", async () => {
    throw errWithCode("EPERM", "EPERM: operation not permitted")
  })
  try {
    const agents = path.join(dir, "agents")
    await fsp.mkdir(agents, { recursive: true })
    const source = path.join(agents, "victim.md")
    await fsp.writeFile(source, V2_FILE, "utf8")
    await assert.rejects(
      () => trashAgentFile({ filePath: source, roots: [agents] }),
      (e: unknown) => (e as { code?: string }).code === "EPERM",
    )
    assert.deepEqual(await fsp.readdir(agents), ["victim.md"], "source must survive a failed trash")
    const trash = path.join(dir, "agents-trash")
    assert.deepEqual(await fsp.readdir(trash), [], "no half-placed file may stay in the trash")
  } finally {
    mock.restoreAll()
    setRetryDelayForTests(null)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// ---------- G-12-2：atomicWrite 的 rename 遇 EPERM/EBUSY 必须短重试 ----------

test("R12-G2a: atomicWrite retries rename on EPERM and then succeeds", async () => {
  const dir = tempDir("g2a")
  withZeroRetryDelay()
  const originalRename = fsp.rename
  let renameCalls = 0
  mock.method(fsp, "rename", async (from: unknown, to: unknown) => {
    renameCalls++
    if (renameCalls <= 2) throw errWithCode("EPERM", "EPERM: operation not permitted")
    return (originalRename as (...a: unknown[]) => Promise<void>)(from, to)
  })
  try {
    const file = path.join(dir, "x.md")
    await fsp.writeFile(file, V2_FILE, "utf8")
    const result = await updateAgentFile({
      filePath: file, roots: [dir], expectedHash: hashOf(V2_FILE),
      patch: { description: "d2", body: "b2\n", matrix: FULL_MATRIX },
    })
    assert.equal(renameCalls, 3, "rename must be attempted three times")
    const raw = await fsp.readFile(file, "utf8")
    assert.ok(raw.includes("description: d2"), "the third attempt must land the write")
    assert.equal(result.hash, hashOf(raw))
  } finally {
    mock.restoreAll()
    setRetryDelayForTests(null)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("R12-G2b: atomicWrite surfaces the original error after exhausting retries and cleans tmp", async () => {
  const dir = tempDir("g2b")
  withZeroRetryDelay()
  let renameCalls = 0
  mock.method(fsp, "rename", async () => {
    renameCalls++
    throw errWithCode("EBUSY", "EBUSY: resource busy or locked")
  })
  try {
    const file = path.join(dir, "x.md")
    await fsp.writeFile(file, V2_FILE, "utf8")
    await assert.rejects(
      () => updateAgentFile({
        filePath: file, roots: [dir], expectedHash: hashOf(V2_FILE),
        patch: { description: "d2", body: "b2\n", matrix: FULL_MATRIX },
      }),
      (e: unknown) => (e as { code?: string }).code === "EBUSY",
    )
    assert.equal(renameCalls, 3)
    assert.deepEqual(await fsp.readdir(dir), ["x.md"], "temporary file must be cleaned up")
    assert.equal(await fsp.readFile(file, "utf8"), V2_FILE, "the original file must stay intact")
  } finally {
    mock.restoreAll()
    setRetryDelayForTests(null)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// ---------- S-12-4：项目根索引必须在原串上求（toLowerCase 会膨胀） ----------

test("R12-S4: projectRootOf computes the real index on the original string", () => {
  const root = path.join(os.tmpdir(), "İİİproj") // 每个 İ 小写化后变成 2 个码元
  const file = path.join(root, ".opencode", "agents", "x.md")
  assert.equal(projectRootOf(file), root, "index must not be shifted by lowercase expansion")
  assert.equal(projectRootOf(path.join(os.tmpdir(), "plain", "a.md")), null)
  assert.equal(projectRootOf(path.join(root, ".OpenCode", "Agents", "x.md")), root, "case-insensitive marker")
})

// ---------- S-12-5：F1 原子占位落地后，存在性预检查必须删除 ----------

test("R12-S5a: create reports exists even when the existing target is unreadable", async () => {
  const dir = tempDir("s5a")
  const originalReadFile = fsp.readFile
  try {
    await fsp.writeFile(path.join(dir, "taken.md"), V2_FILE, "utf8")
    mock.method(fsp, "readFile", async (p: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith("taken.md")) throw errWithCode("EACCES", "EACCES: permission denied")
      return (originalReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    })
    await assert.rejects(
      () => createAgentFile({ dir, id: "taken", description: "d", body: "b\n", matrix: FULL_MATRIX }),
      (e: unknown) => (e as { code?: string }).code === "exists",
      "link/wx EEXIST is authoritative; no read permission needed",
    )
  } finally {
    mock.restoreAll()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("R12-S5b: rename reports exists even when the existing target is unreadable", async () => {
  const dir = tempDir("s5b")
  const originalReadFile = fsp.readFile
  try {
    await fsp.writeFile(path.join(dir, "src.md"), V2_FILE, "utf8")
    await fsp.writeFile(path.join(dir, "taken.md"), V2_FILE, "utf8")
    mock.method(fsp, "readFile", async (p: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith("taken.md")) throw errWithCode("EACCES", "EACCES: permission denied")
      return (originalReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    })
    await assert.rejects(
      () => renameAgentFile({ filePath: path.join(dir, "src.md"), roots: [dir], newId: "taken" }),
      (e: unknown) => (e as { code?: string }).code === "exists",
    )
    assert.deepEqual((await fsp.readdir(dir)).sort(), ["src.md", "taken.md"], "loser source must survive")
  } finally {
    mock.restoreAll()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// ---------- S-12-6：目录 / 权限错误必须映射成契约错误码 ----------

test("R12-S6a: readAgentFile maps a directory path to invalid_path", async () => {
  const dir = tempDir("s6a")
  try {
    const sub = path.join(dir, "sub")
    await fsp.mkdir(sub)
    await assert.rejects(
      () => readAgentFile(sub),
      (e: unknown) => (e as { code?: string }).code === "invalid_path",
      "EISDIR must not become a bare 500",
    )
    await assert.rejects(
      () => readAgentFile(path.join(dir, "missing.md")),
      (e: unknown) => (e as { code?: string }).code === "not_found",
      "missing file stays not_found",
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("R12-S6b: previewMigrationFile maps a directory path to invalid_path", async () => {
  const dir = tempDir("s6b")
  try {
    const sub = path.join(dir, "sub")
    await fsp.mkdir(sub)
    await assert.rejects(
      () => previewMigrationFile({ filePath: sub }),
      (e: unknown) => (e as { code?: string }).code === "invalid_path",
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// ---------- S-12-7：硬链接不可用（exFAT/FAT32/NAS）时的降级路径 ----------

test("R12-S7: create/rename/trash degrade when fs.link is unsupported", async () => {
  const dir = tempDir("s7")
  const agents = path.join(dir, "agents")
  try {
    await fsp.mkdir(agents, { recursive: true })
    mock.method(fsp, "link", async () => {
      throw errWithCode("EPERM", "EPERM: operation not permitted (no hard links on this volume)")
    })
    // create：wx 排他创建
    const created = await createAgentFile({ dir: agents, id: "fresh", description: "F", body: "b\n", matrix: FULL_MATRIX })
    assert.ok((await fsp.readFile(created, "utf8")).includes("description: F"))
    // create 重复：wx 的 EEXIST 仍是权威裁决
    await assert.rejects(
      () => createAgentFile({ dir: agents, id: "fresh", description: "F2", body: "b\n", matrix: FULL_MATRIX }),
      (e: unknown) => (e as { code?: string }).code === "exists",
    )
    // rename：copyFile(EXCL) + unlink
    const renamed = await renameAgentFile({ filePath: created, roots: [agents], newId: "renamed" })
    assert.deepEqual((await fsp.readdir(agents)).sort(), ["renamed.md"])
    assert.ok((await fsp.readFile(renamed.path, "utf8")).includes("description: F"))
    // trash：copyFile(EXCL) + unlink
    const { trashPath } = await trashAgentFile({ filePath: renamed.path, roots: [agents] })
    assert.deepEqual(await fsp.readdir(agents), [])
    assert.ok((await fsp.readFile(trashPath, "utf8")).includes("description: F"))
  } finally {
    mock.restoreAll()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// ---------- S-12-8 → R-12-1：modelID 含 "/" 是宿主合法引用（首斜杠切分） ----------

// 最终 Code Review R-12-1 实证宿主二进制：Model.Ref.parse 按第一个 "/" 切分，
// modelID 可含 "/"（models.dev 目录 id 如 openrouter/anthropic/claude-sonnet-4）。
// 第十二轮 S-12-8 曾误判其为坏值，这里固定与宿主一致的语义，真坏值仍拒绝。
test("R12-S8: parseModelRef keeps host semantics — modelID may contain slashes (split on first)", async () => {
  assert.deepEqual(parseModelRef("acme/org/mini"), { providerID: "acme", modelID: "org/mini", variant: undefined })
  assert.deepEqual(parseModelRef("a/b/c#v"), { providerID: "a", modelID: "b/c", variant: "v" })
  // 真坏值仍拒绝：无 "/"、多个 "#"、空 variant
  assert.equal(parseModelRef("noslash"), null)
  assert.equal(parseModelRef("acme/standard#high#low"), null)
  assert.equal(parseModelRef("acme/standard#"), null)
  // 写盘边界：嵌套 model id 的引用可以正常创建进文件
  const dir = tempDir("s8")
  try {
    const created = await createAgentFile({
      dir, id: "nested", description: "d", body: "b\n", model: "acme/org/mini", matrix: FULL_MATRIX,
    })
    const raw = await fsp.readFile(created, "utf8")
    assert.match(raw, /model: acme\/org\/mini/, "the nested model ref must be written verbatim")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// ---------- S-12-9：V1 model+variant 合并结果必须过 parseModelRef ----------

test("R12-S9: an unmergeable variant is dropped and recorded instead of written invalid", () => {
  const bad = migrateContent("---\nname: t\nmode: subagent\nmodel: a/b#v\nvariant: x\n---\n\nbody\n")
  const badMeta = parseAgentFile(bad.content).meta
  assert.equal(badMeta.model, "a/b#v", "model must stay untouched")
  assert.equal("variant" in badMeta, false, "variant key must be removed")
  assert.ok(
    bad.changes.some((c) => c.field === "variant" && c.action === "delete"),
    "the dropped variant must be reported as a change",
  )

  const noSlash = migrateContent("---\nname: t\nmode: subagent\nmodel: acme\nvariant: x\n---\n\nbody\n")
  assert.equal(parseAgentFile(noSlash.content).meta.model, "acme")

  const good = migrateContent("---\nname: t\nmode: subagent\nmodel: a/b\nvariant: x\n---\n\nbody\n")
  assert.equal(parseAgentFile(good.content).meta.model, "a/b#x")
  assert.ok(good.changes.some((c) => c.field === "model" && c.action === "merge" && c.to === "a/b#x"))
})

// ---------- S-12-10：映射形态 permissions 在保存时不能被静默丢弃 ----------

test("R12-S10: mapping-form permissions survive read → matrix → save", async () => {
  const dir = tempDir("s10")
  try {
    const file = path.join(dir, "mapped.md")
    const raw = [
      "---",
      "description: d",
      "mode: subagent",
      "permissions:",
      '  "*": allow',
      "  read: ask",
      "  todowrite: deny",
      "  edit:",
      '    "src/**": deny',
      "---",
      "",
      "body",
      "",
    ].join("\n")
    await fsp.writeFile(file, raw, "utf8")

    const read = await readAgentFile(file)
    const rules = read.meta.permissions
    assert.ok(Array.isArray(rules), "mapping form must be exposed to the editor as a rule array")
    const matrix = matrixFromRules(rules as PermissionRule[])
    assert.equal(matrix.actions.read, "ask", "the mapping's read effect must reach the matrix")
    assert.equal(matrix.defaultEffect, "allow")

    const out = applyPatchToSource(raw, { description: "d", body: "body\n", matrix })
    const after = parseAgentFile(out).meta.permissions as PermissionRule[]
    assert.equal(after[0].action, "*", "the default rule must stay at the head (R7-14)")
    assert.equal(after[0].effect, "allow")
    assert.ok(
      after.some((r) => r.action === "read" && r.resource === "*" && r.effect === "ask"),
      "read: ask must not be silently replaced",
    )
    assert.ok(after.some((r) => r.action === "todowrite" && r.effect === "deny"), "non-matrix action rules survive")
    assert.ok(
      after.some((r) => r.action === "edit" && r.resource === "src/**" && r.effect === "deny"),
      "fine-grained resources survive",
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
