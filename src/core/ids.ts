// src/core/ids.ts —— 代理 ID 规则与保留 ID（纯逻辑，GUI 与服务端共用）
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export const RESERVED_IDS: readonly string[] = [
  "build",
  "plan",
  "general",
  "explore",
  "compaction",
  "title",
  "summary",
]

export function isValidAgentId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function isReservedId(id: string): boolean {
  return RESERVED_IDS.includes(id)
}
