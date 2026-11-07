// src/gui/migration-logic.ts —— 迁移预览弹窗的纯逻辑（changes → i18n 键）。
// 文案在组件里用 ctx.t 取，这里只负责判定该用哪个键。
import type { MigrateChange } from "../rpc"

/** goal.md §9.2 的七项变化 + 兜底文案。 */
export function changeLabelKey(change: MigrateChange): string {
  switch (change.field) {
    case "name":
      return "migrate.change.name"
    case "permission":
      return "migrate.change.permission"
    case "disable":
      return "migrate.change.disable"
    case "model":
      return "migrate.change.model"
    case "temperature":
    case "top_p":
    case "options":
      return "migrate.change.temperature"
    case "tools":
      return "migrate.change.tools"
    case "maxSteps":
      return "migrate.change.maxSteps"
    case "prompt":
      return "migrate.change.prompt"
    default:
      return "migrate.change.other"
  }
}

/** 按 changes 原顺序产出一组 i18n 键（组件里 map 成 ctx.t）。 */
export function changeLines(changes: readonly MigrateChange[]): string[] {
  return changes.map(changeLabelKey)
}

/** goal.md §9.1：只有 V1 文件、且本次编辑尚未确认过迁移时，才弹预览。 */
export function shouldPromptMigration(input: {
  format: "v1" | "v2"
  migrateConfirmed: boolean
}): boolean {
  return input.format === "v1" && !input.migrateConfirmed
}
