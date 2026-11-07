// src/core/frontmatter.ts —— frontmatter 拆分 / V1·V2 判别 / 解析 / 序列化 / V1→V2 迁移
// 序列化见本文件「序列化」段；V1→V2 迁移在 P2-T3 追加。
import { parseDocument, Document } from "yaml"
import { rulesFromMatrix } from "./permissions.ts"
import type { AgentPatch, PermissionRule } from "../rpc.ts"

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
