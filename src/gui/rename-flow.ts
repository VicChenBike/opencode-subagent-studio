// src/gui/rename-flow.ts —— 重命名流程（依赖注入，可单测，无 DOM）。
// goal.md §6.1：改 ID 会让其他代理或提示词里的引用失效 → 必须二次确认；
// 目标已存在由服务端拒绝（exists），这里只负责把失败转成 toast。
import { isValidAgentId, isReservedId } from "../core/ids.ts"
import { errorDescription } from "./error-copy.ts"

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


/**
 * 重命名一个代理。
 * 返回 "renamed" 时调用方应跳到新 ID（或回列表并重拉）。
 */
export async function renameAgent(
  deps: RenameDeps,
  agent: { id: string; path: string },
  newId: string,
): Promise<RenameResult> {
  // 先校验再确认：非法 / 保留 / 未改变的 ID 不值得让用户确认一次
  const invalid = validateNewId(newId, agent.id)
  if (invalid !== undefined) {
    deps.toast({ title: invalidCopyKey(invalid, deps.t, newId), variant: "error" })
    return "invalid"
  }
  const ok = await deps.confirm(renameConfirmCopy(deps.t, agent.id))
  if (!ok) return "cancelled"
  return renameConfirmed(deps, agent, newId)
}

function invalidCopyKey(
  invalid: NewIdError,
  t: RenameDeps["t"],
  newId: string,
): string {
  if (invalid === "invalid") return t("editor.invalidId")
  if (invalid === "reserved") return t("editor.reservedId", { id: newId })
  return t("editor.duplicateId", { id: newId })
}

/** 已确认后的执行部分：校验 → rename → toast。renameAgentWithPrompt 复用它避免二次确认。 */
export async function renameConfirmed(
  deps: RenameDeps,
  agent: { id: string; path: string },
  newId: string,
): Promise<RenameResult> {
  try {
    await deps.rename({ path: agent.path, newId })
    deps.toast({ title: deps.t("toast.renamed"), variant: "success" })
    return "renamed"
  } catch (error) {
    deps.toast({
      title: deps.t("common.error"),
      description: errorDescription(deps.t, error),
      variant: "error",
    })
    return "failed"
  }
}

export interface RenamePromptDeps {
  confirm: (input: { title: string; description?: string; danger?: boolean }) => Promise<boolean>
  prompt: (input: { title: string; description?: string; placeholder?: string; value?: string }) => Promise<string | undefined>
  rename: (input: { path: string; newId: string }) => Promise<{ path: string }>
  toast: (input: {
    title: string
    description?: string
    variant?: "default" | "success" | "error" | "loading"
  }) => void
  t: (key: string, params?: Record<string, string | number | boolean>) => string
}

/**
 * 带输入框的完整重命名流程（P3 遗留：顺序对齐计划）。
 *
 * 顺序是「先警告、再输名字」：先让用户看到「ID 会改变、引用会失效」，
 * 他若在此放弃就什么都没发生；反过来（先输名字再警告）会让人先想好新名字，
 * 警告的教育作用被削弱，也更容易在误操作下改掉 ID。
 */
export async function renameAgentWithPrompt(
  deps: RenamePromptDeps,
  agent: { id: string; path: string },
): Promise<RenameResult> {
  const ok = await deps.confirm(renameConfirmCopy(deps.t, agent.id))
  if (!ok) return "cancelled"
  const next = await deps.prompt({
    title: deps.t("editor.rename.title"),
    placeholder: deps.t("editor.name.hint"),
    value: agent.id,
  })
  if (next === undefined) return "cancelled"
  return renameConfirmed(deps, agent, next)
}
