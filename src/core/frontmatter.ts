// src/core/frontmatter.ts —— frontmatter 拆分 / V1·V2 判别 / 解析 / 序列化 / V1→V2 迁移
// 序列化见本文件「序列化」段；V1→V2 迁移在 P2-T3 追加。
import { parseDocument, Document } from "yaml"
import { matrixFromRules, rulesFromMatrix, rulesFromPermissionMap } from "./permissions.ts"
import { V1_ACTION_RENAME } from "./migrate-shared.ts"
import { parseModelRef } from "./model-ref.ts"
import type { AgentPatch, MigrateChange, PermissionRule } from "../rpc.ts"
import { ACTIONS } from "../rpc.ts"

export interface ParsedFile {
  meta: Record<string, unknown>
  body: string
  format: "v1" | "v2"
  raw: string
  /** frontmatter 无法安全表示为普通对象（未解析别名 / 循环引用），第七轮 R7-1 */
  invalid?: boolean
}

const V2_MARKERS = ["permissions", "request", "system", "disabled"] as const

export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  // Windows 编辑器可能带 UTF-8 BOM；不剥掉会让 ^--- 锚定失败，整个文件被当成正文（第六轮 I3）
  // m 标志让闭合的 ^--- 能锚定到行首；空 frontmatter（---\n---\n）因此可识别（第七轮 R7-11）。
  const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?\n?([\s\S]*)$/m.exec(raw.replace(/^\uFEFF/, ""))
  // m 标志下 ^ 也能匹配正文里的任意行首；只有 index 0 才是真正的 frontmatter 起始。
  if (!match || match.index !== 0) return { frontmatter: null, body: raw }
  // 去掉 `---` 之后的一个空行分隔符；正文其余内容原样保留
  return { frontmatter: match[1], body: match[2].replace(/^\r?\n/, "") }
}

/** 检测文本的行尾风格（混合时按 CRLF 处理）。第七轮 R7-10 */
export function detectEol(raw: string): "\n" | "\r\n" {
  return raw.includes("\r\n") ? "\r\n" : "\n"
}

/** 把一段内容统一成指定行尾。第七轮 R7-10 */
export function applyEol(content: string, eol: "\n" | "\r\n"): string {
  if (eol === "\n") return content
  return content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
}

export function detectFormat(meta: Record<string, unknown>): "v1" | "v2" {
  return V2_MARKERS.some((key) => key in meta) ? "v2" : "v1"
}

export function parseAgentFile(raw: string): ParsedFile {
  const { frontmatter, body } = splitFrontmatter(raw)
  if (frontmatter === null) return { meta: {}, body: raw, format: "v1", raw }
  const doc = parseDocument(frontmatter)
  // frontmatter 不是映射（纯标量 / 数组 / null / 解析失败）时按空 meta 处理，
  // 避免单个畸形文件让整份目录扫描抛错；无法安全表示的文件额外标 invalid（第七轮 R7-1）。
  const { meta, unsafe } = plainMetaOf(doc)
  // 先按原始字段判格式，再做 V1 归一化——否则归一化写入的 `disabled` 会让 V1 文件被误判成 V2
  const format = detectFormat(meta)
  normalizeV1Keys(meta)
  return { meta, body, format, raw, invalid: unsafe }
}

/**
 * V1 → V2 字段归一化（只读视图，不改文件）。
 *
 * AGENTS.md §3.4：V1 用 `disable`，V2 用 `disabled`。列表与开关只认 `disabled`，
 * 若不归一化，一个 `disable: true` 的 V1 文件会被显示成「启用」——与真值相反。
 * V2 已有的 `disabled` 优先，不被同名的 `disable` 覆盖。
 */
function normalizeV1Keys(meta: Record<string, unknown>): void {
  if (!("disabled" in meta) && typeof meta.disable === "boolean") {
    meta.disabled = meta.disable
  }
}

// ---------- 序列化 ----------

/**
 * 把映射形态的 `permissions` 就地展开成规则数组（第十二轮 S-12-10）。
 *
 * 官方 schema 只接受数组，宿主对映射形态直接忽略；但读视图若原样返回映射，
 * GUI 的矩阵推导会退化成「全 allow」，保存时就把用户手写的效果整体替换掉。
 * 读视图统一成规则数组，矩阵与既有规则两条通道才能看到同一份效果。
 */
export function normalizePermissionMapping(meta: Record<string, unknown>): void {
  const value = meta["permissions"]
  if (isPlainMapping(value)) meta["permissions"] = rulesFromPermissionMap(value)
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Document → 普通 JS 映射。
 *
 * 未解析别名（`*nope`）与循环引用（`&a [*a]`）会让 `toJS()` 抛错或产出无法 JSON 序列化的对象；
 * 这类文件统一降级成「空 meta + unsafe」，让调用方能跳过或报 invalid_format，
 * 而不是让一个坏文件炸掉整次目录扫描（第七轮 R7-1）。
 */
function plainMetaOf(doc: Document): { meta: Record<string, unknown>; unsafe: boolean } {
  let js: unknown
  try {
    js = doc.toJS()
  } catch {
    return { meta: {}, unsafe: true }
  }
  if (!isPlainMapping(js)) return { meta: {}, unsafe: false }
  try {
    // JSON.stringify 是探测循环引用的最直接方式；能序列化才算安全。
    JSON.stringify(js)
  } catch {
    return { meta: {}, unsafe: true }
  }
  return { meta: js, unsafe: false }
}

function rulesToNode(doc: Document, rules: readonly PermissionRule[]) {
  return doc.createNode(
    rules.map((r) => ({ action: r.action, resource: r.resource, effect: r.effect })),
  )
}

function bodyFromPatch(patch: Pick<AgentPatch, "body">): string {
  // 保存时 trim 尾部空白，保留开头（goal.md §6.5）
  const trimmedEnd = patch.body.replace(/\s+$/, "")
  return trimmedEnd.length > 0 ? trimmedEnd + "\n" : ""
}

// 带解析错误（重复键 / 坏缩进 / 未闭引号等）的 Document 无法 toString；
// 提前转成声明错误码 invalid_format，避免裸 throw 被宿主包成 rpc.internal 500（第六轮 I1）。
// 第七轮 R7-1：未解析别名 / 循环引用不一定进 doc.errors，但 toJS/JSON.stringify 会抛，同样要拦。
function invalidFormatError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = "invalid_format"
  return err
}

export function assertDocSound(doc: Document): void {
  if (doc.errors.length > 0) {
    throw invalidFormatError(`invalid frontmatter: ${doc.errors[0].message}`)
  }
  try {
    const js = doc.toJS()
    if (js !== null && js !== undefined) JSON.stringify(js)
  } catch {
    throw invalidFormatError("invalid frontmatter: unrepresentable value")
  }
}

const EFFECTS: readonly string[] = ["allow", "ask", "deny"]
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

// RPC 写入边界校验（第十一轮 F2/F3）：契约里 matrix/patch 只声明 type:"object"，
// 内部结构必须在写盘前自查——否则畸形输入要么 TypeError 变 rpc.internal 500，
// 要么把非法 effect/steps/color/model 原样写进代理文件。空 model/color 沿用「删除/继承」语义。
export function assertValidPatch(patch: AgentPatch): void {
  if (typeof patch.description !== "string") throw invalidFormatError("patch.description must be a string")
  if (typeof patch.body !== "string") throw invalidFormatError("patch.body must be a string")
  if (patch.model !== undefined && patch.model !== "") {
    if (typeof patch.model !== "string" || parseModelRef(patch.model) === null) {
      throw invalidFormatError(`invalid model ref: ${String(patch.model)}`)
    }
  }
  if (patch.color !== undefined && patch.color !== "") {
    if (typeof patch.color !== "string" || !COLOR_PATTERN.test(patch.color)) {
      throw invalidFormatError(`invalid color: ${String(patch.color)}`)
    }
  }
  if (patch.steps !== undefined) {
    if (typeof patch.steps !== "number" || !Number.isSafeInteger(patch.steps) || patch.steps <= 0) {
      throw invalidFormatError(`invalid steps: ${String(patch.steps)}`)
    }
  }
  if (patch.hidden !== undefined && typeof patch.hidden !== "boolean") {
    throw invalidFormatError("patch.hidden must be a boolean")
  }
  const matrix = patch.matrix
  if (matrix === null || typeof matrix !== "object") throw invalidFormatError("patch.matrix must be an object")
  if (!EFFECTS.includes(matrix.defaultEffect)) throw invalidFormatError("matrix.defaultEffect must be allow/ask/deny")
  if (matrix.actions === null || typeof matrix.actions !== "object") throw invalidFormatError("matrix.actions must be an object")
  for (const action of ACTIONS) {
    if (!EFFECTS.includes(matrix.actions[action])) {
      throw invalidFormatError(`matrix.actions.${action} must be allow/ask/deny`)
    }
  }
}

// 新建文件：固定字段序 description/mode/model/hidden/color/steps/permissions（goal.md §7：一律 V2、无 name）
export function createV2Content(patch: AgentPatch): string {
  assertValidPatch(patch)
  const doc: Document = new Document()
  doc.set("description", patch.description)
  doc.set("mode", "subagent")
  if (patch.model) doc.set("model", patch.model)
  if (patch.hidden === true) doc.set("hidden", true)
  if (patch.color) doc.set("color", patch.color)
  if (typeof patch.steps === "number") doc.set("steps", patch.steps)
  doc.set("permissions", rulesToNode(doc, rulesFromMatrix(patch.matrix)))
  const fm = doc.toString().replace(/\n$/, "")
  const body = bodyFromPatch(patch)
  return `---\n${fm}\n---\n\n${body}`
}

// 既有文件打补丁：Document API 原地改，注释 / 键序 / 未知字段全保留（goal.md §9.3）
// 正文由 patch.body 决定，原文件的 body 不参与，因此只解构 frontmatter。
export function applyPatchToSource(raw: string, patch: AgentPatch): string {
  assertValidPatch(patch)
  const { frontmatter } = splitFrontmatter(raw)
  const doc: Document = frontmatter === null ? new Document() : parseDocument(frontmatter)
  assertDocSound(doc)
  const existingRules = extractRules(doc)
  // description（必填）
  doc.set("description", patch.description)
  // model：undefined = 删除（继承默认，goal.md §16-6）
  if (patch.model) doc.set("model", patch.model)
  else doc.delete("model")
  // color：无颜色 = 删除
  if (patch.color) doc.set("color", patch.color)
  else doc.delete("color")
  // hidden：true 才写
  if (patch.hidden === true) doc.set("hidden", true)
  else doc.delete("hidden")
  // steps：有值才写
  if (typeof patch.steps === "number") doc.set("steps", patch.steps)
  else doc.delete("steps")
  // permissions：整组替换（existing 的细粒度规则由 rulesFromMatrix 保留到末尾）
  doc.set("permissions", rulesToNode(doc, rulesFromMatrix(patch.matrix, existingRules)))
  const fm = doc.toString().replace(/\n$/, "")
  // 行尾跟随原文件：CRLF 文件写回后仍是 CRLF（第七轮 R7-10）
  return applyEol(`---\n${fm}\n---\n\n${bodyFromPatch(patch)}`, detectEol(raw))
}

// 从 Document 里读出既有 permissions 规则，供 rulesFromMatrix 保留细粒度项。
// 注意：doc.get(key, true) 对序列节点不一定返回普通 JS 数组，这里统一走 toJS() 取纯值。
//
// 第十二轮 S-12-10：映射形态（用户手写的 `permissions: { read: ask }`）也接受。
// 官方 schema 数组是唯一合法形态、宿主会忽略映射形态，但保存时整体替换成矩阵规则
// 会让这些效果被静默丢弃——这里复用 V1 permission→规则的展开逻辑把它们保留成既有规则
// （顶层 `"*"` 展开成默认档规则，与 R7-14 语义一致）。
function extractRules(doc: Document): PermissionRule[] {
  const js = doc.toJS()
  if (!isPlainMapping(js)) return []
  const value = js["permissions"]
  if (isPlainMapping(value)) return rulesFromPermissionMap(value)
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      action: String(item.action ?? "*"),
      resource: String(item.resource ?? "*"),
      effect: (item.effect === "ask" || item.effect === "deny" ? item.effect : "allow") as PermissionRule["effect"],
    }))
}

// ---------- V1 → V2 迁移（goal.md §9、AGENTS.md §3.4、opencode.ai/v2/docs/migrate-v1） ----------
// 规则：name 删；disable→disabled；permission→permissions（bash→shell / task→subagent /
// write|patch→edit，嵌套值展开为多条规则）；model+variant 合并；maxSteps→steps；
// temperature/top_p/options 删；tools 的 false 值转 deny 规则；prompt 字段在正文为空时并入正文；
// 未知字段与注释原样保留；整份文件一次性转换，不允许新旧混写。

const DROPPED_FIELDS = ["temperature", "top_p", "options"] as const
const RENAMES: Record<string, string> = { disable: "disabled", maxSteps: "steps" }

// MigrateChange 的唯一定义在 rpc.ts（契约源）；这里只再导出，供 GUI / 服务端统一 import。
export type { MigrateChange }

export function migratePreview(raw: string): { before: string; after: string; changes: MigrateChange[] } {
  const { content, changes } = migrateContent(raw)
  return { before: raw, after: content, changes }
}

export function migrateContent(raw: string): { content: string; changes: MigrateChange[] } {
  const { frontmatter, body } = splitFrontmatter(raw)
  if (frontmatter === null) return { content: raw, changes: [] }
  const doc = parseDocument(frontmatter)
  assertDocSound(doc)
  // 通过 toJS + JSON.stringify 探测循环引用；不安全的 frontmatter 无法整份迁移（第七轮 R7-1）
  const { meta, unsafe } = plainMetaOf(doc)
  if (unsafe) throw invalidFormatError("invalid frontmatter: unrepresentable value")
  // 已经是 V2：整份原样返回，不做任何改动
  if (detectFormat(meta) === "v2") return { content: raw, changes: [] }
  const changes: MigrateChange[] = []

  // name → 删（V2 用文件名做 ID）
  if (doc.has("name")) {
    doc.delete("name")
    changes.push({ field: "name", action: "delete" })
  }
  // disable → disabled、maxSteps → steps
  for (const [from, to] of Object.entries(RENAMES)) {
    if (doc.has(from)) {
      const value = doc.get(from)
      doc.delete(from)
      doc.set(to, value)
      changes.push({ field: from, action: "rename", to })
    }
  }
  // temperature / top_p / options → 删（V2 代理层不支持）
  for (const field of DROPPED_FIELDS) {
    if (doc.has(field)) {
      doc.delete(field)
      changes.push({ field, action: "delete" })
    }
  }
  // model + variant 合并为 provider/model#variant
  const model = meta["model"]
  const variant = meta["variant"]
  if (typeof model === "string" && model.length > 0) {
    if (typeof variant === "string" && variant.length > 0) {
      const merged = `${model}#${variant}`
      // 第十二轮 S-12-9：合并结果必须先过 parseModelRef。`model: "a/b#v"` + `variant: "x"`
      // 会拼出 "a/b#v#x"（非法形态），旧实现直接写盘——宿主静默不生效。
      // 非法时保持 model 原值、删掉 variant 键，并记一条 delete 说明 variant 无法并入。
      if (parseModelRef(merged) !== null) {
        doc.set("model", merged)
        changes.push({ field: "model", action: "merge", to: merged })
      } else {
        changes.push({ field: "variant", action: "delete" })
      }
    }
  }
  if (doc.has("variant")) doc.delete("variant")

  // tools 的 false 值 → deny 规则。动作名必须先走 V1 改名表（bash→shell 等），
  // 否则生成宿主不认识的死规则、deny 静默失效（第六轮 C5）；改名后同 action 去重（write/patch 都→edit）。
  const toolRules: PermissionRule[] = []
  if (isPlainMapping(meta["tools"])) {
    const seen = new Set<string>()
    for (const [tool, enabled] of Object.entries(meta["tools"])) {
      if (enabled !== false) continue
      const action = V1_ACTION_RENAME[tool] ?? tool
      if (seen.has(action)) continue
      seen.add(action)
      toolRules.push({ action, resource: "*", effect: "deny" })
    }
    doc.delete("tools")
    changes.push({ field: "tools", action: "convert" })
  }

  // permission 映射 → permissions 规则数组
  const v1Permission = meta["permission"]
  if (isPlainMapping(v1Permission)) {
    const matrix = matrixFromRules(undefined, v1Permission)
    const fine = flattenV1FineRules(v1Permission)
    const extra = extraV1Rules(v1Permission, matrix.defaultEffect)
    doc.delete("permission")
    // fine（非 * 细规则）走 rulesFromMatrix 的末尾保留通道；
    // extra（矩阵外 action 的 * 规则）与 toolRules 一样会被那条通道过滤，单独合并。
    doc.set("permissions", rulesToNode(doc, withToolRules(rulesFromMatrix(matrix, fine), [...extra, ...toolRules])))
    changes.push({ field: "permission", action: "convert", to: "permissions" })
  } else if (toolRules.length > 0) {
    // 只有 tools、无 permission：默认矩阵 + tools deny 规则
    const matrix = matrixFromRules(undefined)
    doc.set("permissions", rulesToNode(doc, withToolRules(rulesFromMatrix(matrix), toolRules)))
  }

  // prompt 字段：正文为空时并入正文，否则删（官方 migrate-v1：正文即提示词）
  let promptBody: string | null = null
  if (typeof meta["prompt"] === "string" && meta["prompt"].length > 0) {
    if (body.trim().length === 0) {
      promptBody = meta["prompt"]
      changes.push({ field: "prompt", action: "merge", to: "body" })
    } else {
      changes.push({ field: "prompt", action: "delete" })
    }
    doc.delete("prompt")
  }

  const fm = doc.toString().replace(/\n$/, "")
  const finalBody = promptBody !== null ? promptBody.replace(/\s+$/, "") + "\n" : body
  // 行尾跟随原文件：CRLF 文件迁移后仍是 CRLF（第七轮 R7-10）
  return { content: applyEol(`---\n${fm}\n---\n\n${finalBody}`, detectEol(raw)), changes }
}

// V1 permission 里需要原样带进 V2 的细粒度条目：嵌套映射中非 "*" 的 resource。
// 平映射条目由 extraV1Rules 处理（矩阵内的 action 由矩阵本身承载）。
function flattenV1FineRules(map: Record<string, unknown>): PermissionRule[] {
  const out: PermissionRule[] = []
  for (const [rawAction, value] of Object.entries(map)) {
    if (!isPlainMapping(value)) continue
    const action = V1_ACTION_RENAME[rawAction] ?? rawAction
    for (const [resource, effect] of Object.entries(value)) {
      if (resource === "*") continue
      out.push({ action, resource, effect: asEffect(effect) })
    }
  }
  return out
}

// 矩阵外 action 的平映射条目（如 todowrite），只有 effect 与默认不同才有语义。
// 这些规则的 resource 是 "*"，会被 rulesFromMatrix 的细规则通道过滤，故由调用方单独合并到末尾。
// 顶层 `"*"` 是默认档而非动作，由 matrixFromRules 提升为 defaultEffect（第七轮审查）。
function extraV1Rules(
  map: Record<string, unknown>,
  defaultEffect: PermissionRule["effect"],
): PermissionRule[] {
  const out: PermissionRule[] = []
  for (const [rawAction, value] of Object.entries(map)) {
    if (rawAction === "*") continue
    if (isPlainMapping(value)) continue
    const action = V1_ACTION_RENAME[rawAction] ?? rawAction
    if ((ACTIONS as readonly string[]).includes(action)) continue
    const effect = asEffect(value)
    if (effect !== defaultEffect) out.push({ action, resource: "*", effect })
  }
  return out
}

function asEffect(value: unknown): PermissionRule["effect"] {
  return value === "ask" ? "ask" : value === "deny" ? "deny" : "allow"
}

// tools 的 false 值转成的 deny 规则是 `action *`（resource 为 "*"），
// 会被 rulesFromMatrix 的「只保留非 * 细规则」过滤掉，所以在这里单独合并：
// 同 action + resource 的矩阵项被 tool 规则替换，其余追加到末尾（保持最后匹配生效）。
function withToolRules(
  rules: readonly PermissionRule[],
  toolRules: readonly PermissionRule[],
): PermissionRule[] {
  if (toolRules.length === 0) return [...rules]
  const out = rules.filter(
    (r) => !toolRules.some((t) => t.action === r.action && t.resource === r.resource),
  )
  out.push(...toolRules)
  return out
}
