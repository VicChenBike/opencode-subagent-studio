// src/gui/migration-dialog.tsx —— V1→V2 迁移预览（goal.md §9.2 左右对照）。
import { For, onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import type { MigrateChange } from "../rpc"
import { changeLines } from "./migration-logic"

export function MigrationDialog(props: {
  ctx: Context
  before: string
  after: string
  changes: readonly MigrateChange[]
  onConfirm: () => void
  onCancel: () => void
  /** 弹窗以任何方式关闭（含 Esc / 点外 / owner 卸载）都会触发；用于兜底 resolve，防 Promise 悬挂（第十一轮 GUI-1） */
  onClosed?: () => void
}) {
  const ctx = props.ctx
  onCleanup(() => props.onClosed?.())
  return (
    <ctx.ui.Dialog
      title={ctx.t("migrate.title")}
      description={ctx.t("migrate.desc")}
      size="x-large"
      // 隐藏标题栏的关闭按钮，引导用户走显式的「取消 / 转换并保存」。
      // 注意：宿主的 closable={false} 只隐藏按钮——Esc 与点外点击仍会关闭且不触发回调，
      // 所以保存流程不能依赖本弹窗的回调来 resolve（见 migration-logic.ts 的 saveStep 注释）。
      closable={false}
      footer={
        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
          <ctx.ui.Button variant="ghost" onClick={props.onCancel}>{ctx.t("common.cancel")}</ctx.ui.Button>
          <ctx.ui.Button variant="contrast" onClick={props.onConfirm}>{ctx.t("migrate.confirm")}</ctx.ui.Button>
        </div>
      }
    >
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <div style={{ flex: 1, "min-width": 0 }}>
            <div style={{ "font-weight": 600 }}>{ctx.t("migrate.before")}</div>
            <ctx.ui.Code content={props.before} language="markdown" />
          </div>
          <div style={{ flex: 1, "min-width": 0 }}>
            <div style={{ "font-weight": 600 }}>{ctx.t("migrate.after")}</div>
            <ctx.ui.Code content={props.after} language="markdown" />
          </div>
        </div>
        <For each={changeLines(props.changes)}>
          {(key) => <div style={{ "font-size": "12px", opacity: 0.8 }}>• {ctx.t(key)}</div>}
        </For>
      </div>
    </ctx.ui.Dialog>
  )
}
