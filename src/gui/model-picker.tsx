// src/gui/model-picker.tsx —— 模型选择弹窗（goal.md §6.3）。
// P2-T5 占位：P2-T6 替换为完整实现（继承默认 + 搜索 + provider 分组 + 选中打勾）。
import type { Context } from "@opencode/plugin/gui"

export function openModelPicker(
  _ctx: Context,
  _opts: {
    current?: string
    variant?: string
    onPick: (model?: string, variant?: string) => void
  },
): void {
  // P2-T6 实现
}
