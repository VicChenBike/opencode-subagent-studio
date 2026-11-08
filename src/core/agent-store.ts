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
  assertDocSound, detectEol, applyEol,
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

/**
 * 按作用域解析 agents 目录（RPC list/create 共用）。
 * project 作用域必须带非空 projectPath，否则返回 invalid_path 而不是静默落到用户级目录
 * （第七轮 R7-6：旧的 `scope === "project" && projectPath` 三元表达式会静默降级）。
 */
export function resolveAgentsDir(scope: "user" | "project", projectPath?: string): string {
  if (scope === "project") {
    if (typeof projectPath !== "string" || projectPath.trim() === "") {
      fail("invalid_path", "project scope requires projectPath")
    }
    return projectAgentsDir(projectPath)
  }
  return userAgentsDir()
}

// create 的项目根必须是已存在的目录：写入白名单由路径形状推导（本地 RPC 威胁模型下
// 无法访问宿主项目列表），至少不能任由调用方在任意伪造路径下创建目录树（第六轮 I4）。
export async function assertProjectRootExists(projectPath: string): Promise<void> {
  const st = await fs.stat(projectPath).catch(() => null)
  if (!st || !st.isDirectory()) {
    fail("invalid_path", `project path is not an existing directory: ${projectPath}`)
  }
}

// 回收站与 agents/ 同级；绝不放在 agents/ 内（AGENTS.md 坑 6）
export function trashDirFor(agentsDir: string): string {
  return path.join(path.dirname(agentsDir), "agents-trash")
}

// 路径比较键：win32 下大小写不敏感（第七轮 R7-13）。
// 不做这一步时，用户级白名单会因盘符/目录大小写不同而误拒合法路径。
function pathKey(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

// basename 比较键：agentsRootOf 的目录名判定同样要跟随 win32 大小写不敏感（第十一轮 F4），
// 否则混合大小写的 .OpenCode/Agents 路径找不到根，回收站落回 agents/ 内部（C4 变体）。
function baseNameKey(p: string): string {
  const base = path.basename(p)
  return process.platform === "win32" ? base.toLowerCase() : base
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
  const key = pathKey(resolved)
  const ok = roots.some((root) => {
    const r = pathKey(root)
    return key === r || key.startsWith(r + path.sep)
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
    let parsed: ReturnType<typeof parseAgentFile>
    try {
      parsed = parseAgentFile(content)
    } catch {
      // 第七轮 R7-1：单个坏文件（未解析别名等）只跳过自己，不能炸掉整次扫描
      continue
    }
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
  // ENOENT 必须映射成契约错误码 not_found，而不是把裸 ENOENT 抛成 500（第七轮 R7-2）
  let content: string
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fail("not_found", `agent file not found: ${filePath}`)
    }
    throw err
  }
  const parsed = parseAgentFile(content)
  // 未解析别名 / 循环引用：读视图不可信，明确报 invalid_format（第七轮 R7-1）
  if (parsed.invalid === true) fail("invalid_format", `invalid frontmatter: ${filePath}`)
  const st = await statOr(filePath)
  let meta = parsed.meta
  let body = parsed.body
  // V1 返回「迁移后等效视图」：prompt 并入正文、model+variant 合并、maxSteps→steps、
  // permission/tools→permissions。GUI 的编辑器与 patchFromRead 都基于这份视图构造补丁，
  // 否则保存/开关会用原始 V1 的空正文与缺字段覆盖迁移结果，静默丢提示词/variant/steps/tools deny
  // （第六轮 C1/C2）。hash 仍是原始文件的 hash（冲突检测基准）；format 保持 v1（保存仍先弹迁移预览）。
  if (parsed.format === "v1") {
    try {
      const effective = parseAgentFile(migrateContent(content).content)
      meta = effective.meta
      body = effective.body
    } catch {
      // 畸形 YAML：回退原始视图让编辑页能打开；保存时由 invalid_format 明确报错，不会写盘
    }
  }
  return { meta, body, format: parsed.format, hash: hashOf(content), mtime: st?.mtime ?? 0 }
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
}

// 原子写：先写同目录临时文件再 rename 覆盖。中途崩溃/磁盘满不会把原文件截断（第六轮 I2）。
// writeFile 失败也要清理 tmp（第十一轮 F7：原来只有 rename 失败有清理）。
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpFile = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(tmpFile, content, "utf8")
    await fs.rename(tmpFile, filePath)
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => {})
    throw err
  }
}

// no-clobber 原子写（第十一轮 F1）：rename 在 Windows 会静默覆盖已存在目标，
// 「先读检查再写」在并发下两个调用都能通过检查。link 占位是原子的：目标已存在即 EEXIST。
async function atomicWriteNew(filePath: string, content: string): Promise<void> {
  const tmpFile = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(tmpFile, content, "utf8")
    await fs.link(tmpFile, filePath)
  } catch (err) {
    await fs.rm(tmpFile, { force: true }).catch(() => {})
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      fail("exists", `agent file already exists: ${filePath}`)
    }
    throw err
  }
  await fs.rm(tmpFile, { force: true }).catch(() => {})
}

// no-clobber 移动（第十一轮 F1）：link 占位 + 删源。中途崩溃最坏留下两个名字指向同一内容，
// 不会丢数据；rename 在 Windows 静默覆盖目标则会让输家源文件直接消失。
async function moveNoClobber(from: string, to: string): Promise<void> {
  try {
    await fs.link(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") fail("exists", `target already exists: ${to}`)
    if (code === "ENOENT") fail("not_found", `agent file not found: ${from}`)
    throw err
  }
  await fs.unlink(from)
}

// 只有 ENOENT 才算「不存在」；EBUSY/EACCES 等必须上抛，
// 否则 create/rename 会把读不了的存在文件当成空位覆盖掉（第六轮 M1）。
async function readRawOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
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

// 从文件路径反推 agents 根：向上找名为 agents 的目录，取「用户级根或父目录是 .opencode」
// 的最高有效候选。直接用 dirname(filePath) 会把嵌套代理的回收站放进 agents/ 内部（第六轮 C4）。
export function agentsRootOf(filePath: string): string {
  const resolved = path.resolve(filePath)
  const userRoot = path.resolve(userAgentsDir())
  const candidates: string[] = []
  let dir = path.dirname(resolved)
  for (;;) {
    if (baseNameKey(dir) === "agents") candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const valid = candidates.filter(
    (d) => pathKey(d) === pathKey(userRoot) || baseNameKey(path.dirname(d)) === ".opencode",
  )
  return valid[valid.length - 1] ?? candidates[0] ?? path.dirname(resolved)
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
  await atomicWriteNew(filePath, createV2Content(params))
  return filePath
}

// 回收站目标名去重：同一秒内两个同名文件（如 agents/a/reviewer.md 与 agents/b/reviewer.md）
// 不能互相覆盖。从原名开始，冲突时在扩展名前依次插入 -1、-2…，最多尝试 100 次（第七轮 R7-4）。
// 第十一轮 F1：占位必须原子——stat 检查在并发下会双双通过，link/copyFile(EXCL) 失败才重试下一个。
function trashCandidateNames(trash: string, base: string): string[] {
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  const names: string[] = []
  for (let i = 0; i < 100; i++) {
    names.push(path.join(trash, i === 0 ? base : `${stem}-${i}${ext}`))
  }
  return names
}

async function moveIntoTrash(filePath: string, trash: string, base: string): Promise<string> {
  for (const candidate of trashCandidateNames(trash, base)) {
    try {
      await fs.link(filePath, candidate)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "EEXIST") continue
      if (code === "ENOENT") fail("not_found", `agent file not found: ${filePath}`)
      throw err
    }
    await fs.unlink(filePath)
    return candidate
  }
  fail("exists", `cannot find a free trash name for: ${base}`)
}

async function backupToTrash(filePath: string, agentsDir: string): Promise<string> {
  const trash = trashDirFor(agentsDir)
  await fs.mkdir(trash, { recursive: true })
  const base = `.backup-${timestampStamp()}-${path.basename(filePath)}`
  for (const candidate of trashCandidateNames(trash, base)) {
    try {
      await fs.copyFile(filePath, candidate, fs.constants.COPYFILE_EXCL)
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue
      throw err
    }
  }
  fail("exists", `cannot find a free trash name for: ${base}`)
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
    await backupToTrash(params.filePath, agentsRootOf(params.filePath))
  }
  // V1 文件保存 = 整份迁移后再打补丁（goal.md §9.1；GUI 已先弹迁移预览）
  const base = parseAgentFile(raw).format === "v1" ? migrateContent(raw).content : raw
  const content = applyPatchToSource(base, params.patch)
  await atomicWrite(params.filePath, content)
  return { hash: hashOf(content) }
}

export async function setDisabledFile(params: {
  filePath: string
  roots: readonly string[]
  disabled: boolean
  expectedHash: string
}): Promise<{ hash: string }> {
  await assertWritable(params.filePath, params.roots)
  const raw = await readRaw(params.filePath)
  // CAS（第十一轮 F9）：读-改-写之间文件可能被外部改动，hash 不一致即 conflict，绝不静默覆盖
  if (hashOf(raw) !== params.expectedHash) {
    fail("conflict", `file changed on disk: ${params.filePath}`)
  }
  const parsed = parseAgentFile(raw)
  // goal.md §5.3：对 V1 文件写 disabled 会触发整份切 V2，必须先走迁移预览
  if (parsed.format === "v1") {
    fail("migration_required", "v1 file must be migrated before toggling disabled")
  }
  const { frontmatter, body } = splitFrontmatter(raw)
  const doc = frontmatter === null ? new Document() : parseDocument(frontmatter)
  assertDocSound(doc)
  if (params.disabled) doc.set("disabled", true)
  else doc.delete("disabled")
  const fm = doc.toString().replace(/\n$/, "")
  // 行尾跟随原文件：CRLF 文件开关后仍是 CRLF（第七轮 R7-10）
  const content = applyEol(`---\n${fm}\n---\n\n${body}`, detectEol(raw))
  await atomicWrite(params.filePath, content)
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
    assertDocSound(doc)
    doc.delete("name")
    content = applyEol(`---\n${doc.toString().replace(/\n$/, "")}\n---\n\n${body}`, detectEol(raw))
  }
  // 先改名再写内容：改名失败时原文件必须原封不动（不能先把 name 删了再失败，第七轮审查）
  await moveNoClobber(params.filePath, target)
  if (content !== raw) await atomicWrite(target, content)
  return { path: target }
}

// ---------- 回收站（P3-T1，goal.md §10） ----------
export async function trashAgentFile(params: {
  filePath: string
  roots: readonly string[]
}): Promise<{ trashPath: string }> {
  await assertWritable(params.filePath, params.roots)
  const raw = await readRawOrNull(params.filePath)
  if (raw === null) fail("not_found", `agent file not found: ${params.filePath}`)
  const trash = trashDirFor(agentsRootOf(params.filePath))
  await fs.mkdir(trash, { recursive: true })
  // 文件名：<yyyyMMdd-HHmmss>-<原名>.md（goal.md §10）；同秒同名追加 -1/-2…（第七轮 R7-4）
  const target = await moveIntoTrash(params.filePath, trash, `${timestampStamp()}-${path.basename(params.filePath)}`)
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
