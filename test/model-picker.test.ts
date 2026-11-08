// test/model-picker.test.ts —— 模型弹窗的纯逻辑（过滤 / 变体推导 / 选中判定）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { filterProviders, variantsOf, isSelected, providerOfModel } from "../src/gui/model-picker-logic.ts"
import type { ProviderSummary } from "../src/rpc.ts"

const PROVIDERS: ProviderSummary[] = [
  {
    id: "acme",
    name: "Acme",
    models: [
      { id: "standard", name: "Standard", variants: ["high", "low"] },
      { id: "mini", name: "Mini", variants: [] },
    ],
  },
  {
    id: "globex",
    name: "Globex",
    models: [{ id: "turbo", name: "Turbo", variants: ["max"] }],
  },
]

test("filterProviders returns everything for an empty query", () => {
  const out = filterProviders(PROVIDERS, "")
  assert.equal(out.length, 2)
  assert.equal(out[0].models.length, 2)
  assert.equal(out[1].models.length, 1)
})

test("filterProviders matches provider id, model id and model name case-insensitively", () => {
  assert.deepEqual(filterProviders(PROVIDERS, "ACME").map((p) => p.id), ["acme"])
  assert.deepEqual(filterProviders(PROVIDERS, "turbo").map((p) => p.id), ["globex"])
  assert.deepEqual(filterProviders(PROVIDERS, "stan").map((p) => p.id), ["acme"])
})

test("filterProviders drops providers with no matching models", () => {
  const out = filterProviders(PROVIDERS, "turbo")
  assert.equal(out.length, 1)
  assert.equal(out[0].id, "globex")
  assert.equal(out[0].models.length, 1)
})

test("filterProviders returns nothing for a query that matches nothing", () => {
  assert.deepEqual(filterProviders(PROVIDERS, "zzz-no-such-model"), [])
})

test("filterProviders does not mutate the input", () => {
  const before = JSON.stringify(PROVIDERS)
  filterProviders(PROVIDERS, "acme")
  assert.equal(JSON.stringify(PROVIDERS), before)
})

test("variantsOf returns the model's variants", () => {
  assert.deepEqual(variantsOf(PROVIDERS, "acme/standard"), ["high", "low"])
  assert.deepEqual(variantsOf(PROVIDERS, "globex/turbo"), ["max"])
})

test("variantsOf returns an empty list for a model without variants", () => {
  assert.deepEqual(variantsOf(PROVIDERS, "acme/mini"), [])
})

test("variantsOf returns an empty list for an unknown or malformed model ref", () => {
  assert.deepEqual(variantsOf(PROVIDERS, "nope/nothing"), [])
  assert.deepEqual(variantsOf(PROVIDERS, "noslash"), [])
  assert.deepEqual(variantsOf(PROVIDERS, undefined), [])
})

// R-12-1：宿主按第一个 "/" 切分，modelID 可含 "/"（models.dev 目录 id），嵌套 id 可选。
test("variantsOf splits on the first slash so nested model ids work", () => {
  const nested: ProviderSummary[] = [
    { id: "acme", name: "Acme", models: [{ id: "org/mini", name: "Org Mini", variants: ["high"] }] },
  ]
  assert.deepEqual(variantsOf(nested, "acme/org/mini"), ["high"])
})

test("providerOfModel returns the provider half", () => {
  assert.equal(providerOfModel("acme/standard"), "acme")
  assert.equal(providerOfModel("acme/org/mini"), "acme")
  assert.equal(providerOfModel("noslash"), undefined)
  assert.equal(providerOfModel(undefined), undefined)
})

test("isSelected compares the full provider/model ref", () => {
  assert.equal(isSelected("acme/standard", "acme", "standard"), true)
  assert.equal(isSelected("acme/mini", "acme", "standard"), false)
  assert.equal(isSelected(undefined, "acme", "standard"), false)
  assert.equal(isSelected("acme/standard#high", "acme", "standard"), false, "variant must not be part of the ref here")
})
