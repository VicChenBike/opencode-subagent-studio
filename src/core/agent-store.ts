// src/core/agent-store.ts —— 目录推导、路径白名单、扫描、读取、写入、改名、回收站
// P1 版：推导 + 校验 + 扫描 + 读取。写入 / 改名 / 回收站在 P2-T4、P3-T1 补齐。
import crypto from "node:crypto"
import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { parseAgentFile } from "./frontmatter.ts"

export function userAgentsDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "agents")
}

export function projectAgentsDir(projectPath: string): string {
  return path.join(projectPath, ".opencode", "agents")
}

// 回收站与 agents/ 同级；绝不放在 agents/ 内（AGENTS.md 坑 6）
export function trashDirFor(agentsDir: string): string {
  return path.join(path.dirname(agentsDir), "agents-trash")
}

// goal.md §14.4：path.resolve + 前缀白名单，拒绝 .. 穿越。
// mode="read" 额外放行任意 <x>/.opencode/agents(/**) 形态（read 只拿到绝对路径、无法反推 scope，只读安全）；
// 写入操作必须 mode="write"（默认）走严格根白名单。
export function assertAllowedPath(
  target: string,
  roots: readonly string[],
  mode: "read" | "write" = "write",
): void {
  const resolved = path.resolve(target)
  const ok = roots.some((root) => {
    const r = path.resolve(root)
    return resolved === r || resolved.startsWith(r + path.sep)
  })
  const projectShaped = /(^|[\\/])\.opencode[\\/]agents([\\/]|$)/.test(resolved)
  if (!ok && !(mode === "read" && projectShaped)) {
    const err = new Error(`path outside allowed roots: ${resolved}`) as Error & { code: string }
    err.code = "invalid_path"
    throw err
  }
}

export function hashOf(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)
}

async function statOr(file: string): Promise<{ mtime: number } | null> {
  try {
    const st = await fs.stat(file)
    return { mtime: st.mtimeMs }
  } catch {
    return null
  }
}

// 自然字母序（大小写不敏感，goal.md §5.2）
export function compareIds(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" })
}

export async function listAgents(dir: string): Promise<AgentSummaryRow[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  const out: AgentSummaryRow[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const parent = entry.parentPath ?? path.join(dir, path.dirname(entry.name))
    const file = path.join(parent, entry.name)
    const id = path.relative(dir, file).replace(/\.md$/, "").split(path.sep).join("/")
    const content = await fs.readFile(file, "utf8")
    const parsed = parseAgentFile(content)
    const st = await statOr(file)
    const row: AgentSummaryRow = {
      id,
      path: file,
      description: typeof parsed.meta.description === "string" ? parsed.meta.description : "",
      disabled: parsed.meta.disabled === true,
      hidden: parsed.meta.hidden === true,
      format: parsed.format,
      hash: hashOf(content),
      mtime: st?.mtime ?? 0,
    }
    // 可选字段只在有值时写入：宿主按 RPC output schema 对返回值做 encode，
    // 声明为 string 的字段若以「值为 undefined 的自有属性」存在会抛 Expected string，
    // 导致整个 list 请求 500（2026-11-07 桌面端实测）。
    if (typeof parsed.meta.color === "string") row.color = parsed.meta.color
    if (typeof parsed.meta.model === "string") row.model = parsed.meta.model
    out.push(row)
  }
  return out.sort((a, b) => compareIds(a.id, b.id))
}

export interface AgentSummaryRow {
  id: string
  path: string
  description: string
  color?: string
  model?: string
  disabled: boolean
  hidden: boolean
  format: "v1" | "v2"
  hash: string
  mtime: number
}

export async function readAgentFile(
  filePath: string,
): Promise<{ meta: Record<string, unknown>; body: string; format: "v1" | "v2"; hash: string; mtime: number }> {
  const content = await fs.readFile(filePath, "utf8")
  const parsed = parseAgentFile(content)
  const st = await statOr(filePath)
  return { meta: parsed.meta, body: parsed.body, format: parsed.format, hash: hashOf(content), mtime: st?.mtime ?? 0 }
}
