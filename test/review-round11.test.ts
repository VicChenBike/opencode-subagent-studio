// test/review-round11.test.ts —— 第十一轮审查回归（2026-11-08）。
// 覆盖：F1 no-clobber 竞态（create/rename/trash/backup）、F2/F3 RPC 写入边界校验、
// F4 agentsRootOf 大小写、F5 watcher 槽位、F6 契约错误声明、F8 内置覆盖并发、
// F9 setDisabled CAS、GUI-2 parseSteps 严格十进制。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createAgentFile, updateAgentFile, setDisabledFile, renameAgentFile, trashAgentFile,
  agentsRootOf, trashDirFor, hashOf,
} from "../src/core/agent-store.ts"
import type { AgentsWatcher } from "../src/core/watch.ts"
import { writeBuiltinOverride } from "../src/core/builtin.ts"
import { Subagents, ACTIONS } from "../src/rpc.ts"
import type { PermissionMatrix } from "../src/rpc.ts"
import { buildPatch, validateEditor } from "../src/gui/editor-form.ts"
import { toggleDisabled } from "../src/gui/disable-flow.ts"

function tempDir(tag: string): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), `osm-r11-${tag}-`))
}

const FULL_MATRIX: PermissionMatrix = {
  defaultEffect: "allow",
  actions: Object.fromEntries(ACTIONS.map((a) => [a, "allow"])) as PermissionMatrix["actions"],
}

const V2_FILE = "---\ndescription: d\nmode: subagent\npermissions: []\n---\n\nbody\n"

// ---------- F1：no-clobber 必须是原子占位，不是 check-then-act ----------

test("R11-F1a: concurrent creates of the same id — exactly one wins, loser gets exists", async () => {
  const dir = tempDir("f1a")
  try {
    const results = await Promise.allSettled([
      createAgentFile({ dir, id: "race", description: "A", body: "a\n", matrix: FULL_MATRIX }),
      createAgentFile({ dir, id: "race", description: "B", body: "b\n", matrix: FULL_MATRIX }),
    ])
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(rejected.length, 1, "exactly one create must fail with exists")
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "exists")
    const content = await fs.readFile(path.join(dir, "race.md"), "utf8")
    const winner = results.find((r) => r.status === "fulfilled")
    assert.ok(winner, "one create must succeed")
    // 赢家的内容必须完整落盘，不能被输家截断/覆盖
    assert.ok(
      content.includes("description: A") || content.includes("description: B"),
      "winner content must be intact",
    )
    assert.ok(!content.includes("description: A") || !content.includes("description: B"))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F1b: concurrent renames to the same target — loser source must survive", async () => {
  const dir = tempDir("f1b")
  try {
    const one = path.join(dir, "one.md")
    const two = path.join(dir, "two.md")
    await fs.writeFile(one, V2_FILE.replace("description: d", "description: one"), "utf8")
    await fs.writeFile(two, V2_FILE.replace("description: d", "description: two"), "utf8")
    const results = await Promise.allSettled([
      renameAgentFile({ filePath: one, roots: [dir], newId: "target" }),
      renameAgentFile({ filePath: two, roots: [dir], newId: "target" }),
    ])
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(rejected.length, 1, "exactly one rename must fail with exists")
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "exists")
    const survivors = await fs.readdir(dir)
    assert.ok(survivors.includes("target.md"), "winner must own the target")
    assert.ok(
      survivors.includes("one.md") || survivors.includes("two.md"),
      "the loser's source file must still exist (no silent overwrite)",
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F1c: concurrent trash of same-basename files in the same second keeps both", async () => {
  const dir = tempDir("f1c")
  try {
    const agents = path.join(dir, "agents")
    await fs.mkdir(path.join(agents, "a"), { recursive: true })
    await fs.mkdir(path.join(agents, "b"), { recursive: true })
    await fs.writeFile(path.join(agents, "a", "x.md"), V2_FILE, "utf8")
    await fs.writeFile(path.join(agents, "b", "x.md"), V2_FILE, "utf8")
    const results = await Promise.allSettled([
      trashAgentFile({ filePath: path.join(agents, "a", "x.md"), roots: [agents] }),
      trashAgentFile({ filePath: path.join(agents, "b", "x.md"), roots: [agents] }),
    ])
    assert.ok(results.every((r) => r.status === "fulfilled"), "both trashes must succeed")
    const trash = path.join(dir, "agents-trash")
    const entries = await fs.readdir(trash)
    assert.equal(entries.length, 2, "both files must survive in the trash, not overwrite each other")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F1d: concurrent force-overwrite backups do not clobber each other", async () => {
  const dir = tempDir("f1d")
  try {
    const agents = path.join(dir, "agents")
    await fs.mkdir(agents, { recursive: true })
    const file = path.join(agents, "x.md")
    await fs.writeFile(file, V2_FILE, "utf8")
    const staleHash = hashOf(V2_FILE)
    await fs.writeFile(file, V2_FILE.replace("body", "externally changed"), "utf8")
    const patch = { description: "d", body: "new\n", matrix: FULL_MATRIX }
    const results = await Promise.allSettled([
      updateAgentFile({ filePath: file, roots: [agents], expectedHash: staleHash, patch, force: true }),
      updateAgentFile({ filePath: file, roots: [agents], expectedHash: staleHash, patch, force: true }),
    ])
    assert.ok(results.every((r) => r.status === "fulfilled"), "force updates must succeed")
    const trash = path.join(dir, "agents-trash")
    const backups = (await fs.readdir(trash)).filter((n) => n.startsWith(".backup-"))
    assert.equal(backups.length, 2, "each force overwrite must keep its own backup")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------- F2：matrix / patch 的结构校验（RPC 边界） ----------

test("R11-F2a: create rejects a structurally malformed matrix with invalid_format", async () => {
  const dir = tempDir("f2a")
  try {
    for (const matrix of [{}, { defaultEffect: "allow" }, { actions: FULL_MATRIX.actions }]) {
      await assert.rejects(
        () => createAgentFile({ dir, id: "bad", description: "d", body: "b\n", matrix: matrix as unknown as PermissionMatrix }),
        (e: Error & { code?: string }) => e.code === "invalid_format",
        `matrix ${JSON.stringify(matrix)} must be invalid_format`,
      )
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F2b: create rejects non-string effect values instead of writing them to YAML", async () => {
  const dir = tempDir("f2b")
  try {
    const matrix = { defaultEffect: "allow", actions: { ...FULL_MATRIX.actions, read: 123 } }
    await assert.rejects(
      () => createAgentFile({ dir, id: "bad", description: "d", body: "b\n", matrix: matrix as unknown as PermissionMatrix }),
      (e: Error & { code?: string }) => e.code === "invalid_format",
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F2c: update rejects a malformed patch with invalid_format, file untouched", async () => {
  const dir = tempDir("f2c")
  try {
    const file = path.join(dir, "x.md")
    await fs.writeFile(file, V2_FILE, "utf8")
    const hash = hashOf(V2_FILE)
    for (const patch of [{}, { description: "d" }, { description: "d", body: "b\n" }]) {
      await assert.rejects(
        () => updateAgentFile({ filePath: file, roots: [dir], expectedHash: hash, patch: patch as never }),
        (e: Error & { code?: string }) => e.code === "invalid_format",
        `patch ${JSON.stringify(patch)} must be invalid_format`,
      )
    }
    assert.equal(await fs.readFile(file, "utf8"), V2_FILE, "failed validation must not write")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------- F3：steps / color / model 的写入侧语义校验 ----------

test("R11-F3a: create rejects invalid steps, color and model values", async () => {
  const dir = tempDir("f3a")
  try {
    const base = { dir, id: "bad", description: "d", body: "b\n", matrix: FULL_MATRIX }
    const invalid: Record<string, unknown>[] = [
      { steps: -1 }, { steps: 0 }, { steps: 1.5 }, { steps: NaN }, { steps: Number.MAX_SAFE_INTEGER + 1 },
      { color: "red" }, { color: "#12345" }, { color: "#1234567" },
      { model: "no-slash" }, { model: "a/b#" }, { model: "a/b#c#d" }, { model: "/bare" },
    ]
    for (const extra of invalid) {
      await assert.rejects(
        () => createAgentFile({ ...base, ...extra } as never),
        (e: Error & { code?: string }) => e.code === "invalid_format",
        `${JSON.stringify(extra)} must be invalid_format`,
      )
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F3b: update rejects invalid steps/color/model, file untouched", async () => {
  const dir = tempDir("f3b")
  try {
    const file = path.join(dir, "x.md")
    await fs.writeFile(file, V2_FILE, "utf8")
    const hash = hashOf(V2_FILE)
    const base = { filePath: file, roots: [dir], expectedHash: hash }
    for (const extra of [{ steps: 0 }, { color: "blue" }, { model: "garbage" }]) {
      await assert.rejects(
        () => updateAgentFile({ ...base, patch: { description: "d", body: "b\n", matrix: FULL_MATRIX, ...extra } } as never),
        (e: Error & { code?: string }) => e.code === "invalid_format",
        `${JSON.stringify(extra)} must be invalid_format`,
      )
    }
    assert.equal(await fs.readFile(file, "utf8"), V2_FILE)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------- F4：agentsRootOf 的 basename 比较在 win32 下必须大小写不敏感 ----------

test("R11-F4: agentsRootOf handles mixed-case .OpenCode/Agents on win32", () => {
  if (process.platform !== "win32") return
  const root = tempDir("f4")
  try {
    const agents = path.join(root, ".OpenCode", "Agents")
    const nested = path.join(agents, "team", "x.md")
    assert.equal(agentsRootOf(nested), agents, "must find the mixed-case agents root, not the nested dir")
    assert.equal(trashDirFor(agentsRootOf(nested)), path.join(root, ".OpenCode", "agents-trash"))
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true })
  }
})

// ---------- F5：watcher 槽位——并发替换不能泄漏旧句柄 ----------

test("R11-F5: watcher slot closes the replaced watcher", async () => {
  const { createWatcherSlot } = await import("../src/core/watch.ts")
  const slot = createWatcherSlot()
  const closed: string[] = []
  const w1 = { close: () => { closed.push("w1") } } as AgentsWatcher
  const w2 = { close: () => { closed.push("w2") } } as AgentsWatcher
  slot.replace(w1)
  slot.replace(w2)
  assert.deepEqual(closed, ["w1"], "replacing must close the previous watcher")
  slot.replace(null)
  assert.deepEqual(closed, ["w1", "w2"], "stopping must close the current watcher")
  slot.close()
  assert.deepEqual(closed, ["w1", "w2"], "close is idempotent")
})

// ---------- F6：remove/update 契约必须声明 exists（回收站名耗尽路径） ----------

test("R11-F6: remove and update declare the exists error used by trash-name exhaustion", () => {
  assert.ok("exists" in (Subagents.methods.remove.errors ?? {}), "remove must declare exists")
  assert.ok("exists" in (Subagents.methods.update.errors ?? {}), "update must declare exists")
})

// ---------- F8：内置覆盖并发写入必须按键串行 ----------

test("R11-F8: concurrent builtin override writes keep cache consistent with storage order", async () => {
  const pending: { key: string; value: string; resolve: () => void }[] = []
  const storage = {
    set: (key: string, value: string) => new Promise<void>((resolve) => { pending.push({ key, value, resolve }) }),
    remove: (_key: string) => Promise.resolve(),
  }
  const cache = new Map<string, string>()
  const p1 = writeBuiltinOverride(storage, cache, "general", "acme/one")
  const p2 = writeBuiltinOverride(storage, cache, "general", "acme/two")
  const tick = () => new Promise<void>((r) => setImmediate(r))
  await tick()
  // 永远先 resolve 最新到达的写：无串行时旧值会后落缓存，覆盖新值
  while (pending.length > 0) {
    pending.pop()!.resolve()
    await tick()
  }
  await Promise.all([p1, p2])
  assert.equal(cache.get("builtin-model.general"), "acme/two", "cache must reflect the last write, not the last resolution")
})

// ---------- F9：setDisabled 必须带 expectedHash 做 CAS ----------

test("R11-F9a: setDisabled with a stale expectedHash reports conflict and leaves the file alone", async () => {
  const dir = tempDir("f9a")
  try {
    const file = path.join(dir, "x.md")
    await fs.writeFile(file, V2_FILE, "utf8")
    await assert.rejects(
      () => setDisabledFile({ filePath: file, roots: [dir], disabled: true, expectedHash: "stale" } as never),
      (e: Error & { code?: string }) => e.code === "conflict",
    )
    assert.equal(await fs.readFile(file, "utf8"), V2_FILE, "conflict must not write")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F9b: setDisabled with the current hash toggles and returns the new hash", async () => {
  const dir = tempDir("f9b")
  try {
    const file = path.join(dir, "x.md")
    await fs.writeFile(file, V2_FILE, "utf8")
    const result = await setDisabledFile({ filePath: file, roots: [dir], disabled: true, expectedHash: hashOf(V2_FILE) } as never)
    const raw = await fs.readFile(file, "utf8")
    assert.ok(raw.includes("disabled: true"))
    assert.equal(result.hash, hashOf(raw))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("R11-F9c: the toggle flow passes the row hash for v2 and the post-migration hash for v1", async () => {
  const calls: { path: string; disabled: boolean; expectedHash?: string }[] = []
  const deps = {
    migratePreview: async () => ({ before: "old", after: "new", changes: [] }),
    confirmMigration: async () => true,
    read: async () => ({ meta: { description: "d" }, body: "b\n", format: "v1" as const, hash: "read-hash", mtime: 1 }),
    update: async () => ({ hash: "post-migration-hash" }),
    setDisabled: async (input: { path: string; disabled: boolean; expectedHash?: string }) => {
      calls.push(input)
      return { hash: "final" }
    },
    toast: () => {},
    t: (key: string) => key,
  }
  await toggleDisabled(deps, { id: "a", path: "/a.md", format: "v2", hash: "row-hash" } as never, true)
  assert.deepEqual(calls[0], { path: "/a.md", disabled: true, expectedHash: "row-hash" })
  await toggleDisabled(deps, { id: "b", path: "/b.md", format: "v1", hash: "stale-row" } as never, true)
  assert.deepEqual(calls[1], { path: "/b.md", disabled: true, expectedHash: "post-migration-hash" })
})

// ---------- GUI-2：parseSteps 只接受十进制安全整数 ----------

test("R11-G2: steps text accepts only plain decimal safe integers", () => {
  const base = { description: "d", body: "b\n", matrix: FULL_MATRIX }
  for (const text of ["0x10", "1e3", "9007199254740993", "8.0", "+8", "08a"]) {
    const patch = buildPatch({ ...base, stepsText: text })
    assert.equal(patch.steps, undefined, `"${text}" must not produce steps`)
    const v = validateEditor({ mode: "create", id: "ok", description: "d", stepsText: text, existingIds: [] })
    assert.equal(v.stepsError, "invalid", `"${text}" must be flagged invalid`)
  }
  assert.equal(buildPatch({ ...base, stepsText: " 8 " }).steps, 8, "plain decimal with whitespace still works")
})