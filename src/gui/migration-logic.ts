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

/**
 * 保存前的下一步动作。
 *
 * 关键约束：预览弹窗**不能**用 `await` 等待一个由弹窗回调 resolve 的 Promise。
 * 宿主 `Ui.Dialog` 的 `closable={false}` 只隐藏关闭按钮——类型文档与运行时实现都确认
 * Esc 与点外点击仍会关闭对话框，且关闭时不触发任何回调。若保存流程挂在那个 Promise 上，
 * 用户按 Esc 后 `save()` 的 `finally` 永远不执行，保存按钮会永久停在 busy。
 *
 * 所以流程拆成「先弹预览（不 await 结果）」→「用户点确认才继续保存」两步。
 */
export function saveStep(input: {
  mode: "edit" | "create"
  format: "v1" | "v2"
  migrateConfirmed: boolean
}): "preview" | "save" {
  if (input.mode === "create") return "save"
  return shouldPromptMigration({ format: input.format, migrateConfirmed: input.migrateConfirmed })
    ? "preview"
    : "save"
}
