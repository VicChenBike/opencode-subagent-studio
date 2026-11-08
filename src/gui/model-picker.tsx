// src/gui/model-picker.tsx —— 模型选择弹窗（ctx.dialogs.open 自绘，goal.md §6.3）。
// 继承默认置顶 → 搜索 → provider 分组 → 当前选中打勾。
import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import { Subagents } from "../rpc"
import type { ProviderSummary, ModelsOutput } from "../rpc"
import {
  filterProviders,
  isSelected,
  variantOnPick,
  acquirePickerGuard,
  releasePickerGuard,
  renewPickerGuard,
} from "./model-picker-logic"
import { errorDescription } from "./error-copy"

/**
 * 打开模型弹窗。
 *
 * 第十二轮 G-12-7：旧实现没有防重入，双击会叠出两个相同的弹窗，
 * 用户在其中一个选完后另一个仍在，两个 onPick 各自写一次。
 * 这里用模块级守卫（见 model-picker-logic.ts）挡掉重复点击；
 * 守卫由弹窗自身在关闭（选择 / 取消 / Esc / 点外 / owner 卸载）时释放。
 */
export function openModelPicker(
  ctx: Context,
  opts: {
    current?: string
    variant?: string
    onPick: (model?: string, variant?: string) => void
  },
): void {
  if (!acquirePickerGuard()) return
  try {
    ctx.dialogs.open((dialog) => <ModelPickerDialog ctx={ctx} dialog={dialog} {...opts} />)
  } catch (error) {
    // open 抛错（宿主未挂载等）时必须复位，否则模型弹窗再也打不开
    releasePickerGuard()
    throw error
  }
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
    // 弹窗已真正渲染：此后守卫一直持锁到关闭（TTL 只回收「从未渲染」的残留占用）
    renewPickerGuard()
    void (async () => {
      try {
        const res = (await ctx.client.rpc(Subagents).models({})) as unknown as ModelsOutput
        setProviders(res.providers)
      } catch (e) {
        // 已知错误码走 i18n 文案，与列表页/编辑页一致（第十一轮 GUI-4）
        setError(errorDescription(ctx.t, e) || String((e as { message?: string })?.message ?? e))
      } finally {
        setLoaded(true)
      }
    })()
  })

  // 弹窗以任何方式关闭都会卸载组件：这里释放单开守卫（含 Esc / 点外 / owner 卸载）
  onCleanup(() => releasePickerGuard())

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
          {/* G-12-7：错误分支独占渲染——旧实现同时显示错误文案与「没有匹配的模型」，
              用户会以为只是搜索没命中，而不是模型列表根本没拉到 */}
          <Show
            when={error()}
            fallback={
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
                              onClick={() => {
                                const ref = `${p.id}/${m.id}`
                                pick(ref, variantOnPick(ref, props.current, props.variant))
                              }}
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
            }
          >
            <div style={{ "font-size": "12px", opacity: 0.8, "word-break": "break-word" }}>{error()}</div>
          </Show>
        </Show>
      </div>
    </ctx.ui.Dialog>
  )
}
