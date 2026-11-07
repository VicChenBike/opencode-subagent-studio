// src/gui/editor-form.ts —— 编辑表单的纯逻辑（无 DOM、无 Solid，可单测）。
// GUI 组件负责渲染与事件，判定逻辑都放这里，避免把校验埋进 JSX。
import { isValidAgentId, isReservedId } from "../core/ids.ts"
import { matrixFromRules } from "../core/permissions.ts"
import type { AgentPatch, PermissionMatrix, PermissionRule, ReadOutput } from "../rpc"

export interface EditorDraft {
  description: string
  body: string
  /** 已拆好的模型串（不含 #variant） */
  model?: string
  variant?: string
  color?: string
  hidden?: boolean
  /** 输入框里的原始文本；空串 = 不写 steps */
  stepsText?: string
  matrix: PermissionMatrix
}

/** "provider/model#variant" → { model, variant }（goal.md §6.3） */
export function splitModelRef(raw: string | undefined): { model?: string; variant?: string } {
  if (!raw) return { model: undefined, variant: undefined }
  const hashIndex = raw.indexOf("#")
  if (hashIndex === -1) return { model: raw, variant: undefined }
  return { model: raw.slice(0, hashIndex), variant: raw.slice(hashIndex + 1) || undefined }
}

function parseSteps(stepsText: string | undefined): number | undefined {
  if (stepsText === undefined || stepsText.trim() === "") return undefined
  const n = Number(stepsText)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** 表单草稿 → RPC patch。model 与 variant 合并；hidden=false 视为不写。 */
export function buildPatch(draft: EditorDraft): AgentPatch {
  const model = draft.model
    ? draft.variant
      ? `${draft.model}#${draft.variant}`
      : draft.model
    : undefined
  const patch: AgentPatch = {
    description: draft.description,
    body: draft.body,
    matrix: draft.matrix,
  }
  if (model !== undefined) patch.model = model
  if (draft.color !== undefined) patch.color = draft.color
  if (draft.hidden === true) patch.hidden = true
  const steps = parseSteps(draft.stepsText)
  if (steps !== undefined) patch.steps = steps
  return patch
}

/** create 的 RPC 入参只需要有值的可选字段（避免把 undefined 塞进 JSON）。 */
export function optionalFieldsOf(patch: AgentPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {
    description: patch.description,
    body: patch.body,
    matrix: patch.matrix,
  }
  if (patch.model !== undefined) out.model = patch.model
  if (patch.color !== undefined) out.color = patch.color
  if (patch.hidden !== undefined) out.hidden = patch.hidden
  if (patch.steps !== undefined) out.steps = patch.steps
  return out
}

export interface ValidateInput {
  mode: "edit" | "create"
  id: string
  description: string
  stepsText?: string
  existingIds: readonly string[]
  loading?: boolean
}

export interface ValidateResult {
  /** 语义化错误码，由组件映射成 i18n 文案 */
  idError?: "invalid" | "reserved" | "duplicate"
  descriptionError?: "required"
  stepsError?: "invalid"
  canSave: boolean
}

/** 表单校验：只产出错误码，不产出文案（文案在组件里用 ctx.t 取）。 */
export function validateEditor(input: ValidateInput): ValidateResult {
  let idError: ValidateResult["idError"]
  if (input.mode === "create") {
    const v = input.id
    if (!isValidAgentId(v)) idError = "invalid"
    else if (isReservedId(v)) idError = "reserved"
    else if (input.existingIds.includes(v)) idError = "duplicate"
  }
  const descriptionError =
    input.description.trim().length === 0 ? ("required" as const) : undefined
  let stepsError: ValidateResult["stepsError"]
  if (input.stepsText !== undefined && input.stepsText.trim() !== "") {
    if (parseSteps(input.stepsText) === undefined) stepsError = "invalid"
  }
  const canSave =
    idError === undefined &&
    descriptionError === undefined &&
    stepsError === undefined &&
    input.loading !== true
  return { idError, descriptionError, stepsError, canSave }
}

/**
 * 从 read 结果构造「内容不变」的 patch。
 * P2-T4 / P3 的 V1 开关迁移路径复用：先读出当前内容，再原样 patch 回去触发整份迁移。
 */
export function patchFromRead(res: ReadOutput): AgentPatch {
  const meta = res.meta as Record<string, unknown>
  const rules = Array.isArray(meta.permissions) ? (meta.permissions as PermissionRule[]) : undefined
  const v1Permission =
    res.format === "v1" && meta.permission && typeof meta.permission === "object"
      ? (meta.permission as Record<string, unknown>)
      : undefined
  const patch: AgentPatch = {
    description: typeof meta.description === "string" ? meta.description : "",
    body: res.body,
    matrix: matrixFromRules(rules, v1Permission),
  }
  if (typeof meta.model === "string") patch.model = meta.model
  if (typeof meta.color === "string") patch.color = meta.color
  if (meta.hidden === true) patch.hidden = true
  if (typeof meta.steps === "number") patch.steps = meta.steps
  return patch
}

/**
 * 冲突弹窗的三种结果如何落地（goal.md §12.3）：
 * - overwrite：带 force 再写一次
 * - reload / 取消（undefined）：返回列表重新进入。
 *   绝不能停在旧 hash 的编辑页，否则用户再点保存会立刻再次冲突。
 */
export function conflictAction(choice: "reload" | "overwrite" | undefined): "back" | "overwrite" {
  return choice === "overwrite" ? "overwrite" : "back"
}
