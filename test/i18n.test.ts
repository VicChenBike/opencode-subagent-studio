// test/i18n.test.ts —— 文案目录与宿主 locale 键的对齐。
// 桌面端实测（2026-11-07）：宿主 <html lang="zh-Hans">，设置页其余条目为中文，
// 插件标题却显示英文 "Subagents"。宿主按界面语言的 locale 键在 catalog 里查找，
// 找不到就用 en 兜底；当时只注册了 zh-CN，故短码 zh 落空。现已注册 zh（zh-Hans / zh-CN 为兼容别名）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { catalog } from "../src/gui/i18n/index.ts"

// 动态按键索引：catalog 是 as const 字面量，测试里需要按字符串键访问
const messagesOf = (locale: string): Readonly<Record<string, string>> =>
  (catalog as Readonly<Record<string, Readonly<Record<string, string>>>>)[locale]

const locales = Object.keys(catalog)

test("catalog registers English as the required fallback", () => {
  assert.ok(locales.includes("en"))
  assert.ok(Object.keys(catalog.en).length > 0)
})

// 宿主语言 key 是 zh，映射出的 BCP-47 标签是 zh-Hans；两者都可能作为 catalog 查找键。
test("catalog registers Chinese under the keys the host actually looks up", () => {
  for (const key of ["zh-Hans", "zh"]) {
    assert.ok(locales.includes(key), `catalog must have a "${key}" entry, has: ${locales.join(",")}`)
  }
})

test("every Chinese locale entry carries the same messages", () => {
  const chineseKeys = locales.filter((l) => l.startsWith("zh"))
  assert.ok(chineseKeys.length >= 2, "expected at least zh-Hans and zh")
  const reference = messagesOf("zh-Hans")
  for (const key of chineseKeys) {
    assert.deepEqual(messagesOf(key), reference, `${key} must match zh-Hans`)
  }
})

// 「Subagent」统一命名后，page.title 只在 en 定义，其余语言走 {...en, ...locale} 回退。
// 因此这里只断言「非英语词典不得含 en 之外的未知键」；
// 键齐全性（en 减 page.title ⊆ locale）由 test/i18n-multilang.test.ts 断言。
test("no locale carries keys that are absent from English", () => {
  const enKeys = new Set(Object.keys(catalog.en))
  for (const locale of locales.filter((l) => l !== "en")) {
    const unknown = Object.keys(messagesOf(locale)).filter((k) => !enKeys.has(k))
    assert.deepEqual(unknown, [], `${locale} carries unknown keys: ${unknown.join(", ")}`)
  }
})

// 「Subagent」统一命名（设计决议 2026-11-07）：设置侧边栏列表名与页面标题在全语言
// 显示单数 "Subagent"。page.title 只在 en 定义，其余语言不覆盖（走宿主 en 回退）。
test("the settings entry name stays the unified English word in every language", () => {
  assert.equal(catalog.en["page.title"], "Subagent")
  for (const locale of locales.filter((l) => l !== "en")) {
    assert.ok(!("page.title" in messagesOf(locale)), `${locale} must not override page.title`)
  }
})
