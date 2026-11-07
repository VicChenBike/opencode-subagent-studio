// test/i18n-usage.test.ts —— GUI 引用的每个 i18n 键都必须在目录里存在（防止出现裸键名）。
// 扫描 src/gui 下所有 .ts/.tsx：既抓 ctx.t("literal")，也抓动态模板键（perm.action.${action} 等）。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { catalog } from "../src/gui/i18n/index.ts"

const guiDir = path.join(import.meta.dirname, "..", "src", "gui")

// 动态按键索引：catalog 是 as const 字面量，测试里需要按字符串键访问
const messagesOf = (locale: string): Readonly<Record<string, string>> =>
  (catalog as Readonly<Record<string, Readonly<Record<string, string>>>>)[locale]

/** src/gui 顶层全部源码（含组件与纯逻辑模块）；i18n/ 词典子目录无 .ts 顶层项，天然被扩展名正则排除。 */
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

// P3-T7 全量审计：目录里不应留下无引用的键（除少数动态构造的以外）。
// 扫描口径：src/gui 下所有 ctx.t / 注入式 t / 显式常量键，加上动态前缀展开。
test("the catalog has no dead keys", () => {
  const used = new Set<string>()
  const prefixes = new Set<string>()
  for (const file of guiSources()) {
    const text = fs.readFileSync(file, "utf8")
    for (const m of text.matchAll(/ctx\.t\(\s*["'`]([^"'`$]+)["'`]/g)) used.add(m[1])
    for (const m of text.matchAll(/ctx\.t\(\s*`([^`$]*)\$\{/g)) prefixes.add(m[1])
    for (const m of text.matchAll(/(?<!ctx\.)\bt\(\s*["']([^"']+)["']/g)) used.add(m[1])
    // 纯逻辑模块里以常量形式引用的键（effectKey / changeLabelKey / COPY_KEYS）
    for (const m of text.matchAll(/"(perm\.(?:allow|ask|deny))"/g)) used.add(m[1])
    for (const m of text.matchAll(/"(migrate\.change\.[a-zA-Z]+)"/g)) used.add(m[1])
    for (const m of text.matchAll(/"(toast\.(?:disabled|enabled))"/g)) used.add(m[1])
    // error-copy.ts 把键作为值放在 COPY_KEYS 里
    for (const m of text.matchAll(/"(error\.[a-zA-Z]+)"/g)) used.add(m[1])
  }
  const dead = Object.keys(catalog.en).filter((k) => {
    if (used.has(k)) return false
    for (const p of prefixes) if (k.startsWith(p)) return false
    return true
  })
  assert.deepEqual(dead, [], `unused keys: ${dead.join(", ")}`)
})

test("en and zh-Hans key sets match exactly", () => {
  assert.deepEqual(Object.keys(catalog.en).sort(), Object.keys(catalog["zh-Hans"]).sort())
})

test("every key's placeholders match between locales", () => {
  const ph = (s: string) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",")
  const en = messagesOf("en")
  const zh = messagesOf("zh-Hans")
  const bad = Object.keys(en).filter((k) => ph(en[k]) !== ph(zh[k]))
  assert.deepEqual(bad, [], `placeholder mismatch: ${bad.join(", ")}`)
})

// R6 遗留：全角冒号不能硬编码在 JSX 里，否则英文界面也会出现「：」。
// 用带占位符的键让两种语言各自决定分隔符。
test("the scope line uses a placeholder instead of a hardcoded colon", () => {
  const source = fs.readFileSync(path.join(guiDir, "editor.tsx"), "utf8")
  assert.ok(!/ctx\.t\("editor\.scope"\)\}：/.test(source), "the full-width colon must come from the catalog")
  const key = "editor.scopeValue"
  for (const locale of Object.keys(catalog)) {
    assert.ok(key in catalog[locale as keyof typeof catalog], `${locale} missing ${key}`)
  }
  assert.equal(catalog.en[key], "Scope: {{scope}}")
  assert.equal(catalog["zh-Hans"][key], "作用域：{{scope}}")
})
