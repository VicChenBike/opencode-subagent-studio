// src/index.ts —— 服务端部分（Node 环境，随桌面端服务进程运行）。
// 改动本文件后必须重启 OpenCode Desktop 才生效（AGENTS.md §4.7）。
import { Plugin } from "@opencode/plugin"
import path from "node:path"
import { Subagents, ACTIONS } from "./rpc.ts"
import type {
  AgentSummary, ListOutput, ReadOutput, CreateOutput, UpdateOutput, RemoveOutput,
  RenameOutput, SetDisabledOutput, ModelsOutput, MigratePreviewOutput, ProviderSummary,
  PermissionMatrix, AgentPatch, BuiltinOverridesOutput, SetBuiltinModelInput, BuiltinSummary,
} from "./rpc.ts"
import {
  userAgentsDir, projectAgentsDir, listAgents, readAgentFile, assertAllowedPath,
  createAgentFile, updateAgentFile, setDisabledFile, renameAgentFile, trashAgentFile,
  previewMigrationFile,
} from "./core/agent-store.ts"
import { migratePreview } from "./core/frontmatter.ts"
import { runWithDeclaredErrors } from "./core/rpc-errors.ts"
import { createChangeDebouncer, watchAgentsDir } from "./core/watch.ts"
import {
  applyBuiltinOverrideToCache, BUILTIN_IDS, createBuiltinTransform, overrideKeyOf,
} from "./core/builtin.ts"
import type { OverrideCache } from "./core/builtin.ts"
import type { AgentsWatcher } from "./core/watch.ts"
import type { ErrorContextLike } from "./core/rpc-errors.ts"

// 未实现方法的桩：P3 逐个替换
function notImplemented(): never {
  throw new Error("not_implemented")
}

function defaultMatrixActions(): PermissionMatrix["actions"] {
  return Object.fromEntries(ACTIONS.map((a) => [a, "allow" as const])) as PermissionMatrix["actions"]
}

// update / setDisabled / rename / remove 只拿到绝对路径，无法反推 scope：
// write 白名单 = 用户级根 + 该路径所在 <项目根>/.opencode/agents
function rootsForScopeOf(filePath: string): string[] {
  const resolved = path.resolve(filePath)
  const marker = `${path.sep}.opencode${path.sep}agents`
  const idx = resolved.lastIndexOf(marker)
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
      if (typeof value === "string" && value.length > 0) overrideCache.set(overrideKeyOf(id), value)
    }

    const readBuiltinOverrides = (): BuiltinOverridesOutput => {
      const out: BuiltinOverridesOutput = {}
      for (const id of BUILTIN_IDS) {
        const value = overrideCache.get(overrideKeyOf(id))
        if (value !== undefined) out[id] = value
      }
      return out
    }

    // 同步改缓存（transform 立刻能看到），storage 的写入并行进行。
    const writeBuiltinOverride = async (id: (typeof BUILTIN_IDS)[number], model?: string): Promise<void> => {
      applyBuiltinOverrideToCache(overrideCache, id, model)
      if (model === undefined || model === "") {
        await ctx.storage.remove(overrideKeyOf(id))
        return
      }
      await ctx.storage.set(overrideKeyOf(id), model)
    }

    // transform 在每次 agent 重载后重放：同步读缓存并注入
    const transformReg = await ctx.agent.transform(
      createBuiltinTransform(() => overrideCache) as unknown as (editor: unknown) => void,
    )

    // ---------- 文件监听（goal.md §12.1）：去抖 300ms → reload → changed ----------
    let projectWatcher: AgentsWatcher | null = null

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
        const dir = q.scope === "project" && q.projectPath ? projectAgentsDir(q.projectPath) : userAgentsDir()
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
        const dir = q.scope === "project" && q.projectPath ? projectAgentsDir(q.projectPath) : userAgentsDir()
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
        const q = input as { path: string; disabled: boolean }
        const result = await setDisabledFile({ filePath: q.path, roots: rootsForScopeOf(q.path), disabled: q.disabled })
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
          await writeBuiltinOverride(q.id, q.model)
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
        projectWatcher?.close()
        projectWatcher = null
        if (q.projectPath) {
          projectWatcher = watchAgentsDir(projectAgentsDir(q.projectPath), () => changeDebouncer.trigger(), { delayMs: 0 })
        }
        return {}
      },
    })

    // 用户级目录常驻监听（goal.md §12.1）；目录不存在时 watchAgentsDir 会先创建。
    // delayMs: 0 —— 去抖只在这一层做（下面 300ms）。watchAgentsDir 自带 300ms 默认值，
    // 两层叠加会让实际延迟变成 600ms，超出 goal.md §12.1 的规格。
    const userWatcher = watchAgentsDir(userAgentsDir(), () => changeDebouncer.trigger(), { delayMs: 0 })

    return () => {
      userWatcher?.close()
      projectWatcher?.close()
      projectWatcher = null
      changeDebouncer.dispose()
      void transformReg.dispose()
      void reg.dispose()
    }
  },
})
