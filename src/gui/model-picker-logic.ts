// src/gui/model-picker-logic.ts —— 模型弹窗的纯逻辑（无 DOM / 无 Solid，可单测）。
import type { ProviderSummary } from "../rpc"

/**
 * "provider/model" → 按**第一个** "/" 切分出 providerID 与 modelID。
 * 与宿主 Model.Ref.parse 及服务端 parseModelRef（R-12-1 回退后）同一语义：
 * modelID 可含 "/"（models.dev 目录 id 如 openrouter/anthropic/claude-sonnet-4）——
 * 第十二轮 G-12-10 曾误在 GUI 侧剔除这类模型，最终 Code Review R-12-1 实证宿主后回退。
 */
export function modelPartsOf(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

/** 按 provider id / model id / model name 过滤；大小写不敏感；无匹配 model 的 provider 被丢弃。 */
export function filterProviders(
  providers: readonly ProviderSummary[],
  query: string,
): ProviderSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return providers.map((p) => ({ ...p, models: [...p.models] }))
  const out: ProviderSummary[] = []
  for (const p of providers) {
    const providerHit = p.id.toLowerCase().includes(q)
    const models = providerHit
      ? [...p.models]
      : p.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q),
        )
    if (models.length > 0) out.push({ ...p, models })
  }
  return out
}

/** "provider/model" → provider 部分；无 "/" 视为非法。model id 可含 "/"，按首个 "/" 切。 */
// 重选当前已选模型时保留其 variant；换模型才清空（第六轮 M3）。
export function variantOnPick(
  picked: string,
  current: string | undefined,
  currentVariant: string | undefined,
): string | undefined {
  return picked === current ? currentVariant : undefined
}

export function providerOfModel(model: string | undefined): string | undefined {
  return modelPartsOf(model)?.providerID
}

/** 某模型的思考深度选项（goal.md §6.3：来自该模型的 variants）。 */
export function variantsOf(
  providers: readonly ProviderSummary[],
  model: string | undefined,
): string[] {
  const parts = modelPartsOf(model)
  if (!parts) return []
  const provider = providers.find((p) => p.id === parts.providerID)
  return provider?.models.find((m) => m.id === parts.modelID)?.variants ?? []
}

/** 弹窗里是否给某行打勾：比较完整的 provider/model（不含 #variant）。 */
export function isSelected(
  current: string | undefined,
  providerID: string,
  modelID: string,
): boolean {
  return current !== undefined && current === `${providerID}/${modelID}`
}

// ---------- 弹窗单开守卫（第十二轮 G-12-7） ----------
// ctx.dialogs.open 每次都叠一个新弹窗；双击模型按钮会得到两个相同的弹窗，
// 用户在其中之一选完后另一个还留着，且两个 onPick 各自写一次。
// 守卫放在模块级：组件实例会被重挂载，模块级才跨实例生效。
//
// 守卫带 TTL 只用于回收「宿主把打开延到 transition、而 owner 在此之前就结束」的残留占用：
// 那种情况弹窗永远不渲染、onCleanup 也不会跑，纯布尔锁会把模型弹窗永久锁死。
// 弹窗一旦真正渲染（onMount 调 renewPickerGuard），锁就一直持有到关闭。
const PICKER_GUARD_TTL_MS = 2000
let pickerOpenedAt: number | undefined
let pickerRendered = false

/** 尝试占用模型弹窗。已有弹窗打开时返回 false（调用方应直接忽略这次点击）。 */
export function acquirePickerGuard(now: number = Date.now()): boolean {
  if (pickerOpenedAt !== undefined) {
    if (pickerRendered) return false
    if (now - pickerOpenedAt < PICKER_GUARD_TTL_MS) return false
  }
  pickerOpenedAt = now
  pickerRendered = false
  return true
}

/**
 * 弹窗真正渲染后调用：标记占用已落实，此后 TTL 不再回收它。
 * 这样长时间开着的弹窗不会在 2 秒后被第二次点击叠开。
 */
export function renewPickerGuard(): void {
  if (pickerOpenedAt !== undefined) pickerRendered = true
}

/** 释放模型弹窗占用。弹窗以任何方式关闭（选择 / 取消 / Esc / 点外）都必须调用。 */
export function releasePickerGuard(): void {
  pickerOpenedAt = undefined
  pickerRendered = false
}

/** 仅供测试：清空守卫，避免用例间串扰。 */
export function resetPickerGuard(): void {
  pickerOpenedAt = undefined
  pickerRendered = false
}
