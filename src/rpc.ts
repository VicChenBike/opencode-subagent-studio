// src/rpc.ts —— RPC 契约与共享类型。GUI 与服务端共同 import。
// 从 "@opencode/plugin/rpc" 导入（App 共享模块，GUI bundle 必须 external，见 §0.2-12）。
import { Rpc } from "@opencode/plugin/rpc"

// ---------- 共享类型 ----------
export type Effect = "allow" | "ask" | "deny"
export const ACTIONS = [
  "read", "glob", "grep", "edit", "shell",
  "webfetch", "websearch", "skill", "subagent", "question",
] as const
export type ActionName = (typeof ACTIONS)[number]

export interface PermissionRule {
  action: string
  resource: string
  effect: Effect
}

export interface PermissionMatrix {
  defaultEffect: Effect
  actions: Record<ActionName, Effect>
}

export interface AgentSummary {
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

export interface BuiltinSummary {
  id: "general" | "explore"
  model?: string
}

export interface ProviderSummary {
  id: string
  name: string
  models: { id: string; name: string; variants: string[] }[]
}

export type AgentMeta = Record<string, unknown>

export interface AgentPatch {
  description: string
  body: string
  model?: string
  color?: string
  hidden?: boolean
  steps?: number
  matrix: PermissionMatrix
}

export interface MigrateChange {
  field: string
  action: "delete" | "rename" | "convert" | "merge"
  from?: string
  to?: string
}

/** 契约声明的错误码全集（§1.2）。handler 必须用 context.error 返回其中之一，不能 throw。 */
export type ErrorCode =
  | "invalid_path"
  | "invalid_id"
  | "reserved_id"
  | "exists"
  | "not_found"
  | "conflict"
  | "migration_required"
  | "invalid_format"

export interface ListInput { scope: "user" | "project"; projectPath?: string }
export interface ListOutput { agents: AgentSummary[]; builtins: BuiltinSummary[] }
export interface ReadInput { path: string }
export interface ReadOutput { meta: AgentMeta; body: string; format: "v1" | "v2"; hash: string; mtime: number }
export interface CreateInput {
  scope: "user" | "project"
  projectPath?: string
  id: string
  description: string
  body: string
  model?: string
  color?: string
  hidden?: boolean
  steps?: number
  matrix?: PermissionMatrix
}
export interface CreateOutput { path: string }
export interface UpdateInput { path: string; expectedHash: string; patch: AgentPatch; force?: boolean }
export interface UpdateOutput { hash: string }
export interface RemoveInput { path: string }
export interface RemoveOutput { trashPath: string }
export interface RenameInput { path: string; newId: string }
export interface RenameOutput { path: string }
export interface SetDisabledInput { path: string; disabled: boolean; expectedHash: string }
export interface SetDisabledOutput { hash: string }
export interface ModelsOutput { providers: ProviderSummary[] }
export interface BuiltinOverridesOutput { general?: string; explore?: string }
export interface SetBuiltinModelInput { id: "general" | "explore"; model?: string }
export interface MigratePreviewInput { path: string }
export interface MigratePreviewOutput { before: string; after: string; changes: MigrateChange[] }
export interface WatchProjectInput { projectPath?: string }

// ---------- 错误 data schema（全部为空对象） ----------
const NO_DATA = { type: "object", properties: {}, additionalProperties: false } as const

const scopeField = { enum: ["user", "project"] } as const
const str = { type: "string" } as const
const num = { type: "number" } as const
const bool = { type: "boolean" } as const
const agentSummarySchema = {
  type: "object",
  properties: {
    id: str, path: str, description: str, color: str, model: str,
    disabled: bool, hidden: bool, format: { enum: ["v1", "v2"] }, hash: str, mtime: num,
  },
  required: ["id", "path", "description", "disabled", "hidden", "format", "hash", "mtime"],
} as const

// ---------- 契约 ----------
export const Subagents = Rpc.define({
  id: "subagent-manager",
  methods: {
    list: {
      input: { type: "object", properties: { scope: scopeField, projectPath: str }, required: ["scope"], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          agents: { type: "array", items: agentSummarySchema },
          builtins: {
            type: "array",
            items: { type: "object", properties: { id: { enum: ["general", "explore"] }, model: str }, required: ["id"] },
          },
        },
        required: ["agents", "builtins"],
        additionalProperties: false,
      },
      errors: { invalid_path: NO_DATA },
    },
    read: {
      input: { type: "object", properties: { path: str }, required: ["path"], additionalProperties: false },
      output: {
        type: "object",
        properties: { meta: { type: "object" }, body: str, format: { enum: ["v1", "v2"] }, hash: str, mtime: num },
        required: ["meta", "body", "format", "hash", "mtime"],
        additionalProperties: false,
      },
      errors: { invalid_path: NO_DATA, not_found: NO_DATA, invalid_format: NO_DATA },
    },
    create: {
      input: {
        type: "object",
        properties: {
          scope: scopeField, projectPath: str, id: str, description: str, body: str,
          model: str, color: str, hidden: bool, steps: num, matrix: { type: "object" },
        },
        required: ["scope", "id", "description", "body"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { path: str }, required: ["path"], additionalProperties: false },
      // S-12-1：create 走 createV2Content → assertValidPatch，畸形 matrix/color/steps/model
      // 会抛 invalid_format。缺这条声明时宿主按未声明错误名处理，直接 500。
      errors: { invalid_path: NO_DATA, invalid_id: NO_DATA, reserved_id: NO_DATA, exists: NO_DATA, invalid_format: NO_DATA },
    },
    update: {
      input: {
        type: "object",
        properties: { path: str, expectedHash: str, patch: { type: "object" }, force: bool },
        required: ["path", "expectedHash", "patch"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { hash: str }, required: ["hash"], additionalProperties: false },
      errors: { invalid_path: NO_DATA, not_found: NO_DATA, conflict: NO_DATA, invalid_format: NO_DATA, exists: NO_DATA },
    },
    remove: {
      input: { type: "object", properties: { path: str }, required: ["path"], additionalProperties: false },
      output: { type: "object", properties: { trashPath: str }, required: ["trashPath"], additionalProperties: false },
      errors: { invalid_path: NO_DATA, not_found: NO_DATA, exists: NO_DATA },
    },
    rename: {
      input: { type: "object", properties: { path: str, newId: str }, required: ["path", "newId"], additionalProperties: false },
      output: { type: "object", properties: { path: str }, required: ["path"], additionalProperties: false },
      errors: { invalid_path: NO_DATA, invalid_id: NO_DATA, reserved_id: NO_DATA, exists: NO_DATA, not_found: NO_DATA, invalid_format: NO_DATA },
    },
    setDisabled: {
      input: { type: "object", properties: { path: str, disabled: bool, expectedHash: str }, required: ["path", "disabled", "expectedHash"], additionalProperties: false },
      output: { type: "object", properties: { hash: str }, required: ["hash"], additionalProperties: false },
      errors: { invalid_path: NO_DATA, not_found: NO_DATA, conflict: NO_DATA, migration_required: NO_DATA, invalid_format: NO_DATA },
    },
    models: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          providers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: str, name: str,
                models: { type: "array", items: { type: "object", properties: { id: str, name: str, variants: { type: "array", items: str } }, required: ["id", "name", "variants"] } },
              },
              required: ["id", "name", "models"],
            },
          },
        },
        required: ["providers"],
        additionalProperties: false,
      },
    },
    builtinOverrides: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { general: str, explore: str },
        additionalProperties: false,
      },
    },
    setBuiltinModel: {
      input: { type: "object", properties: { id: { enum: ["general", "explore"] }, model: str }, required: ["id"], additionalProperties: false },
      output: { type: "object", properties: {}, additionalProperties: false },
      errors: { invalid_id: NO_DATA },
    },
    migratePreview: {
      input: { type: "object", properties: { path: str }, required: ["path"], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          before: str, after: str,
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: { field: str, action: { enum: ["delete", "rename", "convert", "merge"] }, from: str, to: str },
              required: ["field", "action"],
            },
          },
        },
        required: ["before", "after", "changes"],
        additionalProperties: false,
      },
      errors: { invalid_path: NO_DATA, not_found: NO_DATA, invalid_format: NO_DATA },
    },
    watchProject: {
      input: { type: "object", properties: { projectPath: str }, additionalProperties: false },
      output: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  events: {
    changed: { schema: { type: "object", properties: {}, additionalProperties: false } },
  },
})
