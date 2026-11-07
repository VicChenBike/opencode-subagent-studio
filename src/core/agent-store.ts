// src/core/agent-store.ts —— 目录推导、路径白名单、扫描、读取、写入、改名、回收站
// 唯一 IO 模块，仅服务端 import。
import crypto from "node:crypto"
import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { parseDocument, Document } from "yaml"
import {
  parseAgentFile, createV2Content, applyPatchToSource, migrateContent, splitFrontmatter, migratePreview,
} from "./frontmatter.ts"
import { matrixFromRules } from "./permissions.ts"
import { isValidAgentId, isReservedId } from "./ids.ts"
import type { AgentPatch, MigrateChange, PermissionMatrix } from "../rpc.ts"

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
    // R1 遗留的扫描竞态：扫描期间文件可能被删除/改权限。
    // 单个文件读失败只跳过该文件，不能让整次 list 失败（否则 GUI 整页空白）。
    let content: string
    try {
      content = await fs.readFile(file, "utf8")
    } catch {
      continue
    }
    const parsed = parseAgentFile(content)
    // goal.md §5.2：列表只显示 mode 精确等于 subagent 的文件。
    // - primary：主代理本体（如 superpowers.md），不是子代理
    // - all：v1 暂不显示，避免与子代理混淆
    // - 无 mode：AGENTS.md §3.3 规定新建自定义代理默认 primary，同样排除
    // - frontmatter 缺失/畸形：parseAgentFile 已降级为 {} meta，无 mode，排除
    if (parsed.meta.mode !== "subagent") continue
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

// ---------- 写操作（P2-T4） ----------

function fail(code: string, message: string): never {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  throw err
}

function assertIdUsable(id: string): void {
  if (!isValidAgentId(id)) fail("invalid_id", `invalid agent id: ${id}`)
  if (isReservedId(id)) fail("reserved_id", `reserved agent id: ${id}`)
}

function idToPath(dir: string, id: string): string {
  // id 已过 ID_PATTERN（无 /、无 .），不会穿越
  return path.join(dir, `${id}.md`)
}

async function assertWritable(filePath: string, roots: readonly string[]): Promise<void> {
  assertAllowedPath(filePath, roots, "write")
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

async function readRawOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }
}

async function readRaw(filePath: string): Promise<string> {
  const raw = await readRawOrNull(filePath)
  if (raw === null) fail("not_found", `agent file not found: ${filePath}`)
  return raw
}

export function timestampStamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export async function createAgentFile(params: {
  dir: string
  id: string
  description: string
  body: string
  model?: string
  color?: string
  hidden?: boolean
  steps?: number
  matrix: PermissionMatrix
}): Promise<string> {
  assertIdUsable(params.id)
  const filePath = idToPath(params.dir, params.id)
  await assertWritable(filePath, [params.dir])
  if ((await readRawOrNull(filePath)) !== null) {
    fail("exists", `agent file already exists: ${filePath}`)
  }
  await fs.writeFile(filePath, createV2Content(params), "utf8")
  return filePath
}

async function backupToTrash(filePath: string, agentsDir: string): Promise<string> {
  const trash = trashDirFor(agentsDir)
  await fs.mkdir(trash, { recursive: true })
  const target = path.join(trash, `.backup-${timestampStamp()}-${path.basename(filePath)}`)
  await fs.copyFile(filePath, target)
  return target
}

export async function updateAgentFile(params: {
  filePath: string
  roots: readonly string[]
  expectedHash: string
  patch: AgentPatch
  force?: boolean
}): Promise<{ hash: string }> {
  await assertWritable(params.filePath, params.roots)
  const raw = await readRaw(params.filePath)
  const currentHash = hashOf(raw)
  if (currentHash !== params.expectedHash) {
    // goal.md §12.3：不一致即 conflict，绝不静默覆盖；force 时先备份到回收站目录
    if (!params.force) fail("conflict", `file changed on disk: ${params.filePath}`)
    await backupToTrash(params.filePath, path.dirname(params.filePath))
  }
  // V1 文件保存 = 整份迁移后再打补丁（goal.md §9.1；GUI 已先弹迁移预览）
  const base = parseAgentFile(raw).format === "v1" ? migrateContent(raw).content : raw
  const content = applyPatchToSource(base, params.patch)
  await fs.writeFile(params.filePath, content, "utf8")
  return { hash: hashOf(content) }
}

export async function setDisabledFile(params: {
  filePath: string
  roots: readonly string[]
  disabled: boolean
}): Promise<{ hash: string }> {
  await assertWritable(params.filePath, params.roots)
  const raw = await readRaw(params.filePath)
  const parsed = parseAgentFile(raw)
  // goal.md §5.3：对 V1 文件写 disabled 会触发整份切 V2，必须先走迁移预览
  if (parsed.format === "v1") {
    fail("migration_required", "v1 file must be migrated before toggling disabled")
  }
  const { frontmatter, body } = splitFrontmatter(raw)
  const doc = frontmatter === null ? new Document() : parseDocument(frontmatter)
  if (params.disabled) doc.set("disabled", true)
  else doc.delete("disabled")
  const fm = doc.toString().replace(/\n$/, "")
  const content = `---\n${fm}\n---\n\n${body}`
  await fs.writeFile(params.filePath, content, "utf8")
  return { hash: hashOf(content) }
}

export async function renameAgentFile(params: {
  filePath: string
  roots: readonly string[]
  newId: string
}): Promise<{ path: string }> {
  assertIdUsable(params.newId)
  await assertWritable(params.filePath, params.roots)
  const dir = path.dirname(params.filePath)
  const target = idToPath(dir, params.newId)
  // 二次校验：目标存在即拒（不覆盖别人的文件）
  if ((await readRawOrNull(target)) !== null) {
    fail("exists", `target already exists: ${target}`)
  }
  const raw = await readRaw(params.filePath)
  // V1 文件重命名后 name 与新文件名会不一致 → 直接删 name（goal.md §6.1）
  const parsed = parseAgentFile(raw)
  let content = raw
  if (parsed.format === "v1" && "name" in parsed.meta) {
    const { frontmatter, body } = splitFrontmatter(raw)
    const doc = frontmatter === null ? new Document() : parseDocument(frontmatter)
    doc.delete("name")
    content = `---\n${doc.toString().replace(/\n$/, "")}\n---\n\n${body}`
  }
  if (content !== raw) await fs.writeFile(params.filePath, content, "utf8")
  await fs.rename(params.filePath, target)
  return { path: target }
}

// ---------- 回收站（P3-T1，goal.md §10） ----------
export async function trashAgentFile(params: {
  filePath: string
  roots: readonly string[]
}): Promise<{ trashPath: string }> {
  await assertWritable(params.filePath, params.roots)
  const dir = path.dirname(params.filePath)
  const raw = await readRawOrNull(params.filePath)
  if (raw === null) fail("not_found", `agent file not found: ${params.filePath}`)
  const trash = trashDirFor(dir)
  await fs.mkdir(trash, { recursive: true })
  // 文件名：<yyyyMMdd-HHmmss>-<原名>.md（goal.md §10）
  const target = path.join(trash, `${timestampStamp()}-${path.basename(params.filePath)}`)
  await fs.rename(params.filePath, target)
  return { trashPath: target }
}

// ---------- 迁移预览（P2-T8 / 中期审查 P3-2） ----------
// 读文件失败必须映射成契约错误码 not_found，而不是把 ENOENT 抛成 500。
export async function previewMigrationFile(params: {
  filePath: string
}): Promise<{ before: string; after: string; changes: MigrateChange[] }> {
  const raw = await readRaw(params.filePath)
  return migratePreview(raw)
}
