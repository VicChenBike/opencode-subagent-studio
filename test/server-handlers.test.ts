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

  const toggled = await setDisabledFile({ filePath: created, roots: [dir], disabled: true })
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
