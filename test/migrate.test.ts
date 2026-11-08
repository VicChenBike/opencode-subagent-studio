// test/migrate.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { migrateContent, parseAgentFile } from "../src/core/frontmatter.ts"

// 结构参照社区常见的 superpowers 风格审查类代理文件（模型名换假名）
const V1_REVIEWER = `---
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

test("migrate: flat v1 file becomes pure v2", () => {
  const { content, changes } = migrateContent(V1_REVIEWER)
  assert.ok(content.includes("mode: subagent"))
  assert.ok(content.includes("description: Reviews completed implementation work"))
  assert.ok(!content.includes("name:"))                      // name 删除
  assert.ok(!content.includes("permission:"))                // 旧键消失
  assert.ok(content.includes("permissions:"))                // 新键出现
  assert.ok(content.includes("- action: read"))
  assert.ok(/resource: ['"]\*['"]/.test(content))            // yaml 给 * 开头标量加引号，单双不限
  assert.ok(content.includes("effect: allow"))
  assert.ok(content.includes("You are the code reviewer subagent.")) // 正文不动
  const fields = changes.map((c) => c.field)
  assert.ok(fields.includes("name"))
  assert.ok(fields.includes("permission"))
})

test("migrate: disable → disabled, maxSteps → steps", () => {
  const { content, changes } = migrateContent(
    "---\ndescription: d\nmode: subagent\ndisable: true\nmaxSteps: 8\n---\n\nb\n",
  )
  assert.ok(content.includes("disabled: true"))
  assert.ok(content.includes("steps: 8"))
  assert.ok(!content.includes("disable:"))
  const fields = changes.map((c) => c.field)
  assert.ok(fields.includes("disable"))
  assert.ok(fields.includes("maxSteps"))
})

test("migrate: model + variant merged", () => {
  const { content } = migrateContent(
    "---\ndescription: d\nmode: subagent\nmodel: acme/standard\nvariant: high\n---\n\nb\n",
  )
  assert.ok(content.includes("model: acme/standard#high"))
  assert.ok(!content.includes("variant:"))
})

test("migrate: temperature/top_p/options dropped", () => {
  const { content } = migrateContent(
    "---\ndescription: d\nmode: subagent\ntemperature: 0.7\ntop_p: 0.9\noptions: {x: 1}\n---\n\nb\n",
  )
  assert.ok(!content.includes("temperature:"))
  assert.ok(!content.includes("top_p:"))
  assert.ok(!content.includes("options:"))
})

test("migrate: nested permission map expands to rules with action renames", () => {
  // 结构参照社区常见的 superpowers 风格实现类代理文件
  const { content } = migrateContent(
    `---
description: d
mode: subagent
permission:
  read: allow
  edit: allow
  bash:
    "*": allow
    "git push*": ask
  task:
    "*": deny
    "superpowers-code-reviewer": allow
---

b
`,
  )
  assert.ok(content.includes("- action: shell"))              // bash → shell
  assert.ok(content.includes("- action: subagent"))           // task → subagent
  assert.ok(/resource: ['"]?git push\*['"]?/.test(content))
  assert.ok(/resource: ['"]?superpowers-code-reviewer['"]?/.test(content))
  assert.ok(content.includes("effect: ask"))
  assert.ok(content.includes("effect: deny"))
})

test("migrate: tools false values become deny rules", () => {
  const { content } = migrateContent(
    "---\ndescription: d\nmode: subagent\ntools:\n  websearch: false\n---\n\nb\n",
  )
  assert.ok(content.includes("- action: websearch"))
  assert.ok(content.includes("effect: deny"))
  assert.ok(!content.includes("tools:"))
})

test("migrate: comments and unknown fields preserved", () => {
  const { content } = migrateContent(
    "---\n# my comment\ndescription: d\nfuture-field: keepme\nmode: subagent\n---\n\nb\n",
  )
  assert.ok(content.includes("# my comment"))
  assert.ok(content.includes("future-field: keepme"))
})

test("migrate: prompt field moves into empty body", () => {
  const { content } = migrateContent(
    "---\ndescription: d\nmode: subagent\nprompt: |\n  Line one.\n  Line two.\n---\n",
  )
  assert.ok(!content.includes("prompt:"))
  assert.ok(content.includes("Line one.\n"))
})

test("migrate: v2 file is returned unchanged", () => {
  const raw = "---\ndescription: d\nmode: subagent\npermissions: []\n---\n\nb\n"
  const { content, changes } = migrateContent(raw)
  assert.equal(content, raw)
  assert.deepEqual(changes, [])
})

// superpowers 风格实现类代理的细粒度规则必须一条不漏（结构参照社区常见文件，模型名换假名）
test("migrate: every fine-grained nested rule survives with its action renamed", () => {
  const { content } = migrateContent(
    `---
description: d
mode: subagent
permission:
  read: allow
  edit: allow
  todowrite: allow
  skill: allow
  task:
    "*": deny
    "some-reviewer": allow
  webfetch: allow
  bash:
    "*": allow
    "git push*": ask
    "git pull*": ask
    "git merge *": ask
---

b
`,
  )
  // 结构化断言：解析回 rules 数组再逐条比对，避免受 yaml 引号风格影响
  const parsed = parseAgentFile(content)
  const rules = parsed.meta.permissions as { action: string; resource: string; effect: string }[]
  assert.ok(Array.isArray(rules), "permissions must be an array")
  const expected = [
    ["shell", "git push*", "ask"],
    ["shell", "git pull*", "ask"],
    ["shell", "git merge *", "ask"],
    ["subagent", "some-reviewer", "allow"],
  ] as const
  for (const [action, resource, effect] of expected) {
    assert.ok(
      rules.some((r) => r.action === action && r.resource === resource && r.effect === effect),
      `missing rule ${action} / ${resource} / ${effect}`,
    )
  }
  // 嵌套的 "*" 值折叠成矩阵的 action * 规则，不应再出现同名同资源的重复项
  assert.equal(rules.filter((r) => r.action === "shell" && r.resource === "*").length, 1)
  assert.equal(rules.filter((r) => r.action === "subagent" && r.resource === "*").length, 1)
})

// tools 的 deny 规则要真正落在输出里，且与矩阵同名 action 冲突时以 deny 为准
test("migrate: tools deny overrides the matrix allow for the same action", () => {
  const { content } = migrateContent(
    "---\ndescription: d\nmode: subagent\npermission:\n  websearch: allow\ntools:\n  websearch: false\n---\n\nb\n",
  )
  const rules = content.split("- action:").slice(1)
  const websearch = rules.filter((r) => r.trimStart().startsWith("websearch"))
  assert.equal(websearch.length, 1, `expected exactly one websearch rule, got ${websearch.length}`)
  assert.ok(websearch[0].includes("effect: deny"), "the surviving websearch rule must be deny")
})

// 迁移是整份一次性：输出里不允许残留任何 V1 键
test("migrate: output contains no v1-only keys", () => {
  const { content } = migrateContent(
    `---
name: n
description: d
mode: subagent
model: acme/standard
variant: high
disable: false
maxSteps: 4
temperature: 0.5
top_p: 0.9
options: {}
tools:
  websearch: false
permission:
  bash: allow
prompt: |
  from prompt
---
`,
  )
  for (const key of ["name:", "variant:", "disable:", "maxSteps:", "temperature:", "top_p:", "options:", "tools:", "permission:", "prompt:"]) {
    assert.ok(!content.includes(`\n${key}`) && !content.startsWith(`---\n${key}`), `v1 key leaked: ${key}`)
  }
  assert.ok(content.includes("disabled: false"))
  assert.ok(content.includes("steps: 4"))
  assert.ok(content.includes("model: acme/standard#high"))
  assert.ok(content.includes("from prompt"))
})

// 单一契约源（R1 收敛要求）：MigrateChange 只在 rpc.ts 定义，frontmatter.ts 只再导出
test("MigrateChange is declared only in rpc.ts", async () => {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", p), "utf8")
  const fm = read("core/frontmatter.ts")
  const rpc = read("rpc.ts")
  assert.ok(/export interface MigrateChange\b/.test(rpc), "rpc.ts must declare MigrateChange")
  assert.ok(!/export interface MigrateChange\b/.test(fm), "frontmatter.ts must not redeclare MigrateChange")
  assert.ok(/export type \{ MigrateChange \}/.test(fm), "frontmatter.ts must re-export the contract type")
})

// R3 P3-1：非 ACTIONS 的 V1 平映射条目，若 effect 非默认（如 todowrite: deny），
// 必须作为末尾规则保留，否则用户的禁止语义被静默丢弃（无损迁移）。
test("migrate: non-matrix v1 actions with a non-default effect survive as trailing rules", () => {
  const { content } = migrateContent(
    "---\ndescription: d\nmode: subagent\npermission:\n  read: allow\n  todowrite: deny\n  question: allow\n---\n\nb\n",
  )
  const rules = parseAgentFile(content).meta.permissions as { action: string; resource: string; effect: string }[]
  const todowrite = rules.filter((r) => r.action === "todowrite")
  assert.equal(todowrite.length, 1, "todowrite must be kept exactly once")
  assert.equal(todowrite[0].resource, "*")
  assert.equal(todowrite[0].effect, "deny")
  // 末尾位置：排在矩阵的 question 规则之后
  const questionIdx = rules.findIndex((r) => r.action === "question" && r.resource === "*")
  const todowriteIdx = rules.findIndex((r) => r.action === "todowrite")
  assert.ok(todowriteIdx > questionIdx, "non-matrix rule must be appended after the matrix rules")
})

// 非 ACTIONS 条目若是默认效果（allow），无需保留——不写冗余规则
test("migrate: non-matrix v1 actions with the default effect are not turned into rules", () => {
  const { content } = migrateContent(
    "---\ndescription: d\nmode: subagent\npermission:\n  read: allow\n  todowrite: allow\n---\n\nb\n",
  )
  const rules = parseAgentFile(content).meta.permissions as { action: string }[]
  assert.equal(rules.filter((r) => r.action === "todowrite").length, 0)
})

// R3 P3-3：prompt 与非空正文并存 → 只删 prompt，正文一字不动（goal.md §9.2）
test("migrate: prompt is dropped when the body already has content", () => {
  const raw = `---
description: d
mode: subagent
prompt: |
  from prompt
---

existing body
`
  const { content, changes } = migrateContent(raw)
  assert.ok(!content.includes("prompt:"), "prompt field must be removed")
  assert.ok(!content.includes("from prompt"), "prompt content must not leak into the body")
  assert.ok(content.includes("existing body"), "existing body must be preserved verbatim")
  const promptChange = changes.find((c) => c.field === "prompt")
  assert.ok(promptChange, "a change record for prompt is expected")
  assert.equal(promptChange!.action, "delete", "with a non-empty body the prompt is deleted, not merged")
})
