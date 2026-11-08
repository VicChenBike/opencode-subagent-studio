// test/server-handlers.test.ts —— 服务端 RPC handler 与宿主契约的接缝测试。
// 桌面端实测（2026-11-07）：/api/rpc/subagent-manager/list 返回 500，宿主日志 "Error: Unknown error"。
// 根因是宿主对 handler 输出按 output schema 做 encode，而 listAgents 产出的行里可选字段是
// 「值为 undefined 的自有属性」，schema 声明为 string 时 encode 抛错。这里用 effect 的
// JSON Schema → Schema 转换（与宿主同一套）复现该行为，避免再次回归。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as E from "effect"
import { Subagents } from "../src/rpc.ts"
import { listAgents } from "../src/core/agent-store.ts"

const toEffectSchema = (jsonSchema: unknown) =>
  E.SchemaRepresentation.fromJsonSchemaDocument({
    dialect: "draft-2020-12",
    schema: jsonSchema,
    definitions: {},
  } as never)

const encodeListOutput = (value: unknown) =>
  E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.list.output) as never)(value)

const decodeListInput = (value: unknown) =>
  E.Schema.decodeUnknownSync(toEffectSchema(Subagents.methods.list.input) as never)(value)

function withTempAgents(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-handler-"))
    try {
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content)
      }
      await run(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

test("list output encodes through the host's output schema when some agents lack color/model", withTempAgents({
  "with-color.md": "---\ndescription: Has color\nmode: subagent\ncolor: \"#ff0000\"\nmodel: acme/standard\n---\n\nx\n",
  "plain.md": "---\ndescription: No color\nmode: subagent\n---\n\nx\n",
}, async (dir) => {
  const agents = await listAgents(dir)
  const payload = { agents, builtins: [{ id: "general" as const }, { id: "explore" as const }] }
  assert.doesNotThrow(() => encodeListOutput(payload), "list output must encode without throwing")
}))

test("list output encodes for a directory with no agents", withTempAgents({}, async (dir) => {
  const agents = await listAgents(dir)
  assert.deepEqual(agents, [])
  assert.doesNotThrow(() => encodeListOutput({ agents, builtins: [{ id: "general" as const }] }))
}))

test("list input accepts the shape the GUI sends", () => {
  assert.doesNotThrow(() => decodeListInput({ scope: "user" }))
  assert.doesNotThrow(() => decodeListInput({ scope: "project", projectPath: "C:/tmp/proj" }))
})

test("list input rejects a missing scope", () => {
  assert.throws(() => decodeListInput({}))
})

test("every declared method input/output converts to a host schema", () => {
  for (const [name, def] of Object.entries(Subagents.methods)) {
    assert.doesNotThrow(() => toEffectSchema(def.input), `${name}.input must convert`)
    assert.doesNotThrow(() => toEffectSchema(def.output), `${name}.output must convert`)
  }
})

// 每个方法的输出都必须能被宿主的 output schema 编码。用「可选字段全部缺省」的最小样例，
// 复现 2026-11-07 的 list 500 那类问题（可选字段以 undefined 自有属性存在时 encode 抛错）。
test("every method output encodes with optional fields absent", () => {
  const samples: Record<string, unknown> = {
    list: {
      agents: [{ id: "a", path: "p", description: "d", disabled: false, hidden: false, format: "v1", hash: "h", mtime: 1 }],
      builtins: [{ id: "general" }],
    },
    read: { meta: {}, body: "", format: "v1", hash: "h", mtime: 1 },
    create: { path: "p" },
    update: { hash: "h" },
    remove: { trashPath: "t" },
    rename: { path: "p" },
    setDisabled: { hash: "h" },
    models: { providers: [{ id: "x", name: "X", models: [{ id: "m", name: "M", variants: [] }] }] },
    builtinOverrides: {},
    setBuiltinModel: {},
    migratePreview: { before: "", after: "", changes: [] },
    watchProject: {},
  }
  for (const [name, def] of Object.entries(Subagents.methods)) {
    const encode = E.Schema.encodeUnknownSync(toEffectSchema(def.output) as never)
    assert.doesNotThrow(() => encode(samples[name]), `${name}.output must encode with optionals absent`)
  }
})

test("list output encodes rows produced from the real user agents directory shape", withTempAgents({
  "has-everything.md": "---\ndescription: Full\nmode: subagent\ncolor: \"#8b5cf6\"\nmodel: acme/standard#high\nhidden: true\n---\n\nx\n",
  "only-description.md": "---\ndescription: Minimal\nmode: subagent\n---\n\nx\n",
  "v2-disabled.md": "---\ndescription: Off\nmode: subagent\ndisabled: true\npermissions: []\n---\n\nx\n",
}, async (dir) => {
  const agents = await listAgents(dir)
  assert.equal(agents.length, 3)
  // 可选字段缺省的行走「无该自有属性」路径，而非 undefined
  for (const a of agents) {
    for (const key of ["color", "model"] as const) {
      if (a[key] === undefined) {
        assert.equal(Object.prototype.hasOwnProperty.call(a, key), false, `${a.id}.${key} must be absent, not undefined`)
      }
    }
  }
  const payload = { agents, builtins: [{ id: "general" as const }, { id: "explore" as const }] }
  assert.doesNotThrow(() => encodeListOutput(payload))
}))

// 写方法的输出同样必须能在「可选字段缺省」时过宿主 schema 编码。
// 用真实文件走一遍 create / update / setDisabled / rename / remove，再编码每个返回值。
test("write method outputs all encode through the host schemas", withTempAgents({
  "seed.md": "---\ndescription: Seed\nmode: subagent\n---\n\nseed body\n",
}, async (dir) => {
  const { createAgentFile, updateAgentFile, setDisabledFile, renameAgentFile, trashAgentFile } = await import("../src/core/agent-store.ts")
  const matrix = {
    defaultEffect: "allow" as const,
    actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow", shell: "allow",
      webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } as const,
  }

  const created = await createAgentFile({ dir, id: "fresh", description: "F", body: "b\n", matrix })
  assert.doesNotThrow(() => E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.create.output) as never)({ path: created }))

  const raw = await import("node:fs/promises").then((m) => m.readFile(created, "utf8"))
  const { hashOf } = await import("../src/core/agent-store.ts")
  const updated = await updateAgentFile({
    filePath: created, roots: [dir], expectedHash: hashOf(raw),
    patch: { description: "F2", body: "b2\n", matrix },
  })
  assert.doesNotThrow(() => E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.update.output) as never)(updated))

  const toggled = await setDisabledFile({ filePath: created, roots: [dir], disabled: true, expectedHash: updated.hash })
  assert.doesNotThrow(() => E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.setDisabled.output) as never)(toggled))

  const renamed = await renameAgentFile({ filePath: created, roots: [dir], newId: "renamed-fresh" })
  assert.doesNotThrow(() => E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.rename.output) as never)(renamed))

  const trashed = await trashAgentFile({ filePath: renamed.path, roots: [dir] })
  assert.doesNotThrow(() => E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.remove.output) as never)(trashed))
}))

// models 输出：真实 provider 结构（含空 variants）也要能编码
test("models output encodes with empty variants", () => {
  const payload = {
    providers: [{ id: "acme", name: "acme", models: [{ id: "standard", name: "Standard", variants: [] }] }],
  }
  assert.doesNotThrow(() => E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.models.output) as never)(payload))
})

// migratePreview 输出：无变化（空 changes）也要能编码
test("migratePreview output encodes with an empty change list", () => {
  const payload = { before: "a", after: "a", changes: [] }
  assert.doesNotThrow(() => E.Schema.encodeUnknownSync(toEffectSchema(Subagents.methods.migratePreview.output) as never)(payload))
})

// P2-T7：新建流程端到端（createInputOf → createAgentFile → 列表出现 → 重名被拒）
test("create flow writes a v2 file, then shows up in the list and rejects a duplicate", withTempAgents({}, async (dir) => {
  const { createAgentFile, listAgents } = await import("../src/core/agent-store.ts")
  const { createInputOf } = await import("../src/gui/editor-form.ts")
  const matrix = {
    defaultEffect: "allow" as const,
    actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow", shell: "allow",
      webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } as const,
  }
  // 与 editor.tsx 完全相同的入参构造
  const input = createInputOf({
    scope: { kind: "user" },
    id: "my-agent",
    patch: { description: "My agent", body: "Do the thing.\n", model: "acme/standard#high", hidden: true, steps: 6, matrix },
  })
  assert.equal("projectPath" in input, false)

  const filePath = await createAgentFile({
    dir,
    id: input.id,
    description: input.description,
    body: input.body,
    model: input.model,
    hidden: input.hidden,
    steps: input.steps,
    matrix: input.matrix,
  })

  const raw = await import("node:fs/promises").then((m) => m.readFile(filePath, "utf8"))
  assert.ok(raw.startsWith("---\ndescription: My agent\nmode: subagent\nmodel: acme/standard#high\n"))
  assert.ok(raw.includes("hidden: true"))
  assert.ok(raw.includes("steps: 6"))
  assert.ok(!raw.includes("name:"), "v2 files never carry a name field")
  assert.ok(raw.endsWith("Do the thing.\n"))

  // 列表能立刻看到（保存后 GUI 会 refetch）
  const list = await listAgents(dir)
  assert.deepEqual(list.map((a) => a.id), ["my-agent"])

  // 重名（no-clobber）
  await assert.rejects(
    () => createAgentFile({ dir, id: "my-agent", description: "again", body: "x\n", matrix }),
    (e: Error & { code?: string }) => e.code === "exists",
  )
}))

// P2-T8：V1 文件的保存链路 = 迁移预览 → 整份迁移 → 打补丁。
// 用真实文件验证：预览给出 before/after/changes，update 落盘后文件是纯 V2。
test("v1 save flow migrates the whole file before applying the patch", withTempAgents({
  "legacy.md": `---
name: legacy
description: Old description
mode: subagent
model: acme/standard
variant: high
disable: true
maxSteps: 5
permission:
  read: allow
  edit: allow
  bash:
    "*": allow
    "git push *": ask
---

Old body.
`,
}, async (dir) => {
  const { previewMigrationFile, updateAgentFile, hashOf, readAgentFile } = await import("../src/core/agent-store.ts")
  const file = path.join(dir, "legacy.md")

  // 1. 预览
  const preview = await previewMigrationFile({ filePath: file })
  assert.ok(preview.before.includes("name: legacy"))
  assert.ok(!preview.after.includes("name:"), "after must be v2")
  const fields = preview.changes.map((c) => c.field)
  for (const expected of ["name", "disable", "maxSteps", "model", "permission"]) {
    assert.ok(fields.includes(expected), `preview must report ${expected}`)
  }
  // 预览输出本身也必须是合法可解析的 V2
  const parsedAfter = (await import("../src/core/frontmatter.ts")).parseAgentFile(preview.after)
  assert.equal(parsedAfter.format, "v2")

  // 2. 保存（GUI 确认预览后走这条路径）。
  // GUI 从 meta 读回 model / steps 并随 patch 带上（editor.tsx 的 buildPatch），所以这里也带上，
  // 以验证「迁移 + 打补丁」后这些值仍以 V2 形态存在。
  const before = await readAgentFile(file)
  const matrix = {
    defaultEffect: "allow" as const,
    actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow", shell: "allow",
      webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } as const,
  }
  const { hash } = await updateAgentFile({
    filePath: file,
    roots: [dir],
    expectedHash: before.hash,
    patch: { description: "New description", body: "New body.\n", model: "acme/standard#high", steps: 5, matrix },
  })
  assert.equal(typeof hash, "string")
  assert.equal(hash, hashOf(await (await import("node:fs/promises")).readFile(file, "utf8")))

  // 3. 落盘结果：纯 V2，无任何 V1 残留，细规则保留
  const after = await readAgentFile(file)
  assert.equal(after.format, "v2")
  assert.equal(after.meta.description, "New description")
  assert.equal(after.body, "New body.\n")
  const raw = await (await import("node:fs/promises")).readFile(file, "utf8")
  for (const key of ["name:", "variant:", "disable:", "maxSteps:", "permission:"]) {
    assert.ok(!raw.includes(`\n${key}`) && !raw.startsWith(`---\n${key}`), `v1 key leaked: ${key}`)
  }
  assert.ok(raw.includes("steps: 5"), "maxSteps renamed to steps")
  assert.ok(raw.includes("model: acme/standard#high"), "model and variant merged")
  assert.ok(raw.includes("git push *"), "fine-grained shell rule preserved")
}))

// 缺陷 B 全链路回归：V1 文件（model + 独立 variant）经 GUI 编辑保存后，#variant 必须保留。
// 桌面端实测过丢 variant 的路径：read 只取 meta.model → 深度下拉显示「无」→ patch.model 无后缀
// → 覆盖掉 migrateContent 产生的 #high。
test("v1 save keeps the variant the GUI recovered from the separate field", withTempAgents({
  "legacy.md": `---
name: legacy
description: Old
mode: subagent
model: acme/standard
variant: high
permission:
  read: allow
---

body
`,
}, async (dir) => {
  const { readAgentFile, updateAgentFile, previewMigrationFile } = await import("../src/core/agent-store.ts")
  const { modelRefFromRead, buildPatch } = await import("../src/gui/editor-form.ts")
  const file = path.join(dir, "legacy.md")

  // 1. read：第六轮 C1/C2 起返回迁移后等效视图——model 已合并 #high，variant 字段不再出现
  const res = await readAgentFile(file)
  assert.equal(res.format, "v1")
  assert.equal((res.meta as Record<string, unknown>).model, "acme/standard#high")
  assert.ok(!("variant" in (res.meta as Record<string, unknown>)), "effective view has no separate variant")

  // 2. GUI 还原模型引用（修复点）：base ref + 独立 variant
  const ref = modelRefFromRead(res.meta as Record<string, unknown>, res.format)
  assert.equal(ref.model, "acme/standard", "model must be the base ref")
  assert.equal(ref.variant, "high", "depth dropdown must show high")

  // 2b. 编辑页显示行由 base + variant 拼出，必须只有一个 #
  const display = `${ref.model}${ref.variant ? `#${ref.variant}` : ""}`
  assert.equal(display, "acme/standard#high")
  assert.equal((display.match(/#/g) ?? []).length, 1, "display must not double the suffix")

  // 3. 迁移预览也确认 #high（服务端本来就对）
  const preview = await previewMigrationFile({ filePath: file })
  assert.ok(preview.after.includes("model: acme/standard#high"))

  // 4. GUI 保存：patch.model 必须带后缀
  const matrix = {
    defaultEffect: "allow" as const,
    actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow", shell: "allow",
      webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } as const,
  }
  const patch = buildPatch({
    description: "New", body: "new body\n",
    model: ref.model, variant: ref.variant,
    matrix,
  })
  assert.equal(patch.model, "acme/standard#high", "patch must carry the variant")

  await updateAgentFile({ filePath: file, roots: [dir], expectedHash: res.hash, patch })

  // 5. 落盘结果：#high 保留，且是纯 V2
  const after = await readAgentFile(file)
  assert.equal(after.format, "v2")
  assert.equal((after.meta as Record<string, unknown>).model, "acme/standard#high", "variant must survive the save")
  const raw = await (await import("node:fs/promises")).readFile(file, "utf8")
  assert.ok(raw.includes("model: acme/standard#high"))
  assert.ok(!raw.includes("#high#high"), "the saved file must not double the suffix")
  assert.ok(!raw.includes("variant:"), "v2 has no separate variant field")
}))
