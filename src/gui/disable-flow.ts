// src/gui/disable-flow.ts —— 列表行「停用/启用开关」的 GUI 流程，含 switchEventToDisabled
// 逆映射（开关 checked=启用 → 数据层 disabled 取反；依赖注入，可单测，无 DOM）。
//
// goal.md §10：开关写 `disabled: true/false`，false 时删除字段。
// goal.md §5.3：对 V1 文件写 disabled 会触发整份切 V2 → 必须先弹迁移预览，
// 用户确认后先 `update`（服务端整份迁移）再 `setDisabled`。
import { errorDescription } from "./error-copy.ts"
import type { AgentPatch, MigrateChange, ReadOutput } from "../rpc"
import { patchFromRead } from "./editor-form.ts"

export interface DisableDeps {
  migratePreview: (input: { path: string }) => Promise<{
    before: string
    after: string
    changes: MigrateChange[]
  }>
  /** 弹出迁移预览并要求用户确认；返回 false 表示取消。 */
  confirmMigration: (preview: {
    before: string
    after: string
    changes: MigrateChange[]
  }) => Promise<boolean>
  read: (input: { path: string }) => Promise<ReadOutput>
  update: (input: {
    path: string
    expectedHash: string
    patch: AgentPatch
  }) => Promise<{ hash: string }>
  setDisabled: (input: { path: string; disabled: boolean; expectedHash: string }) => Promise<{ hash: string }>
  toast: (input: {
    title: string
    description?: string
    variant?: "default" | "success" | "error" | "loading"
  }) => void
  t: (key: string, params?: Record<string, string | number | boolean>) => string
}

export type ToggleResult = "toggled" | "cancelled" | "failed"

/**
 * 「启用开关」的 UI 事件 → 数据层 disabled 的映射。
 * 开关是启用语义（checked = 启用，遵循宿主「蓝色 = 开」的惯例），
 * 数据层 disabled 与之相反；徽标 / 变灰仍跟 disabled 走。
 */
export function switchEventToDisabled(checked: boolean): boolean {
  return !checked
}


/**
 * 切换某个代理的停用状态。
 * V1 文件先走「预览 → update 整份迁移 → setDisabled」；V2 直接 setDisabled。
 */
export async function toggleDisabled(
  deps: DisableDeps,
  agent: { id: string; path: string; format: "v1" | "v2"; hash: string },
  disabled: boolean,
): Promise<ToggleResult> {
  try {
    // CAS（第十一轮 F9）：V2 用列表行的 hash；V1 迁移后文件已变，必须用 update 返回的新 hash
    let expectedHash = agent.hash
    if (agent.format === "v1") {
      const preview = await deps.migratePreview({ path: agent.path })
      const ok = await deps.confirmMigration(preview)
      if (!ok) return "cancelled"
      // 服务端对 V1 一律拒绝写 disabled，所以先整份迁移
      const current = await deps.read({ path: agent.path })
      const migrated = await deps.update({
        path: agent.path,
        expectedHash: current.hash,
        patch: patchFromRead(current),
      })
      expectedHash = migrated.hash
    }
    await deps.setDisabled({ path: agent.path, disabled, expectedHash })
    deps.toast({
      title: deps.t(disabled ? "toast.disabled" : "toast.enabled"),
      variant: "success",
    })
    return "toggled"
  } catch (error) {
    deps.toast({
      title: deps.t("common.error"),
      description: errorDescription(deps.t, error),
      variant: "error",
    })
    return "failed"
  }
}
