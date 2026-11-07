// src/index.ts —— 服务端部分（Node 环境，随桌面端服务进程运行）。
// 改动本文件后必须重启 OpenCode Desktop 才生效（AGENTS.md §4.7）。
import { Plugin } from "@opencode/plugin"
import { Subagents } from "./rpc.ts"
import type { AgentSummary, ListOutput, ReadOutput } from "./rpc.ts"
import {
  userAgentsDir, projectAgentsDir, listAgents, readAgentFile, assertAllowedPath,
} from "./core/agent-store.ts"

// 未实现方法的桩：P2-T4 / P3 逐个替换
function notImplemented(): never {
  throw new Error("not_implemented")
}

export default Plugin.define({
  id: "subagent-manager",
  async setup(ctx) {
    const reg = await ctx.rpc.register(Subagents, {
      list: async (input): Promise<ListOutput> => {
        const q = input as { scope: "user" | "project"; projectPath?: string }
        const dir = q.scope === "project" && q.projectPath ? projectAgentsDir(q.projectPath) : userAgentsDir()
        // AgentSummaryRow 与 rpc.AgentSummary 结构逐字段一致，可直接赋值
        const agents: AgentSummary[] = await listAgents(dir)
        // 内置代理固定两项；模型覆盖 P3-T5 接入（此处先无覆盖）
        const builtins = [
          { id: "general" as const },
          { id: "explore" as const },
        ]
        return { agents, builtins }
      },

      read: async (input): Promise<ReadOutput> => {
        const q = input as { path: string }
        // read 只拿到绝对路径、无法反推 scope：用户级根 + 任意 <x>/.opencode/agents 形态（见 P1-T6 的 mode 参数）
        assertAllowedPath(q.path, [userAgentsDir()], "read")
        return await readAgentFile(q.path)
      },

      create: async () => notImplemented(),           // P2-T4
      update: async () => notImplemented(),           // P2-T4
      remove: async () => notImplemented(),           // P3-T1
      rename: async () => notImplemented(),           // P2-T4
      setDisabled: async () => notImplemented(),      // P2-T4
      models: async () => notImplemented(),           // P2-T4
      builtinOverrides: async () => notImplemented(), // P3-T5
      setBuiltinModel: async () => notImplemented(),  // P3-T5
      migratePreview: async () => notImplemented(),   // P2-T4
      watchProject: async () => notImplemented(),     // P3-T2
    })

    void reg
  },
})
