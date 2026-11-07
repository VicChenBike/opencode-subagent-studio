// src/gui/error-copy.ts —— RPC 错误码 → 可读文案（P3-T8）。
//
// 服务端把可预期的失败作为契约错误返回（`{ type, message }`）。直接把 message 抛给用户
// 会看到英文内部措辞，所以已知错误码优先映射成 i18n 文案，其余保留原始 message。

/** 有专门文案的错误码。其余（invalid_id / reserved_id / migration_required）走原始 message。 */
const COPY_KEYS: Record<string, string> = {
  invalid_path: "error.invalidPath",
  exists: "error.exists",
  not_found: "error.notFound",
  conflict: "error.conflict",
}

/**
 * 找出错误对象里「有专门文案」的错误码。
 *
 * 顶层 type 可能是 `rpc.internal`（宿主包装），真正的码藏在 data / cause 里，
 * 所以不能一见到 type 就返回，要先看它是否有文案、没有再往下找。
 */
function findCopyKey(error: unknown, depth = 0): string | undefined {
  if (error === null || typeof error !== "object" || depth > 3) return undefined
  const obj = error as Record<string, unknown>
  const type = typeof obj.type === "string" ? obj.type : undefined
  if (type !== undefined && COPY_KEYS[type] !== undefined) return COPY_KEYS[type]
  return findCopyKey(obj.data, depth + 1) ?? findCopyKey(obj.cause, depth + 1)
}

/** 错误码对应的 i18n 键；没有专门文案时返回 undefined。 */
export function errorCopyKey(error: unknown): string | undefined {
  return findCopyKey(error)
}

function messageOf(error: unknown): string {
  if (error === null || error === undefined) return ""
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/**
 * 可直接展示的错误文案：有专门文案用翻译，否则回退到原始 message。
 * `t` 由调用方注入，保持本模块无 DOM / 无宿主依赖。
 */
export function errorDescription(
  t: (key: string) => string,
  error: unknown,
): string {
  const key = errorCopyKey(error)
  return key === undefined ? messageOf(error) : t(key)
}
