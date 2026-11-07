// src/core/rpc-errors.ts —— 契约声明的错误码集合与从内部异常提取错误码（纯逻辑）。
//
// 为什么需要这个模块：服务端 handler 必须把可预期的失败**作为返回值**交给宿主的
// `context.error(name, message)`，而不是 throw。宿主对 throw 出来的普通 Error 一律视为
// 未捕获缺陷，包成 `rpc.internal` 并以 HTTP 500 返回；客户端 readError 只有在该错误码
// 被契约声明过时才原样透出 `{ type, message }`，否则 GUI 只能拿到笼统的失败。
import type { ErrorCode } from "../rpc"

/** 契约里声明的全部错误码（与 rpc.ts 的 methods.*.errors 一一对应）。 */
export const ERROR_CODES = [
  "invalid_path",
  "invalid_id",
  "reserved_id",
  "exists",
  "not_found",
  "conflict",
  "migration_required",
] as const satisfies readonly ErrorCode[]

const DECLARED = new Set<string>(ERROR_CODES)

/** 契约里每个错误码的 data schema 都是空对象，这里复用同一个不可变实例。 */
const EMPTY_DATA: Record<string, never> = Object.freeze({}) as Record<string, never>

/** 核心层（agent-store）用 `err.code` 标注失败原因；这里把它取出来并校验是否已声明。 */
export function codeOf(error: unknown): ErrorCode | undefined {
  if (error === null || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && DECLARED.has(code) ? (code as ErrorCode) : undefined
}

/**
 * 把核心层的异常转成 handler 需要的错误载荷；返回 undefined 表示这不是契约声明的失败，
 * 应当继续向上抛（真正的内部错误仍应变成 500）。
 */
export function errorPayload(error: unknown): { code: ErrorCode; message: string } | undefined {
  const code = codeOf(error)
  if (code === undefined) return undefined
  const message = error instanceof Error ? error.message : String(error)
  return { code, message }
}

/**
 * 宿主 handler 上下文里我们用到的那部分。
 *
 * 真实签名（@opencode/plugin/dist/promise/adapter.js 的 rpcFromEffect 里）：
 *   error: (type, message, data) => new ReturnedRpcError(type, message, data)
 * 三个参数缺一不可：data 会按该方法 `errors[name]` 的 schema 校验。
 * 我们的契约把错误 data 声明成 `{ type: "object", properties: {}, additionalProperties: false }`，
 * 漏传 data（= undefined）会让宿主抛 `SchemaError(Expected object)` 并以 HTTP 500 返回。
 */
export interface ErrorContextLike {
  error: (name: string, message: string, data: Record<string, never>) => unknown
}

/**
 * 跑一段 handler 逻辑：契约已声明的失败转成 `context.error(name, message)` 的**返回值**，
 * 其余异常照常抛出（真正的内部错误仍应变成 500）。
 *
 * 为什么必须这样：宿主把 throw 出来的普通 Error 视为未捕获缺陷，统一包成 `rpc.internal`
 * 并返回 HTTP 500；客户端只有在该错误码被契约声明过时才原样透出 `{ type, message }`。
 * 桌面端实测的 conflict 三选弹窗不弹就是这个原因。
 *
 * 注意：宿主的 `context.error` 按方法收窄成该方法的错误名联合（无声明错误时是 never），
 * 而本模块的 ErrorCode 是跨方法的全集，所以调用方需要把 context 断言成 ErrorContextLike。
 */
export async function runWithDeclaredErrors<Output>(
  context: ErrorContextLike,
  run: () => Promise<Output>,
): Promise<Output> {
  try {
    return await run()
  } catch (error) {
    const payload = errorPayload(error)
    if (payload === undefined) throw error
    // 第三个参数必须是空对象：契约里所有错误 data 都是 `{ type: "object", properties: {} }`，
    // 传 undefined 会被宿主 schema 拒绝（SchemaError(Expected object) → 500）。
    return context.error(payload.code, payload.message, EMPTY_DATA) as Output
  }
}
