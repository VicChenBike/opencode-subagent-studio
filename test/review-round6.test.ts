// test/review-round6.test.ts —— 第六轮审查发现的回归测试（C1–C5 / I1–I3 / I5 / M1 / M2 / M9）。
// 全部驱动真实 GUI 纯函数 + 真实 store 函数，断言落盘后的文件内容。
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  readAgentFile, updateAgentFile, trashAgentFile, createAgentFile, listAgents, hashOf,
} from "../src/core/agent-store.ts"
import { migrateContent, parseAgentFile } from "../src/core/frontmatter.ts"
import { patchFromRead, isConflictError } from "../src/gui/editor-form.ts"
import { renameAgentWithPrompt } from "../src/gui/rename-flow.ts"
import { errorCopyKey } from "../src/gui/error-copy.ts"
import type { PermissionRule } from "../src/rpc.ts"

let tmp: string
beforeEach(() => { tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "osm-r6-")) })
afterEach(() => { fsSync.rmSync(tmp, { recursive: true, force: true }) })

const V1_PROMPT_ONLY = [
  "---",
  "description: Legacy reviewer",
  "mode: subagent",
  "model: acme/standard",
  "variant: high",
  "maxSteps: 7",
  "tools:",
  "  bash: false",
  "  websearch: false",
  "permission:",
  "  read: allow",
  "  edit: ask",
  "prompt: You are a careful reviewer.",
  "---",
  "",
  "",
].join("\n")

function rulesOf(content: string): PermissionRule[] {
  const meta = parseAgentFile(content).meta
  return Array.isArray(meta.permissions) ? (meta.permissions as PermissionRule[]) : []
}

// ---------- C1+C2：V1 开关/保存不得丢 prompt、variant、maxSteps、tools deny ----------

test("C1: read returns migration-effective body/meta for V1 prompt-only files", async () => {
  const file = path.join(tmp, "legacy.md")
  await fs.writeFile(file, V1_PROMPT_ONLY)
  const res = await readAgentFile(file)
  assert.equal(res.format, "v1")
  assert.equal(res.hash, hashOf(V1_PROMPT_ONLY))
  assert.ok(res.body.includes("You are a careful reviewer."), "prompt must be visible as body before editing")
  assert.equal(res.meta.model, "acme/standard#high")
  assert.equal(res.meta.steps, 7)
})

test("C1+C2: read → patchFromRead → update keeps prompt, variant, steps and tool denials", async () => {
  const file = path.join(tmp, "legacy.md")
  await fs.writeFile(file, V1_PROMPT_ONLY)
  const res = await readAgentFile(file)
  await updateAgentFile({
    filePath: file, roots: [tmp], expectedHash: res.hash, patch: patchFromRead(res),
  })
  const written = await fs.readFile(file, "utf8")
  const parsed = parseAgentFile(written)
  assert.equal(parsed.format, "v2")
  assert.ok(written.includes("You are a careful reviewer."), "system prompt survived")
  assert.equal(parsed.meta.model, "acme/standard#high", "variant survived")
  assert.equal(parsed.meta.steps, 7, "maxSteps survived as steps")
  const rules = rulesOf(written)
  assert.ok(rules.some((r) => r.action === "shell" && r.effect === "deny"), "bash:false became shell deny")
  assert.ok(rules.some((r) => r.action === "websearch" && r.effect === "deny"), "websearch:false kept")
  assert.ok(rules.some((r) => r.action === "edit" && r.resource === "*" && r.effect === "ask"), "permission edit:ask kept")
  for (const key of ["prompt", "tools", "variant", "maxSteps", "permission"]) {
    assert.ok(!(key in parsed.meta), `V1 key ${key} must be gone`)
  }
})

// ---------- C3：矩阵外 action 的 * 规则在普通编辑后必须保留 ----------

test("C3: saving a V2 file keeps star rules for actions outside the matrix", async () => {
  const file = path.join(tmp, "extra.md")
  const raw = [
    "---",
    "description: d",
    "mode: subagent",
    "permissions:",
    '  - action: "*"',
    '    resource: "*"',
    "    effect: allow",
    "  - action: todowrite",
    '    resource: "*"',
    "    effect: deny",
    "---",
    "",
    "body",
    "",
  ].join("\n")
  await fs.writeFile(file, raw)
  const res = await readAgentFile(file)
  await updateAgentFile({
    filePath: file, roots: [tmp], expectedHash: res.hash, patch: patchFromRead(res),
  })
  const rules = rulesOf(await fs.readFile(file, "utf8"))
  assert.ok(rules.some((r) => r.action === "todowrite" && r.resource === "*" && r.effect === "deny"),
    "todowrite deny must not be silently dropped (permission escalation)")
})

// ---------- C4：嵌套代理的回收站/备份必须在 agents/ 之外 ----------

test("C4: trashing a nested agent puts trash beside the agents root, not inside it", async () => {
  const proj = path.join(tmp, "proj")
  const agents = path.join(proj, ".opencode", "agents")
  const file = path.join(agents, "team", "reviewer.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "---\ndescription: R\nmode: subagent\n---\n\nbody\n")
  const { trashPath } = await trashAgentFile({ filePath: file, roots: [agents] })
  assert.ok(trashPath.startsWith(path.join(proj, ".opencode", "agents-trash") + path.sep),
    `trash must be beside agents root, got ${trashPath}`)
  assert.ok(!trashPath.startsWith(agents + path.sep), "trash must never be inside agents/")
  assert.ok(!fsSync.existsSync(path.join(agents, "agents-trash")), "no agents-trash dir inside agents/")
})

test("C4: force-overwrite backup of a nested agent stays outside agents/", async () => {
  const proj = path.join(tmp, "proj")
  const agents = path.join(proj, ".opencode", "agents")
  const file = path.join(agents, "team", "reviewer.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const raw = "---\ndescription: R\nmode: subagent\n---\n\nbody\n"
  await fs.writeFile(file, raw)
  const res = await readAgentFile(file)
  await updateAgentFile({
    filePath: file, roots: [agents], expectedHash: "deadbeefdeadbeef", force: true,
    patch: { ...patchFromRead(res), description: "changed" },
  })
  const trash = path.join(proj, ".opencode", "agents-trash")
  assert.ok(fsSync.existsSync(trash), "backup dir beside agents root")
  const backups = await fs.readdir(trash)
  assert.ok(backups.some((n) => n.startsWith(".backup-")), "backup copy exists")
  assert.ok(!fsSync.existsSync(path.join(agents, "agents-trash")), "no backup dir inside agents/")
})

// ---------- C5：tools 的 V1 动作名必须改名后再转 deny ----------

test("C5: tools false values migrate with renamed V2 actions", () => {
  const raw = "---\ndescription: d\nmode: subagent\ntools:\n  bash: false\n  write: false\n  patch: false\n  task: false\n---\n\nbody\n"
  const { content } = migrateContent(raw)
  const rules = rulesOf(content)
  for (const dead of ["bash", "write", "patch", "task"]) {
    assert.ok(!rules.some((r) => r.action === dead), `dead V1 action ${dead} must not appear`)
  }
  assert.ok(rules.some((r) => r.action === "shell" && r.effect === "deny"))
  assert.ok(rules.some((r) => r.action === "edit" && r.effect === "deny"))
  assert.ok(rules.some((r) => r.action === "subagent" && r.effect === "deny"))
})

// ---------- I1：畸形 YAML 必须返回声明错误码，而不是裸 500 ----------

test("I1: update on duplicate-key frontmatter fails with declared invalid_format", async () => {
  const file = path.join(tmp, "dup.md")
  await fs.writeFile(file, "---\ndescription: d\nmode: subagent\nmode: primary\n---\n\nbody\n")
  const res = await readAgentFile(file)
  await assert.rejects(
    updateAgentFile({ filePath: file, roots: [tmp], expectedHash: res.hash, patch: patchFromRead(res) }),
    (err: unknown) => (err as { code?: string }).code === "invalid_format",
  )
  assert.equal(await fs.readFile(file, "utf8"), "---\ndescription: d\nmode: subagent\nmode: primary\n---\n\nbody\n",
    "failed write must not touch the file")
})

// ---------- I2：写入中途失败不得损坏原文件（原子写） ----------

test("I2: a failing rename during write leaves the original file intact", async () => {
  const file = path.join(tmp, "atomic.md")
  const raw = "---\ndescription: d\nmode: subagent\n---\n\noriginal prompt\n"
  await fs.writeFile(file, raw)
  const res = await readAgentFile(file)
  const origRename = fs.rename
  fs.rename = (async () => { throw new Error("simulated mid-write crash") }) as typeof fs.rename
  try {
    await assert.rejects(updateAgentFile({
      filePath: file, roots: [tmp], expectedHash: res.hash,
      patch: { ...patchFromRead(res), body: "new prompt" },
    }))
  } finally {
    fs.rename = origRename
  }
  assert.equal(await fs.readFile(file, "utf8"), raw, "original content must survive a failed write")
  const leftovers = (await fs.readdir(tmp)).filter((n) => n.includes(".tmp-"))
  assert.deepEqual(leftovers, [], "no temp file litter")
})

// ---------- I3：BOM 开头的文件必须可见 ----------

test("I3: BOM-prefixed subagent files are listed and readable", async () => {
  const dir = path.join(tmp, "agents")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "bom.md"), "\uFEFF---\ndescription: B\nmode: subagent\n---\n\nbody\n")
  const list = await listAgents(dir)
  assert.deepEqual(list.map((a) => a.id), ["bom"], "BOM file must not be invisible")
  const res = await readAgentFile(path.join(dir, "bom.md"))
  assert.equal(res.meta.mode, "subagent")
})

// ---------- I5：renameAgentWithPrompt 必须前置校验 ----------

function renameDeps(next: string | undefined, calls: string[]) {
  return {
    confirm: async () => true,
    prompt: async () => next,
    rename: async (input: { path: string; newId: string }) => { calls.push(input.newId); return { path: input.newId } },
    toast: () => {},
    t: (key: string) => key,
  }
}

test("I5: rename to the same ID is rejected locally without an RPC call", async () => {
  const calls: string[] = []
  const result = await renameAgentWithPrompt(renameDeps("same-id", calls), { id: "same-id", path: "/x/same-id.md" })
  assert.equal(result, "invalid")
  assert.deepEqual(calls, [], "server must not be reached for an unchanged ID")
})

test("I5: rename to a nested or reserved ID is rejected locally", async () => {
  const calls: string[] = []
  const nested = await renameAgentWithPrompt(renameDeps("team/reviewer", calls), { id: "reviewer", path: "/x/team/reviewer.md" })
  assert.equal(nested, "invalid")
  const reserved = await renameAgentWithPrompt(renameDeps("general", calls), { id: "reviewer", path: "/x/reviewer.md" })
  assert.equal(reserved, "invalid")
  assert.deepEqual(calls, [])
})

// ---------- M1：存在但不可读的目标不能被当成「不存在」 ----------

test("M1: create refuses to clobber an existing-but-unreadable target", async () => {
  const dir = path.join(tmp, "agents")
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, "locked.md")
  await fs.writeFile(target, "---\ndescription: existing\nmode: subagent\n---\n\nkeep me\n")
  const origRead = fs.readFile
  fs.readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (String(p) === target) { const e = new Error("locked") as Error & { code: string }; e.code = "EBUSY"; throw e }
    return (origRead as (...a: unknown[]) => Promise<string>)(p, ...rest)
  }) as typeof fs.readFile
  try {
    await assert.rejects(createAgentFile({
      dir, id: "locked", description: "new", body: "overwrite", matrix: { defaultEffect: "allow", actions: {} as never },
    }))
  } finally {
    fs.readFile = origRead
  }
  assert.ok((await fs.readFile(target, "utf8")).includes("keep me"), "locked file must not be overwritten")
})

// ---------- M2：conflict 判定不再靠 message 子串 ----------

test("M2: not_found mentioning a file named conflict.md is not a conflict", () => {
  assert.equal(isConflictError({ type: "not_found", message: "agent file not found: /x/conflict.md" }), false)
  assert.equal(isConflictError({ type: "conflict", message: "file changed on disk" }), true)
})

// ---------- M9：所有声明错误码都有本地化文案 ----------

test("M9: every declared error code maps to a copy key", () => {
  assert.equal(errorCopyKey({ type: "invalid_id" }), "error.invalidId")
  assert.equal(errorCopyKey({ type: "reserved_id" }), "error.reservedId")
  assert.equal(errorCopyKey({ type: "migration_required" }), "error.migrationRequired")
  assert.equal(errorCopyKey({ type: "invalid_format" }), "error.invalidFormat")
})