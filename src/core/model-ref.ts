// src/core/model-ref.ts —— "provider/model#variant" 引用解析（纯逻辑）
export interface ModelRefParts {
  providerID: string
  modelID: string
  variant?: string
}

export function parseModelRef(s: string | undefined): ModelRefParts | null {
  if (!s) return null
  const hashIndex = s.indexOf("#")
  // 多个 # 视为非法（goal.md §6.3）
  if (hashIndex !== -1 && s.indexOf("#", hashIndex + 1) !== -1) return null
  const base = hashIndex === -1 ? s : s.slice(0, hashIndex)
  const variant = hashIndex === -1 ? undefined : s.slice(hashIndex + 1)
  // "provider/model#" 的变体为空 → 非法
  if (variant === "") return null
  const slashIndex = base.indexOf("/")
  if (slashIndex === -1 || slashIndex === 0 || slashIndex === base.length - 1) return null
  return { providerID: base.slice(0, slashIndex), modelID: base.slice(slashIndex + 1), variant }
}

export function formatModelRef(ref: ModelRefParts): string {
  return ref.variant ? `${ref.providerID}/${ref.modelID}#${ref.variant}` : `${ref.providerID}/${ref.modelID}`
}
