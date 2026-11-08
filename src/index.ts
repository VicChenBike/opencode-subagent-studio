// src/index.ts —— 服务端部分（Node 环境，随桌面端服务进程运行）。
// 改动本文件后必须重启 OpenCode Desktop 才生效（AGENTS.md §4.7）。
import { Plugin } from "@opencode/plugin"
import path from "node:path"
import fs from "node:fs/promises"
import { Subagents, ACTIONS } from "./rpc.ts"
import type {
  AgentSummary, ListOutput, ReadOutput, CreateOutput, UpdateOutput, RemoveOutput,
  RenameOutput, SetDisabledOutput, ModelsOutput, MigratePreviewOutput, ProviderSummary,
  PermissionMatrix, AgentPatch, BuiltinOverridesOutput, SetBuiltinModelInput, BuiltinSummary,
} from "./rpc.ts"
import {
  userAgentsDir, projectAgentsDir, listAgents, readAgentFile, assertAllowedPath,
  createAgentFile, updateAgentFile, setDisabledFile, renameAgentFile, trashAgentFile,
  previewMigrationFile, assertProjectRootExists, resolveAgentsDir,
} from "./core/agent-store.ts"
import { migratePreview } from "./core/frontmatter.ts"
import { runWithDeclaredErrors } from "./core/rpc-errors.ts"
import { createChangeDebouncer, watchAgentsDir, createWatcherSlot } from "./core/watch.ts"
import {
  BUILTIN_IDS, createBuiltinTransform, overrideKeyOf, writeBuiltinOverride, isValidBuiltinModel,
} from "./core/builtin.ts"
import type { OverrideCache } from "./core/builtin.ts"
import type { AgentsWatcher } from "./core/watch.ts"
import type { ErrorContextLike } from "./core/rpc-errors.ts"

function defaultMatrixActions(): PermissionMatrix["actions"] {
  return Object.fromEntries(ACTIONS.map((a) => [a, "allow" as const])) as PermissionMatrix["actions"]
}

// update / setDisabled / rename / remove 只拿到绝对路径，无法反推 scope：
// write 白名单 = 用户级根 + 该路径所在 <项目根>/.opencode/agents
// marker 查找大小写不敏感：win32 下盘符/目录大小写不同也要能反推出项目根（第七轮 R7-13）。
function rootsForScopeOf(filePath: string): string[] {
  const resolved = path.resolve(filePath)
  const marker = `${path.sep}.opencode${path.sep}agents`
  const idx = resolved.toLowerCase().lastIndexOf(marker.toLowerCase())
  if (idx !== -1) {
    return [userAgentsDir(), projectAgentsDir(resolved.slice(0, idx))]
  }
  return [userAgentsDir()]
}

export default Plugin.define({
  id: "subagent-manager",
  async setup(ctx) {
    // ---------- 内置代理模型覆盖（goal.md §11） ----------
    // 覆盖值存插件自己的 storage，键 `builtin-model.<id>`；删除键 = 继承默认。
    // 只改模型，提示词与权限不动（applyBuiltinOverrides 只写 agent.model）。
    //
    // P1-1（审查）：宿主的 Transform 回调是同步 `(input) => void`。回调里若 await storage，
    // 第一个挂起处就让出了，applyBuiltinOverrides 会落到 transform pass 之后执行。
    // 所以 setup 时先把覆盖读进闭包缓存，回调只同步读缓存。
    const overrideCache: OverrideCache = new Map()
    for (const id of BUILTIN_IDS) {
      const value = await ctx.storage.get(overrideKeyOf(id))
      // storage 里可能残留旧版本写入的非法值：不校验会让坏值既显示在列表、又进入 transform 缓存
      // （第七轮 R7-7 的读取侧对称加固）。
      if (typeof value === "string" && value.length > 0 && isValidBuiltinModel(value)) {
        overrideCache.set(overrideKeyOf(id), value)
      }
    }

    const readBuiltinOverrides = (): BuiltinOverridesOutput => {
      const out: BuiltinOverridesOutput = {}
      for (const id of BUILTIN_IDS) {
        const value = overrideCache.get(overrideKeyOf(id))
        if (value !== undefined) out[id] = value
      }
      return out
    }

    // transform 在每次 agent 重载后重放：同步读缓存并注入
    const transformReg = await ctx.agent.transform(
      createBuiltinTransform(() => overrideCache) as unknown as (editor: unknown) => void,
    )

    // ---------- 文件监听（goal.md §12.1）：去抖 300ms → reload → changed ----------
    const projectWatcher = createWatcherSlot()

    // 变化处理：重扫 → agent.reload() → 广播 changed。
    // 去抖与错误隔离在 core/watch.ts（可单测），这里只关心顺序。
    const changeDebouncer = createChangeDebouncer({
      delayMs: 300,
      run: async () => {
        await ctx.agent.reload()
        await reg.events.emit("changed", {})
      },
    })

    const reg = await ctx.rpc.register(Subagents, {
      list: async (input, context): Promise<ListOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as { scope: "user" | "project"; projectPath?: string }
        // project 缺 projectPath 时 resolveAgentsDir 直接返回 invalid_path，不再静默降级（第七轮 R7-6）
        const dir = resolveAgentsDir(q.scope, q.projectPath)
        // AgentSummaryRow 与 rpc.AgentSummary 结构逐字段一致
        const agents: AgentSummary[] = await listAgents(dir)
        // 内置代理固定两项，带上当前覆盖值（无覆盖则不写 model，GUI 显示「继承默认」）
        const overrides = await readBuiltinOverrides()
        const builtins: BuiltinSummary[] = BUILTIN_IDS.map((id) => {
          const model = overrides[id]
          return model === undefined ? { id } : { id, model }
        })
        return { agents, builtins }
      }),

      read: async (input, context): Promise<ReadOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as { path: string }
        // read 只拿到绝对路径、无法反推 scope：用户级根 + 任意 <x>/.opencode/agents 形态
        assertAllowedPath(q.path, [userAgentsDir()], "read")
        return await readAgentFile(q.path)
      }),

      create: async (input, context): Promise<CreateOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as {
          scope: "user" | "project"; projectPath?: string; id: string
          description: string; body: string; model?: string; color?: string
          hidden?: boolean; steps?: number; matrix?: PermissionMatrix
        }
        const dir = resolveAgentsDir(q.scope, q.projectPath)
        // 项目根必须已存在，杜绝在伪造路径下创建目录树（第六轮 I4）
        // resolveAgentsDir 已保证 project 作用域下 projectPath 非空（第七轮 R7-6）
        if (q.scope === "project") await assertProjectRootExists(q.projectPath as string)
        const filePath = await createAgentFile({
          dir,
          id: q.id,
          description: q.description,
          body: q.body,
          model: q.model,
          color: q.color,
          hidden: q.hidden,
          steps: q.steps,
          matrix: q.matrix ?? { defaultEffect: "allow", actions: defaultMatrixActions() },
        })
        await ctx.agent.reload()
        await reg.events.emit("changed", {})
        return { path: filePath }
      }),

      update: async (input, context): Promise<UpdateOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as { path: string; expectedHash: string; patch: AgentPatch; force?: boolean }
        const result = await updateAgentFile({
          filePath: q.path,
          roots: rootsForScopeOf(q.path),
          expectedHash: q.expectedHash,
          patch: q.patch,
          force: q.force,
        })
        await ctx.agent.reload()
        await reg.events.emit("changed", {})
        return result
      }),

      remove: async (input, context): Promise<RemoveOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as { path: string }
        const result = await trashAgentFile({ filePath: q.path, roots: rootsForScopeOf(q.path) })
        await ctx.agent.reload()
        await reg.events.emit("changed", {})
        return result
      }),

      rename: async (input, context): Promise<RenameOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as { path: string; newId: string }
        const result = await renameAgentFile({ filePath: q.path, roots: rootsForScopeOf(q.path), newId: q.newId })
        await ctx.agent.reload()
        await reg.events.emit("changed", {})
        return result
      }),

      setDisabled: async (input, context): Promise<SetDisabledOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as { path: string; disabled: boolean; expectedHash: string }
        const result = await setDisabledFile({ filePath: q.path, roots: rootsForScopeOf(q.path), disabled: q.disabled, expectedHash: q.expectedHash })
        await ctx.agent.reload()
        await reg.events.emit("changed", {})
        return result
      }),

      models: async (_input, context): Promise<ModelsOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const { data } = await ctx.model.list()
        const byProvider = new Map<string, ProviderSummary>()
        for (const m of data) {
          if (!m.enabled || m.status === "deprecated") continue
          let p = byProvider.get(m.providerID)
          if (!p) {
            p = { id: m.providerID, name: m.providerID, models: [] }
            byProvider.set(m.providerID, p)
          }
          p.models.push({
            id: m.modelID,
            name: m.name || m.modelID,
            variants: (m.variants ?? []).map((v) => v.id),
          })
        }
        return { providers: [...byProvider.values()].sort((a, b) => a.id.localeCompare(b.id)) }
      }),

      // 读取当前覆盖（goal.md §11）：storage 里没有键 = 继承默认
      builtinOverrides: async (): Promise<BuiltinOverridesOutput> => readBuiltinOverrides(),

      setBuiltinModel: async (input, context): Promise<unknown> =>
        runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
          const q = input as SetBuiltinModelInput
          if (!(BUILTIN_IDS as readonly string[]).includes(q.id)) {
            return (context as unknown as ErrorContextLike).error("invalid_id", `not a builtin: ${q.id}`, {})
          }
          // 非法模型引用必须在落 storage 前拒绝，否则坏值会进 transform 缓存（第七轮 R7-7）
          if (!isValidBuiltinModel(q.model)) {
            return (context as unknown as ErrorContextLike).error("invalid_id", `invalid model ref: ${String(q.model)}`, {})
          }
          await writeBuiltinOverride(ctx.storage, overrideCache, q.id, q.model)
          await ctx.agent.reload()
          await reg.events.emit("changed", {})
          return {}
        }),

      migratePreview: async (input, context): Promise<MigratePreviewOutput | unknown> => runWithDeclaredErrors(context as unknown as ErrorContextLike, async () => {
        const q = input as { path: string }
        assertAllowedPath(q.path, [userAgentsDir()], "read")
        // 文件缺失映射为契约错误码 not_found（中期审查 P3-2）
        return await previewMigrationFile({ filePath: q.path })
      }),

      // goal.md §12.1：项目级 agents/ 目录按需订阅；传空 = 停止监听
      watchProject: async (input) => {
        const q = input as { projectPath?: string }
        let next: AgentsWatcher | null = null
        if (q.projectPath) {
          // 项目根不存在时不启动监听，也不 mkdir 伪造路径（第六轮 I4）
          const rootExists = await fs.stat(q.projectPath).then((st) => st.isDirectory()).catch(() => false)
          if (rootExists) {
            next = watchAgentsDir(projectAgentsDir(q.projectPath), () => changeDebouncer.trigger(), { delayMs: 0 })
          }
        }
        // 先创建再替换（第十一轮 F5）：并发调用时后到的 replace 会关闭先到的句柄，不泄漏
        projectWatcher.replace(next)
        return {}
      },
    })

    // 用户级目录常驻监听（goal.md §12.1）；目录不存在时 watchAgentsDir 会先创建。
    // delayMs: 0 —— 去抖只在这一层做（下面 300ms）。watchAgentsDir 自带 300ms 默认值，
    // 两层叠加会让实际延迟变成 600ms，超出 goal.md §12.1 的规格。
    const userWatcher = watchAgentsDir(userAgentsDir(), () => changeDebouncer.trigger(), { delayMs: 0 })

    return () => {
      userWatcher?.close()
      projectWatcher.close()
      changeDebouncer.dispose()
      // dispose 返回 Promise（registration.d.ts），拒绝时不能变成未处理拒绝崩进程（第十一轮 F10）
      transformReg.dispose().catch(() => {})
      reg.dispose().catch(() => {})
    }
  },
})
