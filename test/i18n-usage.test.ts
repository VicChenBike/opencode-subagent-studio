// test/i18n-usage.test.ts —— GUI 引用的每个 i18n 键都必须在目录里存在（防止出现裸键名）。
// 扫描 src/gui 下所有 .ts/.tsx：既抓 ctx.t("literal")，也抓动态模板键（perm.action.${action} 等）。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { catalog } from "../src/gui/i18n.ts"

const guiDir = path.join(import.meta.dirname, "..", "src", "gui")

/** src/gui 下全部源码（含组件与纯逻辑模块），不含 i18n.ts 自身。 */
function guiSources(): string[] {
  return fs
    .readdirSync(guiDir)
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== "i18n.ts")
    .map((f) => path.join(guiDir, f))
}

/** 静态键：ctx.t("x") / ctx.t('x') */
function staticKeys(): string[] {
  const keys = new Set<string>()
  for (const file of guiSources()) {
    const text = fs.readFileSync(file, "utf8")
    for (const m of text.matchAll(/ctx\.t\(\s*["']([^"']+)["']/g)) keys.add(m[1])
  }
  return [...keys].sort()
}

/** 动态键前缀：ctx.t(`perm.action.${action}`) → 前缀 "perm.action."，需展开 */
function dynamicPrefixes(): string[] {
  const prefixes = new Set<string>()
  for (const file of guiSources()) {
    const text = fs.readFileSync(file, "utf8")
    for (const m of text.matchAll(/ctx\.t\(\s*`([^`$]*)\$\{/g)) prefixes.add(m[1])
  }
  return [...prefixes].sort()
}

test("every static ctx.t key used by the GUI exists in the catalog", () => {
  const keys = staticKeys()
  assert.ok(keys.length > 0, "expected the GUI to use some keys")
  const missing = keys.filter((k) => !(k in catalog.en))
  assert.deepEqual(missing, [], `keys missing from catalog: ${missing.join(", ")}`)
})

test("the GUI's dynamic ctx.t prefixes expand to real catalog keys", () => {
  const prefixes = dynamicPrefixes()
  assert.ok(prefixes.includes("perm.action."), "expected the permission grid's dynamic key prefix")
  for (const prefix of prefixes) {
    const matching = Object.keys(catalog.en).filter((k) => k.startsWith(prefix))
    assert.ok(matching.length > 0, `prefix "${prefix}" matches no catalog key`)
  }
})

test("all ten permission action labels are present in every locale", () => {
  const actions = ["read", "glob", "grep", "edit", "shell", "webfetch", "websearch", "skill", "subagent", "question"]
  for (const action of actions) {
    const key = `perm.action.${action}`
    for (const locale of Object.keys(catalog)) {
      assert.ok(key in catalog[locale as keyof typeof catalog], `${locale} missing ${key}`)
    }
  }
})

test("the GUI uses at least 60 distinct static keys", () => {
  // 审查要求：sources 补齐后应能看到全部页面文案键（防止扫描漏文件）
  assert.ok(staticKeys().length >= 60, `only found ${staticKeys().length} static keys`)
})

test("the list error state has copy in both languages", () => {
  for (const key of ["list.error.title", "list.error.retry"]) {
    assert.ok(key in catalog.en, `en missing ${key}`)
    assert.ok(key in catalog["zh-Hans"], `zh-Hans missing ${key}`)
  }
  assert.equal(catalog["zh-Hans"]["list.error.retry"], "重试")
  assert.equal(catalog.en["list.error.retry"], "Try again")
})

// R4 补强：changeLabelKey 输出的 9 个 migrate.change.* 键必须都在目录里。
// 这 9 个键是动态拼出来的（migration-logic.ts 的 switch），静态扫描抓不到，
// 一旦有人删键，迁移预览会显示裸键名。
test("all nine migrate.change.* copy keys exist in every locale", () => {
  const keys = [
    "migrate.change.name",
    "migrate.change.permission",
    "migrate.change.disable",
    "migrate.change.model",
    "migrate.change.temperature",
    "migrate.change.tools",
    "migrate.change.maxSteps",
    "migrate.change.prompt",
    "migrate.change.other",
  ]
  assert.equal(keys.length, 9)
  for (const key of keys) {
    for (const locale of Object.keys(catalog)) {
      assert.ok(key in catalog[locale as keyof typeof catalog], `${locale} missing ${key}`)
    }
  }
})

// 与 changeLabelKey 的实际输出对齐：把每个 goal.md §9.2 字段走一遍函数，断言产出的键都在目录里
test("every key changeLabelKey can produce is present in the catalog", async () => {
  const { changeLabelKey } = await import("../src/gui/migration-logic.ts")
  const fields = [
    "name", "permission", "disable", "model",
    "temperature", "top_p", "options", "tools", "maxSteps", "prompt",
    "some-unknown-field",
  ]
  const produced = new Set(fields.map((field) => changeLabelKey({ field, action: "convert" })))
  assert.equal(produced.size, 9, `expected 9 distinct keys, got ${produced.size}`)
  for (const key of produced) {
    for (const locale of Object.keys(catalog)) {
      assert.ok(key in catalog[locale as keyof typeof catalog], `${locale} missing ${key} (produced by changeLabelKey)`)
    }
  }
})

// 三态权限标签：permission-grid 用 effectKey() 拼键，静态扫描抓不到
test("perm.allow / perm.ask / perm.deny exist in every locale", () => {
  for (const key of ["perm.allow", "perm.ask", "perm.deny"]) {
    for (const locale of Object.keys(catalog)) {
      assert.ok(key in catalog[locale as keyof typeof catalog], `${locale} missing ${key}`)
    }
  }
  assert.equal(catalog["zh-Hans"]["perm.allow"], "允许")
  assert.equal(catalog["zh-Hans"]["perm.ask"], "询问")
  assert.equal(catalog["zh-Hans"]["perm.deny"], "禁止")
})

// R5 P3-1：trash-flow.ts 通过注入的 t 引用文案，不走 ctx.t( 前缀，静态扫描抓不到。
// 这里按两种方式覆盖：①扫描 t("...") 形式的直接调用；②显式列出它引用的键。
test("keys referenced through an injected t are scanned too", () => {
  const source = fs.readFileSync(path.join(guiDir, "trash-flow.ts"), "utf8")
  const keys = new Set<string>()
  // deps.t("x") / t("x") —— 排除 ctx.t（那种由上面的测试覆盖）
  for (const m of source.matchAll(/(?<!ctx\.)\bt\(\s*["']([^"']+)["']/g)) keys.add(m[1])
  assert.ok(keys.size > 0, "expected trash-flow.ts to reference some keys")
  const missing = [...keys].filter((k) => !(k in catalog.en))
  assert.deepEqual(missing, [], `keys missing from catalog: ${missing.join(", ")}`)
})

test("trash-flow's known copy keys all exist in every locale", () => {
  const keys = ["list.delete.title", "list.delete.desc", "toast.deleted", "common.error"]
  for (const key of keys) {
    for (const locale of Object.keys(catalog)) {
      assert.ok(key in catalog[locale as keyof typeof catalog], `${locale} missing ${key}`)
    }
  }
})
