// src/gui/permission-grid.tsx —— 三态权限矩阵（goal.md §6.4）
import { For } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { ACTIONS } from "../rpc"
import type { Effect, PermissionMatrix, ActionName } from "../rpc"

const EFFECTS = ["allow", "ask", "deny"] as const

function effectKey(e: Effect): string {
  return e === "allow" ? "perm.allow" : e === "ask" ? "perm.ask" : "perm.deny"
}

export function PermissionGrid(props: {
  matrix: PermissionMatrix
  onChange: (matrix: PermissionMatrix) => void
}) {
  const ctx = usePlugin()
  const effectLabel = (e: Effect) => ctx.t(effectKey(e))

  const setAction = (action: ActionName, effect: Effect) => {
    props.onChange({ ...props.matrix, actions: { ...props.matrix.actions, [action]: effect } })
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span style={{ flex: 1, "font-weight": 500 }}>{ctx.t("editor.permissions")}</span>
        <span style={{ opacity: 0.7 }}>{ctx.t("editor.permissions.default")}</span>
        <ctx.ui.Menu
          label={effectLabel(props.matrix.defaultEffect)}
          trigger="button"
          items={EFFECTS.map((e) => ({
            label: effectLabel(e),
            onSelect: () => props.onChange({ ...props.matrix, defaultEffect: e }),
          }))}
        />
      </div>
      <For each={[...ACTIONS]}>
        {(action) => (
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span style={{ flex: 1 }}>{ctx.t(`perm.action.${action}`)}</span>
            <div style={{ display: "flex", gap: "2px" }}>
              <For each={EFFECTS}>
                {(e) => (
                  <ctx.ui.Button
                    variant={props.matrix.actions[action] === e ? "contrast" : "ghost"}
                    size="small"
                    onClick={() => setAction(action, e)}
                  >
                    {effectLabel(e)}
                  </ctx.ui.Button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
