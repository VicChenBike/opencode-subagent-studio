// src/gui/model-picker-logic.ts —— 模型弹窗的纯逻辑（无 DOM / 无 Solid，可单测）。
import type { ProviderSummary } from "../rpc"

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
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return model.slice(0, slash)
}

/** 某模型的思考深度选项（goal.md §6.3：来自该模型的 variants）。 */
export function variantsOf(
  providers: readonly ProviderSummary[],
  model: string | undefined,
): string[] {
  const providerID = providerOfModel(model)
  if (!providerID) return []
  const slash = model!.indexOf("/")
  const modelID = model!.slice(slash + 1)
  const provider = providers.find((p) => p.id === providerID)
  return provider?.models.find((m) => m.id === modelID)?.variants ?? []
}

/** 弹窗里是否给某行打勾：比较完整的 provider/model（不含 #variant）。 */
export function isSelected(
  current: string | undefined,
  providerID: string,
  modelID: string,
): boolean {
  return current !== undefined && current === `${providerID}/${modelID}`
}
