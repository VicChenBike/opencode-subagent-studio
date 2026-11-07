// src/gui/trash-flow.ts —— 回收站删除的 GUI 流程（依赖注入，可单测，无 DOM）。
// goal.md §10：二次确认 → 移入同级 agents-trash → toast；调用方负责 reload 与返回列表。
import type { RemoveInput, RemoveOutput } from "../rpc"

export interface TrashDeps {
  confirm: (input: {
    title: string
    description?: string
    danger?: boolean
  }) => Promise<boolean>
  remove: (input: RemoveInput) => Promise<RemoveOutput>
  toast: (input: {
    title: string
    description?: string
    variant?: "default" | "success" | "error" | "loading"
  }) => void
  // 与宿主 ctx.t 的 Params 一致：只接受 string | number | boolean
  t: (key: string, params?: Record<string, string | number | boolean>) => string
}

export type TrashResult = "deleted" | "cancelled" | "failed"

/** 二次确认弹窗的文案（goal.md §10 第 1 步）。 */
export function deleteConfirmCopy(
  t: TrashDeps["t"],
  id: string,
): { title: string; description: string; danger: boolean } {
  return {
    title: t("list.delete.title"),
    description: t("list.delete.desc", { id }),
    danger: true,
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown })?.message
  return typeof message === "string" ? message : String(error)
}

/**
 * 删除 = 移入回收站。
 * 返回 "deleted" 时调用方应重拉列表（或返回列表页）；"cancelled" 表示用户放弃；
 * "failed" 已弹错误 toast，调用方不必再处理。
 */
export async function trashAgent(
  deps: TrashDeps,
  agent: { id: string; path: string },
): Promise<TrashResult> {
  const ok = await deps.confirm(deleteConfirmCopy(deps.t, agent.id))
  if (!ok) return "cancelled"
  try {
    await deps.remove({ path: agent.path })
    deps.toast({ title: deps.t("toast.deleted"), variant: "success" })
    return "deleted"
  } catch (error) {
    deps.toast({
      title: deps.t("common.error"),
      description: messageOf(error),
      variant: "error",
    })
    return "failed"
  }
}
