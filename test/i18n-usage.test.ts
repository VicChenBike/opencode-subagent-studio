// test/i18n-usage.test.ts —— 页面引用的每个 i18n 键都必须在目录里存在（防止出现裸键名）。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { catalog } from "../src/gui/i18n.ts"

const guiDir = path.join(import.meta.dirname, "..", "src", "gui")
const sources = ["page.tsx", "gui.tsx", "list-state.ts"]
  .map((f) => path.join(guiDir, f))
  .filter((f) => fs.existsSync(f))

function usedKeys(): string[] {
  const keys = new Set<string>()
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8")
    for (const m of text.matchAll(/ctx\.t\(\s*"([^"]+)"/g)) keys.add(m[1])
  }
  return [...keys].sort()
}

test("every ctx.t key used by the GUI exists in the catalog", () => {
  const keys = usedKeys()
  assert.ok(keys.length > 0, "expected the GUI to use some keys")
  const missing = keys.filter((k) => !(k in catalog.en))
  assert.deepEqual(missing, [], `keys missing from catalog: ${missing.join(", ")}`)
})

test("the list error state has copy in both languages", () => {
  for (const key of ["list.error.title", "list.error.retry"]) {
    assert.ok(key in catalog.en, `en missing ${key}`)
    assert.ok(key in catalog["zh-Hans"], `zh-Hans missing ${key}`)
  }
  assert.equal(catalog["zh-Hans"]["list.error.retry"], "重试")
  assert.equal(catalog.en["list.error.retry"], "Try again")
})
