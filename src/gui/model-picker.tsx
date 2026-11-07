// src/gui/model-picker.tsx —— 模型选择弹窗（ctx.dialogs.open 自绘，goal.md §6.3）。
// 继承默认置顶 → 搜索 → provider 分组 → 当前选中打勾。
import { createSignal, createMemo, For, Show, onMount } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import { Subagents } from "../rpc"
import type { ProviderSummary, ModelsOutput } from "../rpc"
import { filterProviders, isSelected } from "./model-picker-logic"

export function openModelPicker(
  ctx: Context,
  opts: {
    current?: string
    variant?: string
    onPick: (model?: string, variant?: string) => void
  },
): void {
  ctx.dialogs.open((dialog) => <ModelPickerDialog ctx={ctx} dialog={dialog} {...opts} />)
}

interface DialogHandle {
  close: () => void
}

function ModelPickerDialog(props: {
  ctx: Context
  dialog: DialogHandle
  current?: string
  variant?: string
  onPick: (model?: string, variant?: string) => void
}) {
  const ctx = props.ctx
  const [providers, setProviders] = createSignal<ProviderSummary[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [query, setQuery] = createSignal("")

  onMount(() => {
    void (async () => {
      try {
        const res = (await ctx.client.rpc(Subagents).models({})) as unknown as ModelsOutput
        setProviders(res.providers)
      } catch (e) {
        setError(String((e as { message?: string })?.message ?? e))
      } finally {
        setLoaded(true)
      }
    })()
  })

  const filtered = createMemo(() => filterProviders(providers(), query()))

  const pick = (model?: string, variant?: string) => {
    props.onPick(model, variant)
    props.dialog.close()
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("picker.title")}
      size="large"
      footer={
        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
          <ctx.ui.Button variant="ghost" onClick={() => props.dialog.close()}>{ctx.t("common.cancel")}</ctx.ui.Button>
        </div>
      }
    >
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
        {/* 继承默认：固定在顶部，当前无模型时高亮（goal.md §6.3） */}
        <ctx.ui.Button variant={props.current ? "ghost" : "contrast"} onClick={() => pick(undefined)}>
          {ctx.t("picker.inherit")}
        </ctx.ui.Button>

        <ctx.ui.TextInput label={ctx.t("picker.search")} value={query()} onInput={setQuery} />

        <Show when={loaded()} fallback={<ctx.ui.Loader />}>
          <Show when={error()}>
            <div style={{ "font-size": "12px", opacity: 0.8, "word-break": "break-word" }}>{error()}</div>
          </Show>
          <Show
            when={filtered().length > 0}
            fallback={<div style={{ opacity: 0.6 }}>{ctx.t("picker.empty")}</div>}
          >
            <For each={filtered()}>
              {(p) => (
                <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
                  <div style={{ "font-weight": 600, opacity: 0.8, "margin-top": "6px" }}>{p.name}</div>
                  <For each={p.models}>
                    {(m) => {
                      const selected = () => isSelected(props.current, p.id, m.id)
                      return (
                        <ctx.ui.Button
                          variant={selected() ? "contrast" : "ghost"}
                          onClick={() => pick(`${p.id}/${m.id}`, undefined)}
                        >
                          <span>
                            {m.name}
                            {selected() ? " ✓" : ""}
                            {m.variants.length > 0 ? ` · ${m.variants.join(" / ")}` : ""}
                          </span>
                        </ctx.ui.Button>
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </ctx.ui.Dialog>
  )
}
