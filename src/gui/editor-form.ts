// src/gui/editor-form.ts —— 编辑表单的纯逻辑（无 DOM、无 Solid，可单测）。
// GUI 组件负责渲染与事件，判定逻辑都放这里，避免把校验埋进 JSX。
import { isValidAgentId, isReservedId } from "../core/ids.ts"
import { matrixFromRules } from "../core/permissions.ts"
import { parseModelRef } from "../core/model-ref.ts"
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
  const text = stepsText?.trim()
  if (text === undefined || text === "") return undefined
  // 只接受 plain 十进制（第十一轮 GUI-2）：Number() 会把 "0x10"/"1e3" 当合法输入，
  // 超精度大数还会静默变成另一个值写盘。
  if (!/^\d+$/.test(text)) return undefined
  const n = Number(text)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** 表单草稿 → RPC patch。model 与 variant 合并；hidden=false 视为不写。 */
export function buildPatch(draft: EditorDraft): AgentPatch {
  // draft.model 约定为不带后缀的 base ref（见 modelRefFromRead）。
  // 若调用方误传了已带后缀的值，先剥掉再拼，避免写出 a/b#high#high。
  const base = draft.model?.includes("#")
    ? draft.model.slice(0, draft.model.indexOf("#"))
    : draft.model
  const model = base ? (draft.variant ? `${base}#${draft.variant}` : base) : undefined
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
 *
 * 第十二轮 G-12-8：非法 color / model 不原样回写。服务端会对 patch 做形状校验并以
 * invalid_format 拒绝整次写入——那会让 V1 文件连「停用」都做不到。这里把它们剔除，
 * patch 不带该键时服务端删除文件里的对应字段，与编辑页首次保存的净化语义一致。
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
  const model = sanitizeLoadedModelRef(meta, res.format)
  if (model.model !== undefined) {
    patch.model = model.variant ? `${model.model}#${model.variant}` : model.model
  }
  const color = sanitizeLoadedColor(meta.color)
  if (color !== undefined) patch.color = color
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

export interface CreateScope {
  kind: "user" | "project"
  projectPath?: string
  projectName?: string
}

/**
 * create 的 RPC 入参（P2-T7）。
 * - 作用域继承列表当前选择
 * - 可选字段只带有值的（undefined 不进 JSON，避免宿主 schema 报错）
 * - projectName 是 UI 文案用的，绝不能进 RPC
 */
export function createInputOf(params: {
  scope: CreateScope
  id: string
  patch: AgentPatch
}): {
  scope: "user" | "project"
  projectPath?: string
  id: string
  description: string
  body: string
  model?: string
  color?: string
  hidden?: boolean
  steps?: number
  matrix: PermissionMatrix
} {
  const out: ReturnType<typeof createInputOf> = {
    scope: params.scope.kind === "user" ? "user" : "project",
    id: params.id,
    description: params.patch.description,
    body: params.patch.body,
    matrix: params.patch.matrix,
  }
  if (params.scope.kind === "project" && params.scope.projectPath !== undefined) {
    out.projectPath = params.scope.projectPath
  }
  if (params.patch.model !== undefined) out.model = params.patch.model
  if (params.patch.color !== undefined) out.color = params.patch.color
  if (params.patch.hidden !== undefined) out.hidden = params.patch.hidden
  if (params.patch.steps !== undefined) out.steps = params.patch.steps
  return out
}

/**
 * 判断一次保存失败是否是「文件已被外部修改」的冲突（goal.md §12.3）。
 * 只认契约错误码 type === "conflict"（顶层或藏在 data / cause 里）。
 * 不再用 message 含 "conflict" 的子串兜底——名为 conflict.md 的文件 not_found 会被误判（第六轮 M2）。
 */
export function isConflictError(error: unknown): boolean {
  if (error === null || error === undefined) return false
  const hit = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== "object" || depth > 3) return false
    const obj = value as Record<string, unknown>
    if (obj.type === "conflict") return true
    return hit(obj.data, depth + 1) || hit(obj.cause, depth + 1)
  }
  return hit(error, 0)
}

/**
 * 从 read 结果的 meta 还原模型引用（缺陷 B）。
 *
 * V1 文件把模型写成两个字段：`model: a/b` + `variant: high`；V2 只有一个 `model: a/b#high`。
 *
 * 约定：返回的 `model` 始终是**不带后缀**的 base ref，`variant` 独立返回。
 * 编辑器里所有消费方（显示行、深度下拉、模型弹窗打勾、buildPatch）都按这一约定工作：
 * 需要完整引用时自己拼一次 `#variant`，因此不会出现二次拼接。
 *
 * 若 model 本身已带后缀（V2 文件、或用户手写过），以后缀为准并把它从 base 里剥掉。
 */
export function modelRefFromRead(
  meta: Record<string, unknown>,
  format: "v1" | "v2",
): { model?: string; variant?: string } {
  const raw = typeof meta.model === "string" && meta.model.length > 0 ? meta.model : undefined
  if (raw === undefined) return { model: undefined, variant: undefined }
  if (raw.includes("#")) return splitModelRef(raw)
  const variant = format === "v1" && typeof meta.variant === "string" && meta.variant.length > 0
    ? meta.variant
    : undefined
  return { model: raw, variant }
}

/**
 * 合法的代理颜色：`#rrggbb`（与写入侧校验同一形状）。
 * 编辑页的调色板只提供 8 个色值，但用户手写文件里可能出现 `red` / `#f00`，
 * 服务端会以 invalid_format 拒绝整次保存。
 */
export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
}

/**
 * read 装载时的颜色净化（第十二轮 G-12-8）。
 * 非法值一律当作「未设置」：UI 显示继承默认，首次保存时 patch 不带 color，
 * 服务端 applyPatchToSource 对空 color 执行 doc.delete("color")，即把非法键从文件移除。
 */
export function sanitizeLoadedColor(raw: unknown): string | undefined {
  return isValidColor(raw) ? raw : undefined
}

/**
 * read 装载时的模型引用净化（第十二轮 G-12-8）。
 *
 * 与服务端 parseModelRef 对齐（R-12-1 回退后为宿主首斜杠语义）：缺 "/"、多个 "#"、
 * 空 variant 等是坏值；modelID 可含 "/"（models.dev 目录 id 如 openrouter/anthropic/...），
 * 是宿主合法引用，不得净化。
 * 坏值文件旧实现会让编辑页正常打开并显示该模型，用户点保存才被 invalid_format 拒绝，
 * 而错误文案是底层的 schema 描述，用户无从修正。
 * 现在把非法引用整体视为「未设置」（UI 显示继承默认），首次保存时 patch 不带 model，
 * 服务端随之删除该非法键——与服务端删键语义一致，且不会写出半截引用。
 */
export function sanitizeLoadedModelRef(
  meta: Record<string, unknown>,
  format: "v1" | "v2",
): { model?: string; variant?: string } {
  const ref = modelRefFromRead(meta, format)
  if (ref.model === undefined) return { model: undefined, variant: undefined }
  const full = ref.variant ? `${ref.model}#${ref.variant}` : ref.model
  return parseModelRef(full) === null ? { model: undefined, variant: undefined } : ref
}

/** 编辑页表单的可比较值集合（用于「用户是否改过」的判定）。 */
export interface EditorFormValues {
  description: string
  body: string
  model?: string
  variant?: string
  color?: string
  hidden: boolean
  stepsText?: string
  matrix: PermissionMatrix
}

/**
 * 表单是否与装载时的基线完全一致（第十二轮 G-12-9）。
 *
 * 重命名成功后编辑页会被关闭，此时若表单有未保存修改就会无声丢弃；
 * cancel() 有二次确认，两条路径必须一致，因此需要「是否 dirty」的判定。
 * steps 按数值语义比较：`" 8 "` 与 `"8"` 是同一个值，不算修改。
 */
export function formValuesEqual(a: EditorFormValues, b: EditorFormValues): boolean {
  if (a.description !== b.description) return false
  if (a.body !== b.body) return false
  if ((a.model ?? "") !== (b.model ?? "")) return false
  if ((a.variant ?? "") !== (b.variant ?? "")) return false
  if ((a.color ?? "") !== (b.color ?? "")) return false
  if (a.hidden !== b.hidden) return false
  if ((parseSteps(a.stepsText) ?? null) !== (parseSteps(b.stepsText) ?? null)) return false
  if (a.matrix.defaultEffect !== b.matrix.defaultEffect) return false
  const left = a.matrix.actions as Record<string, string | undefined>
  const right = b.matrix.actions as Record<string, string | undefined>
  const actions = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const action of actions) {
    if (left[action] !== right[action]) return false
  }
  return true
}
