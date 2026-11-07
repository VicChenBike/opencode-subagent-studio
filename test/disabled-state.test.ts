// test/disabled-state.test.ts —— 停用状态的三种输入必须映射到正确的显示状态。
// 桌面端实测（2026-11-07）：7 行全部显示「已停用」，但文件真值全是启用。
// 这条链路有三段：frontmatter 解析 → RPC 编码/解码 → GUI 判定。逐段钉住。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as E from "effect"
import { parseAgentFile } from "../src/core/frontmatter.ts"
import { listAgents } from "../src/core/agent-store.ts"
import { Subagents } from "../src/rpc.ts"
import { agentRowState } from "../src/gui/list-state.ts"

const CASES = [
  { label: "no disabled field", raw: "---\ndescription: d\nmode: subagent\n---\n\nx\n", expected: false },
  { label: "disabled: false", raw: "---\ndescription: d\nmode: subagent\ndisabled: false\n---\n\nx\n", expected: false },
  { label: "disabled: true", raw: "---\ndescription: d\nmode: subagent\ndisabled: true\n---\n\nx\n", expected: true },
] as const

test("parseAgentFile reads the three disabled states", () => {
  for (const c of CASES) {
    const parsed = parseAgentFile(c.raw)
    // meta 里保留原始值（undefined / false / true）
    assert.equal(parsed.meta.disabled, c.expected ? true : parsed.meta.disabled, c.label)
  }
  assert.equal(parseAgentFile(CASES[0].raw).meta.disabled, undefined, "no field must stay undefined")
  assert.equal(parseAgentFile(CASES[1].raw).meta.disabled, false, "explicit false must stay false")
  assert.equal(parseAgentFile(CASES[2].raw).meta.disabled, true, "explicit true must stay true")
})

test("listAgents maps the three states to a boolean disabled flag", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-disabled-"))
  try {
    for (const [i, c] of CASES.entries()) {
      fs.writeFileSync(path.join(dir, `case-${i}.md`), c.raw)
    }
    const rows = await listAgents(dir)
    assert.equal(rows.length, 3)
    for (const [i, c] of CASES.entries()) {
      const row = rows.find((r) => r.id === `case-${i}`)!
      assert.equal(row.disabled, c.expected, `${c.label} → disabled`)
      assert.equal(typeof row.disabled, "boolean", "disabled must always be a real boolean")
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the disabled flag survives the host's encode/decode round trip", async () => {
  const conv = (schema: unknown) =>
    E.SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema, definitions: {} } as never)
  const schema = conv(Subagents.methods.list.output) as never
  for (const c of CASES) {
    const payload = {
      agents: [{
        id: "x", path: "/a/x.md", description: "d",
        disabled: c.expected, hidden: false, format: "v2" as const, hash: "h", mtime: 1,
      }],
      builtins: [{ id: "general" as const }],
    }
    const encoded = E.Schema.encodeUnknownSync(schema)(payload) as { agents: { disabled: unknown }[] }
    const wire = JSON.parse(JSON.stringify(encoded))
    const decoded = E.Schema.decodeUnknownSync(schema)(wire) as { agents: { disabled: unknown }[] }
    assert.equal(decoded.agents[0].disabled, c.expected, `${c.label} must survive encode/decode`)
    assert.equal(typeof decoded.agents[0].disabled, "boolean", `${c.label} must decode as boolean`)
  }
})

test("agentRowState shows the badge and checks the switch only when disabled is true", () => {
  for (const c of CASES) {
    const state = agentRowState({ disabled: c.expected })
    assert.equal(state.showDisabledBadge, c.expected, `${c.label} → badge`)
    assert.equal(state.switchChecked, c.expected, `${c.label} → switch`)
    assert.equal(state.dimmed, c.expected, `${c.label} → dimmed`)
  }
})

test("agentRowState treats a missing flag as enabled", () => {
  const state = agentRowState({})
  assert.equal(state.showDisabledBadge, false, "an absent flag must not read as disabled")
  assert.equal(state.switchChecked, false)
  assert.equal(state.dimmed, false)
})
