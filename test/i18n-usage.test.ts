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
