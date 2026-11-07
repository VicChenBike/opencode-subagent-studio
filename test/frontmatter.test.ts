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

// —— P2-T2：序列化（yaml Document 保注释 / 键序 / 未知字段）——
import { createV2Content, applyPatchToSource } from "../src/core/frontmatter.ts"
import type { AgentPatch } from "../src/rpc.ts"

const FULL_MATRIX = {
  defaultEffect: "allow",
  actions: { read: "allow", glob: "allow", grep: "allow", edit: "ask", shell: "ask",
    webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" },
} as const

test("createV2Content writes canonical field order and no name", () => {
  const content = createV2Content({
    description: "My reviewer",
    body: "Be strict.\n",
    model: "acme/standard#high",
    color: "#ff6b6b",
    hidden: true,
    steps: 8,
    matrix: FULL_MATRIX,
  })
  assert.ok(content.startsWith("---\ndescription: My reviewer\nmode: subagent\nmodel: acme/standard#high\n"))
  assert.ok(content.indexOf("hidden: true") < content.indexOf("color:"))   // 固定字段序（goal.md §7）
  assert.ok(content.indexOf("color:") < content.indexOf("steps:"))
  assert.ok(content.indexOf("steps:") < content.indexOf("permissions:"))
  assert.ok(content.includes("hidden: true\n"))
  assert.ok(!content.includes("name:"))
  assert.ok(content.endsWith("Be strict.\n"))
})

test("createV2Content omits optional fields", () => {
  const content = createV2Content({ description: "d", body: "b", matrix: FULL_MATRIX })
  assert.ok(!content.includes("model:"))
  assert.ok(!content.includes("hidden:"))
  assert.ok(!content.includes("color:"))
  assert.ok(!content.includes("steps:"))
  assert.ok(content.includes("permissions:"))
})

test("applyPatchToSource preserves comments, key order and unknown fields", () => {
  const raw = `---
# 审查代理
description: old description
mode: subagent
custom-field:
  keep: me
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

Body here.
`
  const out = applyPatchToSource(raw, { description: "new description", body: "Body here.\n", matrix: FULL_MATRIX })
  assert.ok(out.includes("# 审查代理"))                       // 注释保留
  assert.ok(out.indexOf("description:") < out.indexOf("custom-field:")) // 键序保留
  assert.ok(out.includes("custom-field:"))                   // 未知字段保留
  assert.ok(out.includes("keep: me"))
  assert.ok(!out.includes("old description"))
})

test("applyPatchToSource sets and clears model", () => {
  const raw = "---\ndescription: d\nmodel: acme/standard#high\n---\n\nb\n"
  const cleared = applyPatchToSource(raw, { description: "d", body: "b\n", matrix: FULL_MATRIX })
  assert.ok(!cleared.includes("model:"))
  const set = applyPatchToSource(raw, { description: "d", body: "b\n", model: "acme/mini", matrix: FULL_MATRIX })
  assert.ok(set.includes("model: acme/mini"))
})

test("applyPatchToSource replaces permissions wholesale and keeps body leading whitespace", () => {
  const raw = "---\ndescription: d\n---\n\n  Kept leading spaces.\n"
  const out = applyPatchToSource(raw, { description: "d", body: "  Kept leading spaces.\n", matrix: FULL_MATRIX })
  assert.ok(out.includes("  Kept leading spaces."))          // 保留开头空白（goal.md §6.5）
  assert.ok(out.includes("- action: edit"))                  // 矩阵写入
  assert.ok(/resource: ['"]\*\.env['"]/.test(out))           // .env 保护随矩阵规则写入
})

// applyPatchToSource 保留既有细粒度规则（goal.md §8.3）——P2-T4 的 update 依赖这一点
test("applyPatchToSource keeps existing fine-grained rules through a patch", () => {
  const raw = `---
description: d
permissions:
  - action: "*"
    resource: "*"
    effect: allow
  - action: shell
    resource: "git push *"
    effect: ask
  - action: subagent
    resource: some-agent
    effect: allow
---

b
`
  const out = applyPatchToSource(raw, { description: "d2", body: "b\n", matrix: FULL_MATRIX })
  assert.ok(out.includes("git push *"), "shell fine rule must survive")
  assert.ok(out.includes("some-agent"), "subagent fine rule must survive")
  assert.ok(out.includes("description: d2"))
})

// 对没有 frontmatter 的文件打补丁：仍生成合法 V2 文件（不混写、不抛错）
test("applyPatchToSource handles a file without frontmatter", () => {
  const out = applyPatchToSource("just body text\n", { description: "d", body: "just body text\n", matrix: FULL_MATRIX })
  assert.ok(out.startsWith("---\n"))
  assert.ok(out.includes("mode: subagent") === false, "patch path must not invent mode")
  assert.ok(out.includes("description: d"))
  assert.ok(out.endsWith("just body text\n"))
})

// 未知字段与注释在打补丁后必须逐字保留（goal.md §9.3）
test("applyPatchToSource preserves nested unknown structures verbatim", () => {
  const raw = `---
# top comment
description: d
weird:
  nested:
    - 1
    - two
  flag: true
---

b
`
  const out = applyPatchToSource(raw, { description: "d", body: "b\n", matrix: FULL_MATRIX })
  assert.ok(out.includes("# top comment"))
  assert.ok(out.includes("nested:"))
  assert.ok(out.includes("- 1"))
  assert.ok(out.includes("- two"))
  assert.ok(out.includes("flag: true"))
})
