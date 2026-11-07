// test/frontmatter.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { splitFrontmatter, detectFormat, parseAgentFile } from "../src/core/frontmatter.ts"

const V2_SAMPLE = `---
description: Reviews changes for correctness
mode: subagent
model: acme/standard#high
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

Review the current changes.
`

const V1_SAMPLE = `---
name: superpowers-code-reviewer
description: Reviews completed implementation work
model: acme/standard
mode: subagent
hidden: true
permission:
  read: allow
  glob: allow
  grep: allow
  skill: allow
---

You are the code reviewer subagent.
`

test("splitFrontmatter splits yaml head and body", () => {
  const { frontmatter, body } = splitFrontmatter(V2_SAMPLE)
  assert.ok(frontmatter!.includes("description: Reviews changes"))
  assert.equal(body, "Review the current changes.\n")
})

test("splitFrontmatter tolerates missing frontmatter", () => {
  const { frontmatter, body } = splitFrontmatter("Just text\n")
  assert.equal(frontmatter, null)
  assert.equal(body, "Just text\n")
})

test("detectFormat: V2 marker fields win", () => {
  // AGENTS.md §3.4：permissions/request/system/disabled 任一出现 → 整份按 V2 读
  assert.equal(detectFormat({ permissions: [] }), "v2")
  assert.equal(detectFormat({ disabled: true }), "v2")
  assert.equal(detectFormat({ request: {} }), "v2")
  assert.equal(detectFormat({ system: "x" }), "v2")
})

test("detectFormat: otherwise v1 (even with color/name/tools)", () => {
  assert.equal(detectFormat({ name: "x", color: "#ff0000", tools: {} }), "v1")
  assert.equal(detectFormat({}), "v1")
})

test("parseAgentFile parses V2 file", () => {
  const parsed = parseAgentFile(V2_SAMPLE)
  assert.equal(parsed.format, "v2")
  assert.equal(parsed.meta.description, "Reviews changes for correctness")
  assert.equal(parsed.meta.model, "acme/standard#high")
  assert.equal(parsed.meta.mode, "subagent")
  assert.deepEqual(parsed.meta.permissions, [
    { action: "edit", resource: "*", effect: "deny" },
  ])
  assert.equal(parsed.body, "Review the current changes.\n")
})

test("parseAgentFile parses V1 file (flat permission map)", () => {
  const parsed = parseAgentFile(V1_SAMPLE)
  assert.equal(parsed.format, "v1")
  assert.equal(parsed.meta.name, "superpowers-code-reviewer")
  assert.equal(parsed.meta.hidden, true)
  assert.deepEqual(parsed.meta.permission, { read: "allow", glob: "allow", grep: "allow", skill: "allow" })
  assert.ok(parsed.body.startsWith("You are the code reviewer"))
})

test("parseAgentFile keeps unknown fields verbatim", () => {
  const parsed = parseAgentFile("---\nfoo: bar\ncustom-nested:\n  a: 1\n---\n\nBody")
  assert.deepEqual(parsed.meta["custom-nested"], { a: 1 })
  assert.equal(parsed.meta.foo, "bar")
  assert.equal(parsed.body, "Body")
})

// R1 审查发现：frontmatter 是纯标量 / 数组时 detectFormat 会抛 TypeError，导致整个目录扫描失败
test("parseAgentFile tolerates scalar frontmatter", () => {
  const parsed = parseAgentFile("---\njust-a-scalar\n---\n\nBody\n")
  assert.equal(parsed.format, "v1")
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, "Body\n")
})

test("parseAgentFile tolerates list frontmatter", () => {
  const parsed = parseAgentFile("---\n- a\n- b\n---\n\nBody\n")
  assert.equal(parsed.format, "v1")
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, "Body\n")
})

test("parseAgentFile tolerates null and broken yaml", () => {
  assert.deepEqual(parseAgentFile("---\nnull\n---\n\nBody\n").meta, {})
  // 半截 flow 序列由 yaml 宽松解析；这里只要求不抛错且 meta 仍是普通对象
  const broken = parseAgentFile("---\ndescription: [unclosed\n---\n\nBody\n")
  assert.equal(Array.isArray(broken.meta), false)
  assert.equal(typeof broken.meta, "object")
  assert.equal(broken.body, "Body\n")
})
