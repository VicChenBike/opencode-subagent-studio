// src/core/permissions.ts —— 三态矩阵 ↔ permissions 规则数组（纯逻辑，goal.md §8）
// 共享类型与常量统一从 rpc.ts 导入（单一契约源，禁止双份定义）
import { ACTIONS, type Effect, type ActionName, type PermissionRule, type PermissionMatrix } from "../rpc.ts"
import { V1_ACTION_RENAME } from "./migrate-shared.ts"

// goal.md §8.4：OpenCode 对 read 的默认 .env 保护
const ENV_RULES: readonly PermissionRule[] = [
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

function asEffect(v: unknown): Effect {
  return v === "ask" ? "ask" : v === "deny" ? "deny" : "allow"
}

// V1 permission 映射的值：字符串（平映射）或对象（嵌套 resource→effect）
function flattenV1Permission(
  map: Record<string, unknown>,
): { action: string; resource: string; effect: Effect }[] {
  const out: { action: string; resource: string; effect: Effect }[] = []
  for (const [rawAction, value] of Object.entries(map)) {
    const action = V1_ACTION_RENAME[rawAction] ?? rawAction
    if (typeof value === "string") {
      out.push({ action, resource: "*", effect: asEffect(value) })
    } else if (value && typeof value === "object") {
      for (const [resource, effect] of Object.entries(value as Record<string, unknown>)) {
        out.push({ action, resource, effect: asEffect(effect) })
      }
    }
  }
  return out
}

/**
 * 映射形态的权限声明 → 规则数组（第十二轮 S-12-10）。
 *
 * 官方 schema 只接受数组，但用户手写的 V2 文件里出现 `permissions: { read: ask }`
 * 并不罕见；宿主会忽略它，而旧实现保存时会用矩阵规则整体覆盖、静默丢掉这些效果。
 * 展开规则与 V1 permission 完全一致：顶层 `"*"` 天然落成 `{action:"*",resource:"*"}`
 * 默认档规则（与 R7-14 语义一致），嵌套映射展开为细粒度规则。
 */
export function rulesFromPermissionMap(map: Record<string, unknown>): PermissionRule[] {
  return flattenV1Permission(map)
}

function lastStarEffect(rules: readonly PermissionRule[], action: string, fallback: Effect): Effect {
  let effect = fallback
  for (const r of rules) {
    if (r.action === action && r.resource === "*") effect = r.effect
    if (r.action === "*" && r.resource === "*") effect = r.effect
  }
  return effect
}

/**
 * 从规则数组（V2）或 V1 permission 映射推导展示矩阵。
 * - 有 V2 规则：对每个 action 取「最后一条匹配且 resource 为 *」的规则（goal.md §8.2）；
 *   defaultEffect 取 `*` 规则的最后一条，无则 allow。
 * - 只有 V1 映射：顶层 `"*"` 是默认档（不是动作），作为 defaultEffect（第七轮审查）；
 *   嵌套值仅取其 `*` 键的 effect 作为该 action 的展示值。
 */
export function matrixFromRules(
  rules: readonly PermissionRule[] | undefined,
  v1Permission?: Record<string, unknown>,
): PermissionMatrix {
  let defaultEffect: Effect = "allow"
  const starRules = (rules ?? []).filter((r) => r.action === "*" && r.resource === "*")
  if (starRules.length > 0) defaultEffect = starRules[starRules.length - 1].effect

  let source: readonly PermissionRule[] = rules ?? []
  if ((!rules || rules.length === 0) && v1Permission && typeof v1Permission === "object") {
    // V1 顶层 `"*": deny|ask|allow` 是默认档；不提升它会让整份矩阵的默认效果漂移（第七轮审查）
    const star = v1Permission["*"]
    if (typeof star === "string") defaultEffect = asEffect(star)
    source = flattenV1Permission(v1Permission)
  }

  const actions = {} as Record<ActionName, Effect>
  for (const action of ACTIONS) {
    actions[action] = lastStarEffect(source, action, defaultEffect)
  }
  return { defaultEffect, actions }
}

function hasFineReadRule(existing: readonly PermissionRule[] | undefined): boolean {
  return (existing ?? []).some((r) => r.action === "read" && r.resource !== "*")
}

/**
 * 矩阵 → 规则数组（goal.md §8.3 顺序）：
 * 1. `*` 规则打头；2. ACTIONS 固定顺序的 `action *` 规则；
 * 3. 用户未改动 read 且无 read 细粒度规则时，追加三条 .env 默认保护（goal.md §8.4）；
 * 4. 保留 existing 中非 `resource:"*"` 的细粒度规则（含用户自定义 .env 规则），**追加在最末尾**。
 *
 * 3 必须在 4 之前：.env 默认只是默认，用户自己的细粒度规则要排在它后面才能在
 * 「最后匹配生效」里赢。
 *
 * 「未改动 read」与**文件原值**比较，而不是与 defaultEffect 比较（第七轮 R7-9）：
 * 只改默认档时 read 仍是 allow，保护必须保留；read 被显式改成非 allow 时不得再补 ask。
 */
export function rulesFromMatrix(
  matrix: PermissionMatrix,
  existing?: readonly PermissionRule[],
): PermissionRule[] {
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: matrix.defaultEffect }]
  for (const action of ACTIONS) {
    rules.push({ action, resource: "*", effect: matrix.actions[action] })
  }
  const all = existing ?? []
  const fine = all.filter((r) => r.resource !== "*")
  // 矩阵外 action 的 * 规则（如 todowrite）UI 没有对应行，必须原样保留，
  // 否则一次普通保存就把用户的 deny 静默删掉（第六轮 C3）。同 action 多条只留最后一条（最后匹配生效）。
  const extraStar = new Map<string, PermissionRule>()
  for (const r of all) {
    if (r.resource === "*" && r.action !== "*" && !(ACTIONS as readonly string[]).includes(r.action)) {
      extraStar.set(r.action, r)
    }
  }
  const baselineRead = matrixFromRules(existing).actions.read
  const readTouched = matrix.actions.read !== baselineRead
  if (!readTouched && matrix.actions.read === "allow" && !hasFineReadRule(existing)) {
    // hasFineReadRule 为假 ⇒ existing 里没有 read 细规则 ⇒ fine 里没有 read 项，
    // 因此这里无需再按 resource 去重（原先那层 filter 恒为真，是死谓词）。
    rules.push(...ENV_RULES)
  }
  rules.push(...extraStar.values())
  rules.push(...fine)
  return rules
}
