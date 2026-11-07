// src/index.ts —— 服务端部分（Node 环境，随桌面端服务进程运行）。
// 改动本文件后必须重启 OpenCode Desktop 才生效（AGENTS.md §4.7）。
import { Plugin } from "@opencode/plugin"
import path from "node:path"
import { Subagents, ACTIONS } from "./rpc.ts"
import type {
  AgentSummary, ListOutput, ReadOutput, CreateOutput, UpdateOutput, RemoveOutput,
  RenameOutput, SetDisabledOutput, ModelsOutput, MigratePreviewOutput, ProviderSummary,
  PermissionMatrix, AgentPatch,
} from "./rpc.ts"
import {
  userAgentsDir, projectAgentsDir, listAgents, readAgentFile, assertAllowedPath,
  createAgentFile, updateAgentFile, setDisabledFile, renameAgentFile, trashAgentFile,
  previewMigrationFile,
} from "./core/agent-store.ts"
import { migratePreview } from "./core/frontmatter.ts"
import { runWithDeclaredErrors } from "./core/rpc-errors.ts"
import { createChangeDebouncer, watchAgentsDir } from "./core/watch.ts"
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
        // 内置代理固定两项；模型覆盖 P3-T5 接入（此处先无覆盖）
        const builtins = [
          { id: "general" as const },
          { id: "explore" as const },
        ]
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

      builtinOverrides: async () => notImplemented(), // P3-T5
      setBuiltinModel: async () => notImplemented(),  // P3-T5

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
          projectWatcher = watchAgentsDir(projectAgentsDir(q.projectPath), () => changeDebouncer.trigger())
        }
        return {}
      },
    })

    // 用户级目录常驻监听（goal.md §12.1）；目录不存在时 watchAgentsDir 会先创建
    const userWatcher = watchAgentsDir(userAgentsDir(), () => changeDebouncer.trigger())

    return () => {
      userWatcher?.close()
      projectWatcher?.close()
      projectWatcher = null
      changeDebouncer.dispose()
      void reg.dispose()
    }
  },
})
