// test/disabled-normalize.test.ts —— V1 的 disable 字段归一化（审查 P3-b）。
// AGENTS.md §3.4：V1 用 `disable`，V2 用 `disabled`。列表若只读 disabled，
// 一个 `disable: true` 的 V1 文件会显示成「启用」，与真值相反。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseAgentFile } from "../src/core/frontmatter.ts"
import { listAgents } from "../src/core/agent-store.ts"

test("parseAgentFile folds v1 disable:true into disabled", () => {
  const parsed = parseAgentFile("---\ndescription: d\nmode: subagent\ndisable: true\n---\n\nx\n")
  assert.equal(parsed.format, "v1")
  assert.equal(parsed.meta.disabled, true, "v1 disable must surface as disabled")
})

test("parseAgentFile folds v1 disable:false into disabled:false", () => {
  const parsed = parseAgentFile("---\ndescription: d\nmode: subagent\ndisable: false\n---\n\nx\n")
  assert.equal(parsed.meta.disabled, false)
})

test("a v2 disabled value is not overwritten by a stray disable key", () => {
  const parsed = parseAgentFile("---\ndescription: d\nmode: subagent\ndisabled: false\ndisable: true\n---\n\nx\n")
  assert.equal(parsed.meta.disabled, false, "v2 disabled wins")
})

test("listAgents reports a v1 disable:true file as disabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-disable-v1-"))
  try {
    fs.writeFileSync(path.join(dir, "off.md"), "---\ndescription: d\nmode: subagent\ndisable: true\n---\n\nx\n")
    fs.writeFileSync(path.join(dir, "on.md"), "---\ndescription: d\nmode: subagent\n---\n\nx\n")
    const rows = await listAgents(dir)
    assert.equal(rows.find((r) => r.id === "off")!.disabled, true)
    assert.equal(rows.find((r) => r.id === "on")!.disabled, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
