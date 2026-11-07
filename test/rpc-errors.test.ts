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
