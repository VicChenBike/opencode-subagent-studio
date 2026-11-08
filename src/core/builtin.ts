// src/core/builtin.ts —— 内置代理模型覆盖（纯逻辑，goal.md §11）。
//
// general / explore 的提示词与权限不可改，只能换模型。
// 覆盖值存插件自己的 storage（键 `builtin-model.<id>`），通过 ctx.agent.transform 注入；
// 「继承默认」= 删除该键，下次 transform 就不再改写模型。
import type { ModelRefParts } from "./model-ref.ts"
import { parseModelRef } from "./model-ref.ts"

/** 允许覆盖的内置代理。 */
export const BUILTIN_IDS = ["general", "explore"] as const
export type BuiltinId = (typeof BUILTIN_IDS)[number]

/** 覆盖用的 storage 键前缀。 */
const KEY_PREFIX = "builtin-model."

/** ctx.agent.transform 的 editor 里我们用到的那部分（宿主签名见 @opencode/plugin/promise/agent）。 */
export interface AgentInfoLike {
  id: string
  name: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  permissions: readonly unknown[]
  request: Record<string, unknown>
  model?: { id: string; providerID: string; variant?: string }
  [key: string]: unknown
}

export interface AgentEditorLike {
  list(): readonly AgentInfoLike[]
  get(id: string): AgentInfoLike | undefined
  default(id: string | undefined): void
  update(id: string, update: (agent: AgentInfoLike) => void): void
  remove(id: string): void
}

export function overrideKeyOf(id: BuiltinId): string {
  return `${KEY_PREFIX}${id}`
}

export function builtinIdOf(key: string): BuiltinId | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined
  const id = key.slice(KEY_PREFIX.length)
  return (BUILTIN_IDS as readonly string[]).includes(id) ? (id as BuiltinId) : undefined
}

/** "provider/model#variant" → ModelRef；非法返回 undefined（与 parseModelRef 同一套规则）。 */
export function parseOverride(value: string | undefined): ModelRefParts | undefined {
  return parseModelRef(value) ?? undefined
}

/**
 * 内置覆盖值是否合法（第七轮 R7-7）：空值 = 继承默认，合法；
 * 非空则必须是可解析的 "provider/model[#variant]"。
 */
export function isValidBuiltinModel(model: string | undefined): boolean {
  if (model === undefined || model === "") return true
  return parseOverride(model) !== undefined
}

/**
 * 把覆盖值应用到编辑器。
 * 只处理 `builtin-model.<id>` 形式且值合法的键；其余忽略。
 * 没有覆盖的内置代理完全不碰（保持宿主给的原生模型）。
 */
export function applyBuiltinOverrides(
  editor: AgentEditorLike,
  overrides: Readonly<Record<string, string | undefined>>,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    const id = builtinIdOf(key)
    if (id === undefined) continue
    const ref = parseOverride(value)
    if (ref === undefined) continue
    if (editor.get(id) === undefined) continue
    editor.update(id, (agent) => {
      const model: { id: string; providerID: string; variant?: string } = {
        id: ref.modelID,
        providerID: ref.providerID,
      }
      if (ref.variant !== undefined) model.variant = ref.variant
      agent.model = model
    })
  }
}

/** 覆盖值的闭包缓存：storage 是异步的，transform 回调必须同步，所以在 setup 时先读进来。 */
export type OverrideCache = Map<string, string>

/** 同步更新缓存（「继承默认」= 删除键）。storage 的异步写入由调用方并行发起。 */
export function applyBuiltinOverrideToCache(
  cache: OverrideCache,
  id: BuiltinId,
  model: string | undefined,
): void {
  const key = overrideKeyOf(id)
  if (model === undefined || model === "") cache.delete(key)
  else cache.set(key, model)
}

/**
 * 写内置覆盖：先落 storage，成功后再改缓存（第六轮 M10）。
 * 顺序反过来会在 storage 写失败时让 transform 继续应用一个重启后即消失的覆盖。
 * handler 在本函数返回后才 reload，同步 transform 约束不受影响。
 */
export async function writeBuiltinOverride(
  storage: { set: (key: string, value: string) => Promise<void>; remove: (key: string) => Promise<void> },
  cache: OverrideCache,
  id: (typeof BUILTIN_IDS)[number],
  model?: string,
): Promise<void> {
  const key = overrideKeyOf(id)
  if (model === undefined || model === "") {
    await storage.remove(key)
  } else {
    await storage.set(key, model)
  }
  applyBuiltinOverrideToCache(cache, id, model)
}

/**
 * 构造同步的 transform 回调（P1-1）。
 *
 * 宿主类型（@opencode/plugin/dist/promise/agent.d.ts）把 Transform 定义为同步 `(input) => void`。
 * 回调里一旦出现 await，执行会在第一个挂起处让出，applyBuiltinOverrides 就落到 transform pass
 * 之后——覆盖可能不生效或非确定生效。所以这里只读同步缓存，不碰 storage。
 */
export function createBuiltinTransform(
  getCache: () => OverrideCache,
): (editor: AgentEditorLike) => void {
  return (editor) => {
    const cache = getCache()
    const overrides: Record<string, string | undefined> = {}
    for (const id of BUILTIN_IDS) {
      const value = cache.get(overrideKeyOf(id))
      if (value !== undefined) overrides[overrideKeyOf(id)] = value
    }
    applyBuiltinOverrides(editor, overrides)
  }
}
