// src/core/migrate-shared.ts —— V1 动作名映射（permissions.ts 与 frontmatter.ts 共用）
// 单独成模块，避免 frontmatter.ts ↔ permissions.ts 循环依赖。
export const V1_ACTION_RENAME: Record<string, string> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
}
