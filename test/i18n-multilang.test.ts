// test/i18n-multilang.test.ts —— 11 语言词典的结构与质量约束。
// 设计决议（2026-11-07 brainstorm）：界面词典扩到 11 种语言，一律注册宿主短码键；
// 「Subagent」设置入口名（page.title）全语言统一，只定义在 en，其余语言走
// {...en, ...locale} 合并的 en 回退，因此非英语词典的键集 = en 键集 − page.title。
import { test } from "node:test"
import assert from "node:assert/strict"
import { catalog } from "../src/gui/i18n/index.ts"

// 动态按键索引：catalog 是 as const 字面量，测试里需要按字符串键访问
const messagesOf = (locale: string): Readonly<Record<string, string>> =>
  (catalog as Readonly<Record<string, Readonly<Record<string, string>>>>)[locale]

// 11 种目标语言（宿主界面语言短码；br = 宿主唯一的葡萄牙语选项 pt-BR）
const TARGET_LOCALES = ["en", "zh", "fr", "es", "br", "ru", "ar", "de", "ja", "hi", "ko"] as const

test("the catalog registers exactly the 11 target languages plus the zh aliases", () => {
  assert.deepEqual([...Object.keys(catalog)].sort(), [
    "ar", "br", "de", "en", "es", "fr", "hi", "ja", "ko", "ru",
    "zh", "zh-CN", "zh-Hans",
  ])
})

test("every language registers under its host short code", () => {
  for (const locale of TARGET_LOCALES) {
    assert.ok(locale in catalog, `catalog is missing the "${locale}" locale`)
  }
})

test("every language's key set equals English's minus the unified page.title", () => {
  const enKeys = Object.keys(catalog.en).filter((k) => k !== "page.title").sort()
  for (const locale of TARGET_LOCALES) {
    if (locale === "en") continue
    const msgs = messagesOf(locale)
    assert.ok(msgs, `catalog is missing the "${locale}" locale`)
    assert.deepEqual(
      Object.keys(msgs).sort(),
      enKeys,
      `${locale} key set must equal en minus page.title`,
    )
  }
})

test("every translated message keeps the English placeholders", () => {
  const ph = (s: string) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",")
  // 经 messagesOf 索引（与 i18n-usage.test.ts 同款惯例）：直接用 string 下标索引
  // as const 的 catalog.en 会触发 TS7053（strict 模式），tsc --noEmit 过不去。
  const en = messagesOf("en")
  for (const locale of TARGET_LOCALES) {
    if (locale === "en") continue
    const msgs = messagesOf(locale)
    assert.ok(msgs, `catalog is missing the "${locale}" locale`)
    const bad = Object.keys(msgs).filter((k) => k in en && ph(msgs[k]) !== ph(en[k]))
    assert.deepEqual(bad, [], `${locale} placeholder mismatch: ${bad.join(", ")}`)
  }
})

test("every locale covers the dynamic template keys", () => {
  // perm.action.* —— permission-grid 用 effectKey() 动态拼接；
  // migrate.change.* —— migration-logic 的 changeLabelKey 动态产出。
  // 两者都抓不到静态 ctx.t( 扫描（AGENTS.md 坑 14），必须显式逐一断言。
  const dynamicKeys = [
    ...["read", "glob", "grep", "edit", "shell", "webfetch", "websearch", "skill", "subagent", "question"]
      .map((action) => `perm.action.${action}`),
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
  assert.equal(dynamicKeys.length, 19)
  for (const locale of TARGET_LOCALES) {
    const msgs = messagesOf(locale)
    assert.ok(msgs, `catalog is missing the "${locale}" locale`)
    for (const key of dynamicKeys) {
      assert.ok(key in msgs, `${locale} missing dynamic key ${key}`)
    }
  }
})
