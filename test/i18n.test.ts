// test/i18n.test.ts —— 文案目录与宿主 locale 键的对齐。
// 桌面端实测（2026-11-07）：宿主 <html lang="zh-Hans">，设置页其余条目为中文，
// 插件标题却显示英文 "Subagents"。宿主按界面语言的 locale 键在 catalog 里查找，
// 找不到就用 en 兜底；我们只注册了 zh-CN，故落空。
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

test("Chinese catalog is complete against English", () => {
  const enKeys = Object.keys(catalog.en).sort()
  for (const locale of locales.filter((l) => l !== "en")) {
    assert.deepEqual(Object.keys(messagesOf(locale)).sort(), enKeys, `${locale} key set must match en`)
  }
})

test("the page title is Chinese in the zh-Hans catalog", () => {
  assert.equal(messagesOf("zh-Hans")["page.title"], "子智能体")
  assert.equal(catalog.en["page.title"], "Subagents")
})
