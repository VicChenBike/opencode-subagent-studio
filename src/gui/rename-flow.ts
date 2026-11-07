// src/gui/rename-flow.ts —— 重命名流程（依赖注入，可单测，无 DOM）。
// goal.md §6.1：改 ID 会让其他代理或提示词里的引用失效 → 必须二次确认；
// 目标已存在由服务端拒绝（exists），这里只负责把失败转成 toast。
import { isValidAgentId, isReservedId } from "../core/ids.ts"

export interface RenameDeps {
  confirm: (input: { title: string; description?: string; danger?: boolean }) => Promise<boolean>
  rename: (input: { path: string; newId: string }) => Promise<{ path: string }>
  toast: (input: {
    title: string
    description?: string
    variant?: "default" | "success" | "error" | "loading"
  }) => void
  t: (key: string, params?: Record<string, string | number | boolean>) => string
}

export type RenameResult = "renamed" | "cancelled" | "invalid" | "failed"

export type NewIdError = "invalid" | "reserved" | "unchanged"

/** 二次确认的文案：明确警告引用会失效（goal.md §6.1）。 */
export function renameConfirmCopy(
  t: RenameDeps["t"],
  _currentId: string,
): { title: string; description: string; danger: boolean } {
  return {
    title: t("editor.rename.title"),
    description: t("editor.rename.desc"),
    danger: true,
  }
}

/** 新 ID 的前置校验：格式、保留 ID、与当前相同。目标是否已存在交给服务端。 */
export function validateNewId(newId: string, currentId: string): NewIdError | undefined {
  if (!isValidAgentId(newId)) return "invalid"
  if (isReservedId(newId)) return "reserved"
  if (newId === currentId) return "unchanged"
  return undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown })?.message
  return typeof message === "string" ? message : String(error)
}

/**
 * 重命名一个代理。
 * 返回 "renamed" 时调用方应跳到新 ID（或回列表并重拉）。
 */
export async function renameAgent(
  deps: RenameDeps,
  agent: { id: string; path: string },
  newId: string,
): Promise<RenameResult> {
  // 非法 / 保留 / 未改变：不弹确认也不发请求，但必须给出可见原因（P3-d）
  const invalid = validateNewId(newId, agent.id)
  if (invalid !== undefined) {
    deps.toast({
      title: deps.t(
        invalid === "invalid"
          ? "editor.invalidId"
          : invalid === "reserved"
            ? "editor.reservedId"
            : "editor.duplicateId",
        invalid === "reserved" || invalid === "unchanged" ? { id: newId } : undefined,
      ),
      variant: "error",
    })
    return "invalid"
  }
  const ok = await deps.confirm(renameConfirmCopy(deps.t, agent.id))
  if (!ok) return "cancelled"
  try {
    await deps.rename({ path: agent.path, newId })
    deps.toast({ title: deps.t("toast.renamed"), variant: "success" })
    return "renamed"
  } catch (error) {
    deps.toast({
      title: deps.t("common.error"),
      description: messageOf(error),
      variant: "error",
    })
    return "failed"
  }
}
