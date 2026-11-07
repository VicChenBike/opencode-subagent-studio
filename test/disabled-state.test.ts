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

// 防御：宿主若把布尔以字符串形式传回（传输层/编码器差异），GUI 也必须判对。
// 严格 === true 对 "true" 会判 false（安全方向：不误报停用），但对 "false" 也判 false（正确）。
// 这里把归一化显式化，让两种字符串都能映射到正确语义。
test("agentRowState normalizes string booleans from the transport", () => {
  assert.equal(agentRowState({ disabled: "true" as unknown as boolean }).showDisabledBadge, true)
  assert.equal(agentRowState({ disabled: "false" as unknown as boolean }).showDisabledBadge, false)
  assert.equal(agentRowState({ disabled: 1 as unknown as boolean }).showDisabledBadge, false)
  assert.equal(agentRowState({ disabled: 0 as unknown as boolean }).showDisabledBadge, false)
})

test("agentRowState never lights up for falsy or absent values", () => {
  for (const v of [undefined, null, false, 0, "", "false", "0"]) {
    const state = agentRowState({ disabled: v as unknown as boolean })
    assert.equal(state.showDisabledBadge, false, `value ${JSON.stringify(v)} must read as enabled`)
    assert.equal(state.switchChecked, false)
    assert.equal(state.dimmed, false)
  }
})

// 关键对照：hidden 与 disabled 在 schema 里同构，两者判定必须一致
test("hidden and disabled are judged the same way", () => {
  for (const v of [true, false, undefined]) {
    const badge = agentRowState({ disabled: v as boolean }).showDisabledBadge
    const hiddenShown = v === true
    assert.equal(badge, hiddenShown, `disabled=${v} must match the hidden badge rule`)
  }
})

// 用项目真实的 list.output schema 走完整宿主链路：encode → JSON → decode → GUI 判定。
// 这条测试锁死「disabled:false 经宿主编解码后不得变成 truthy」。
test("real host chain keeps disabled:false as enabled for every row shape", async () => {
  const E = await import("effect")
  const SR = (E as unknown as { SchemaRepresentation: { fromJsonSchemaDocument: (doc: unknown) => unknown } })
    .SchemaRepresentation
  const schema = SR.fromJsonSchemaDocument({
    dialect: "draft-2020-12",
    schema: Subagents.methods.list.output,
    definitions: {},
  })

  const rows = [
    { id: "plain", disabled: false, hidden: false, format: "v2" as const },
    { id: "hidden-on", disabled: false, hidden: true, format: "v2" as const },
    { id: "disabled-on", disabled: true, hidden: false, format: "v2" as const },
    { id: "v1-file", disabled: false, hidden: true, format: "v1" as const },
  ].map((r) => ({ ...r, path: `/p/${r.id}.md`, description: "d", hash: "0123456789abcdef", mtime: 1 }))

  const payload = { agents: rows, builtins: [{ id: "general" as const }] }
  const encoded = E.Schema.encodeUnknownSync(schema as never)(payload) as { agents: { id: string; disabled: unknown }[] }
  const wire = JSON.parse(JSON.stringify(encoded))
  const decoded = E.Schema.decodeUnknownSync(schema as never)(wire) as { agents: { id: string; disabled: unknown; hidden: unknown }[] }

  for (let i = 0; i < rows.length; i++) {
    assert.equal(typeof decoded.agents[i].disabled, "boolean", `${rows[i].id}: disabled must stay boolean`)
    assert.equal(decoded.agents[i].disabled, rows[i].disabled, `${rows[i].id}: disabled must survive the chain`)
    // 徽标必须只由 disabled 决定（hidden 是独立字段，不影响停用徽标）
    assert.equal(
      agentRowState(decoded.agents[i] as { disabled?: boolean }).showDisabledBadge,
      rows[i].disabled === true,
      `${rows[i].id}: the disabled badge must follow disabled alone`,
    )
  }
})
