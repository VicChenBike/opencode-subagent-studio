// test/permissions.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { matrixFromRules, rulesFromMatrix } from "../src/core/permissions.ts"
import type { PermissionRule } from "../src/rpc.ts"

const rule = (action: string, resource: string, effect: PermissionRule["effect"]): PermissionRule =>
  ({ action, resource, effect })

test("matrixFromRules: last matching * rule wins per action", () => {
  const m = matrixFromRules([
    rule("*", "*", "allow"),
    rule("read", "*", "deny"),
    rule("read", "*", "allow"), // 最后一条 read * 生效
  ])
  assert.equal(m.defaultEffect, "allow")
  assert.equal(m.actions.read, "allow")
  assert.equal(m.actions.edit, "allow")
})

test("matrixFromRules: v1 nested map flattens to * resource effect", () => {
  // AGENTS.md §3.7 真实文件：bash: { "*": "ask", "ls": "allow" } → shell 展示 ask
  const m = matrixFromRules([], { bash: { "*": "ask", "ls *": "allow" }, read: "allow" })
  assert.equal(m.actions.shell, "ask")
  assert.equal(m.actions.read, "allow")
})

test("matrixFromRules: v1 action renames bash→shell task→subagent write|patch→edit", () => {
  const m = matrixFromRules([], { bash: "allow", task: "deny", write: "ask", patch: "allow", todowrite: "allow" })
  assert.equal(m.actions.shell, "allow")
  assert.equal(m.actions.subagent, "deny")
  assert.equal(m.actions.edit, "allow") // write 与 patch 同时出现时取后者（最后写入）
  assert.equal(m.actions.read, "allow") // todowrite 不在展示矩阵，read 缺省 = default
})

test("matrixFromRules: no rules → all inherit default allow", () => {
  const m = matrixFromRules(undefined)
  assert.equal(m.defaultEffect, "allow")
  for (const a of Object.values(m.actions)) assert.equal(a, "allow")
})

test("rulesFromMatrix generates canonical order (goal.md §8.3)", () => {
  const rules = rulesFromMatrix(
    { defaultEffect: "deny", actions: { read: "allow", glob: "allow", grep: "allow", edit: "deny", shell: "ask",
      webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } },
  )
  assert.deepEqual(rules, [
    rule("*", "*", "deny"),
    rule("read", "*", "allow"),
    rule("glob", "*", "allow"),
    rule("grep", "*", "allow"),
    rule("edit", "*", "deny"),
    rule("shell", "*", "ask"),
    rule("webfetch", "*", "allow"),
    rule("websearch", "*", "allow"),
    rule("skill", "*", "allow"),
    rule("subagent", "*", "allow"),
    rule("question", "*", "allow"),
  ])
})

test("rulesFromMatrix preserves existing fine-grained rules at the end", () => {
  const existing = [
    rule("shell", "git push*", "ask"),
    rule("subagent", "superpowers-code-reviewer", "allow"),
    rule("read", "*", "deny"),
  ]
  const rules = rulesFromMatrix(
    { defaultEffect: "allow", actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow",
      shell: "allow", webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } },
    existing,
  )
  // read * 因矩阵与 existing 相同被合并；细粒度两条保留在末尾
  assert.deepEqual(rules[rules.length - 2], rule("shell", "git push*", "ask"))
  assert.deepEqual(rules[rules.length - 1], rule("subagent", "superpowers-code-reviewer", "allow"))
  // existing 的 read * 与矩阵生成的重复项被过滤；shell * / read * 各只出现一次
  assert.equal(rules.filter((r) => r.action === "shell" && r.resource === "*").length, 1)
  assert.equal(rules.filter((r) => r.action === "read" && r.resource === "*").length, 1)
})

test("rulesFromMatrix: .env protection kept when read is untouched (goal.md §8.4)", () => {
  const rules = rulesFromMatrix(
    { defaultEffect: "allow", actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow",
      shell: "allow", webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } },
  )
  assert.ok(rules.some((r) => r.action === "read" && r.resource === "*.env" && r.effect === "ask"))
  assert.ok(rules.some((r) => r.action === "read" && r.resource === "*.env.*" && r.effect === "ask"))
  assert.ok(rules.some((r) => r.action === "read" && r.resource === "*.env.example" && r.effect === "allow"))
})

test("rulesFromMatrix: .env protection dropped when user changed read", () => {
  const rules = rulesFromMatrix(
    { defaultEffect: "allow", actions: { read: "deny", glob: "allow", grep: "allow", edit: "allow",
      shell: "allow", webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } },
  )
  assert.ok(!rules.some((r) => r.resource === "*.env"))
})

test("rulesFromMatrix: user's own .env fine rules suppress the defaults", () => {
  const rules = rulesFromMatrix(
    { defaultEffect: "allow", actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow",
      shell: "allow", webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } },
    [rule("read", "*.env", "allow")],
  )
  assert.deepEqual(rules.filter((r) => r.resource === "*.env"), [rule("read", "*.env", "allow")])
  assert.ok(!rules.some((r) => r.resource === "*.env.*" && r.effect === "ask"))
})

// 顺序契约（goal.md §8.3「追加在数组末尾，保证最后匹配生效时细规则优先」）：
// 用户的细粒度规则必须排在 .env 默认保护之后，否则默认 ask 会覆盖用户的 allow。
// 这里用非 read 的细规则（shell 的 git push），避免触发「read 细规则抑制 .env 默认」那条独立规则。
test("rulesFromMatrix: user fine rules come after the .env defaults so they win on last match", () => {
  const rules = rulesFromMatrix(
    { defaultEffect: "allow", actions: { read: "allow", glob: "allow", grep: "allow", edit: "allow",
      shell: "allow", webfetch: "allow", websearch: "allow", skill: "allow", subagent: "allow", question: "allow" } },
    [rule("shell", "git push *", "ask")],
  )
  const userRule = rules.findIndex((r) => r.action === "shell" && r.resource === "git push *")
  const defaultEnvAsk = rules.findIndex((r) => r.action === "read" && r.resource === "*.env" && r.effect === "ask")
  assert.ok(userRule > -1, "user rule must be kept")
  assert.ok(defaultEnvAsk > -1, "default env ask must be present")
  assert.ok(userRule > defaultEnvAsk, "user rule must come after the default env rule")
})

// 单一契约源：permissions.ts 的 ACTIONS / 类型必须来自 rpc.ts，不得本地重复定义
test("permissions.ts takes its types from rpc.ts instead of redeclaring them", async () => {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "core", "permissions.ts"),
    "utf8",
  )
  assert.ok(/from "\.\.\/rpc\.ts"/.test(source), "must import from ../rpc.ts")
  assert.ok(!/export const ACTIONS\s*=/.test(source), "must not redeclare ACTIONS")
  assert.ok(!/export (type|interface) (Effect|PermissionRule|PermissionMatrix)\b/.test(source), "must not redeclare shared types")
})
