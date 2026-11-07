// src/core/frontmatter.ts —— frontmatter 拆分 / V1·V2 判别 / 解析 / 序列化 / V1→V2 迁移
// 序列化与迁移在 P2-T2 / P2-T3 补齐；本文件先提供解析三件套。
import { parseDocument } from "yaml"

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
  const meta = js !== null && typeof js === "object" && !Array.isArray(js) ? (js as Record<string, unknown>) : {}
  return { meta, body, format: detectFormat(meta), raw }
}
