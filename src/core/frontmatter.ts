// src/core/frontmatter.ts —— frontmatter 拆分 / V1·V2 判别 / 解析 / 序列化 / V1→V2 迁移
// 序列化见本文件「序列化」段；V1→V2 迁移在 P2-T3 追加。
import { parseDocument, Document } from "yaml"
import { matrixFromRules, rulesFromMatrix } from "./permissions.ts"
import { V1_ACTION_RENAME } from "./migrate-shared.ts"
import type { AgentPatch, MigrateChange, PermissionRule } from "../rpc.ts"
import { ACTIONS } from "../rpc.ts"

export interface ParsedFile {
  meta: Record<string, unknown>
  body: string
  format: "v1" | "v2"
  raw: string
}

const V2_MARKERS = ["permissions", "request", "system", "disabled"] as const

export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { frontmatter: null, body: raw }
  // 去掉 `---` 之后的一个空行分隔符；正文其余内容原样保留
  return { frontmatter: match[1], body: match[2].replace(/^\r?\n/, "") }
}

export function detectFormat(meta: Record<string, unknown>): "v1" | "v2" {
  return V2_MARKERS.some((key) => key in meta) ? "v2" : "v1"
}

export function parseAgentFile(raw: string): ParsedFile {
  const { frontmatter, body } = splitFrontmatter(raw)
  if (frontmatter === null) return { meta: {}, body: raw, format: "v1", raw }
  const doc = parseDocument(frontmatter)
  const js = doc.toJS()
  // frontmatter 不是映射（纯标量 / 数组 / null / 解析失败）时按空 meta 处理，
  // 避免单个畸形文件让整份目录扫描抛错。
  const meta = isPlainMapping(js) ? (js as Record<string, unknown>) : {}
  return { meta, body, format: detectFormat(meta), raw }
}

// ---------- 序列化 ----------

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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

// 新建文件：固定字段序 description/mode/model/hidden/color/steps/permissions（goal.md §7：一律 V2、无 name）
export function createV2Content(patch: AgentPatch): string {
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
export function applyPatchToSource(raw: string, patch: AgentPatch): string {
  const { frontmatter, body } = splitFrontmatter(raw)
  void body
  const doc: Document = frontmatter === null ? new Document() : parseDocument(frontmatter)
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
  return `---\n${fm}\n---\n\n${bodyFromPatch(patch)}`
}

// 从 Document 里读出既有 permissions 规则，供 rulesFromMatrix 保留细粒度项。
// 注意：doc.get(key, true) 对序列节点不一定返回普通 JS 数组，这里统一走 toJS() 取纯值。
// 非数组（含 V1 的 permission 映射）视为无 V2 规则。
function extractRules(doc: Document): PermissionRule[] {
  const js = doc.toJS()
  if (!isPlainMapping(js)) return []
  const value = js["permissions"]
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
  const js = doc.toJS()
  const meta = isPlainMapping(js) ? js : {}
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
      doc.set("model", `${model}#${variant}`)
      changes.push({ field: "model", action: "merge", to: `${model}#${variant}` })
    }
  }
  if (doc.has("variant")) doc.delete("variant")

  // tools 的 false 值 → deny 规则
  const toolRules: PermissionRule[] = []
  if (isPlainMapping(meta["tools"])) {
    for (const [tool, enabled] of Object.entries(meta["tools"])) {
      if (enabled === false) toolRules.push({ action: tool, resource: "*", effect: "deny" })
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
  return { content: `---\n${fm}\n---\n\n${finalBody}`, changes }
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
function extraV1Rules(
  map: Record<string, unknown>,
  defaultEffect: PermissionRule["effect"],
): PermissionRule[] {
  const out: PermissionRule[] = []
  for (const [rawAction, value] of Object.entries(map)) {
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
