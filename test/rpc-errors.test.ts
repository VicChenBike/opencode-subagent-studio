// test/rpc-errors.test.ts —— 服务端错误码 → RPC 声明错误的映射。
//
// 桌面端实测（2026-11-07）：编辑页持旧 hash 保存，服务端正确拒绝写入，但返回 500，
// 日志是 `rpc handler failed ... defect="Error: file changed on disk"`。
// 根因：handler 用 throw 抛出普通 Error，宿主把它当未捕获缺陷包成 rpc.internal(500)，
// GUI 拿不到契约里声明的 conflict 错误码，于是只弹通用 toast。
import { test } from "node:test"
import assert from "node:assert/strict"
import { ERROR_CODES, codeOf, errorPayload } from "../src/core/rpc-errors.ts"

test("codeOf reads the code the core layer attaches", () => {
  const err = Object.assign(new Error("file changed on disk: x"), { code: "conflict" })
  assert.equal(codeOf(err), "conflict")
})

test("codeOf recognises every declared error code", () => {
  for (const code of ERROR_CODES) {
    const err = Object.assign(new Error(code), { code })
    assert.equal(codeOf(err), code)
  }
})

test("codeOf ignores unknown codes and non-errors", () => {
  assert.equal(codeOf(Object.assign(new Error("x"), { code: "ENOENT" })), undefined)
  assert.equal(codeOf(Object.assign(new Error("x"), { code: "not_a_declared_code" })), undefined)
  assert.equal(codeOf(new Error("plain")), undefined)
  assert.equal(codeOf(undefined), undefined)
  assert.equal(codeOf("conflict"), undefined)
})

test("errorPayload carries the declared code and the original message", () => {
  const err = Object.assign(new Error("file changed on disk: C:/x.md"), { code: "conflict" })
  assert.deepEqual(errorPayload(err), { code: "conflict", message: "file changed on disk: C:/x.md" })
})

test("errorPayload returns undefined for errors the contract does not declare", () => {
  assert.equal(errorPayload(new Error("not_implemented")), undefined)
  assert.equal(errorPayload(Object.assign(new Error("x"), { code: "ENOENT" })), undefined)
})

// 端到端：handler 层必须把核心层的 conflict 转成 context.error("conflict", ...) 返回值，
// 而不是让它冒泡成 500。这里用一个最小的假 context 复现宿主的调用协议。
test("a handler returns context.error for a declared failure instead of throwing", async () => {
  const { runWithDeclaredErrors } = await import("../src/core/rpc-errors.ts")
  const context = { error: (name: string, message: string) => ({ __error: name, message }) }
  const result = await runWithDeclaredErrors(context, async () => {
    throw Object.assign(new Error("file changed on disk: C:/x.md"), { code: "conflict" })
  })
  assert.deepEqual(result, { __error: "conflict", message: "file changed on disk: C:/x.md" })
})

test("a handler still rethrows failures the contract does not declare", async () => {
  const { runWithDeclaredErrors } = await import("../src/core/rpc-errors.ts")
  const context = { error: (name: string, message: string) => ({ __error: name, message }) }
  await assert.rejects(
    () => runWithDeclaredErrors(context, async () => { throw new Error("not_implemented") }),
    /not_implemented/,
  )
})

test("a handler passes successful results through untouched", async () => {
  const { runWithDeclaredErrors } = await import("../src/core/rpc-errors.ts")
  const context = { error: (name: string, message: string) => ({ __error: name, message }) }
  assert.equal(await runWithDeclaredErrors(context, async () => 42), 42)
})

// 每个声明错误码都要能穿过这层（conflict 只是实测遇到的那个）
test("every declared code maps to context.error with the same name", async () => {
  const { runWithDeclaredErrors, ERROR_CODES } = await import("../src/core/rpc-errors.ts")
  for (const code of ERROR_CODES) {
    const context = { error: (name: string, message: string) => ({ __error: name, message }) }
    const result = (await runWithDeclaredErrors(context, async () => {
      throw Object.assign(new Error(`failed: ${code}`), { code })
    })) as { __error: string; message: string }
    assert.equal(result.__error, code)
    assert.equal(result.message, `failed: ${code}`)
  }
})

// 真实签名（从 @opencode/plugin/dist/promise/adapter.js 提取）：
//   error: (type, message, data) => new ReturnedRpcError(type, message, data)
// data 是第三个参数，且宿主按该方法的 errors[name] schema 校验它。
// 我们的契约把错误 data 声明为 { type: "object", properties: {}, additionalProperties: false }，
// 传 undefined 会抛 SchemaError(Expected object) → HTTP 500。所以必须显式传 {}。
test("declared errors pass an empty data object, not undefined", async () => {
  const { runWithDeclaredErrors } = await import("../src/core/rpc-errors.ts")
  const seen: unknown[][] = []
  const context = {
    error: (...args: unknown[]) => {
      seen.push(args)
      return { __error: args[0] }
    },
  }
  await runWithDeclaredErrors(context, async () => {
    throw Object.assign(new Error("file changed on disk"), { code: "conflict" })
  })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], ["conflict", "file changed on disk", {}])
})

test("the third argument is a plain empty object every declared code can encode", async () => {
  const { runWithDeclaredErrors, ERROR_CODES } = await import("../src/core/rpc-errors.ts")
  const { Subagents } = await import("../src/rpc.ts")
  const E = await import("effect")
  const conv = (schema: unknown) =>
    E.SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema, definitions: {} } as never)

  // 契约里 methods 的联合类型不含 errors 键的方法，这里按运行时形状取
  const methods = Object.entries(Subagents.methods) as [string, { errors?: Record<string, unknown> }][]
  const methodsWithErrors = methods.filter(([, def]) => def.errors !== undefined)
  assert.ok(methodsWithErrors.length > 0)

  for (const [, def] of methodsWithErrors) {
    for (const [name, schema] of Object.entries(def.errors!)) {
      const seen: unknown[] = []
      const context = { error: (...args: unknown[]) => { seen.push(args[2]); return { __error: args[0] } } }
      await runWithDeclaredErrors(context, async () => {
        throw Object.assign(new Error(`${name} failed`), { code: name })
      })
      assert.equal(seen.length, 1, `${name} must reach context.error`)
      assert.doesNotThrow(
        () => E.Schema.encodeUnknownSync(conv(schema) as never)(seen[0]),
        `${name} data must encode against its contract schema`,
      )
    }
  }
  assert.ok(ERROR_CODES.length === 8)
})
