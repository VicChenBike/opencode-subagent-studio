// src/gui/editor.tsx —— 编辑 / 新建页（goal.md §6、§7）
// 判定逻辑在 editor-form.ts（可单测），本文件只负责渲染与事件。
import { createSignal, createMemo, Show, For, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Subagents, ACTIONS } from "../rpc"
import type { AgentPatch, PermissionMatrix, ReadOutput, ProviderSummary, ModelsOutput } from "../rpc"
import { matrixFromRules } from "../core/permissions.ts"
import { splitModelRef, buildPatch, validateEditor, createInputOf } from "./editor-form"
import { variantsOf } from "./model-picker-logic"
import { PermissionGrid } from "./permission-grid"
import { openModelPicker } from "./model-picker"

export interface EditorTarget {
  mode: "edit" | "create"
  path?: string
  id?: string
  draftId?: string
  scope: { kind: "user" } | { kind: "project"; projectPath: string; projectName: string }
}

const COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
]

function defaultMatrix(): PermissionMatrix {
  return {
    defaultEffect: "allow",
    actions: Object.fromEntries([...ACTIONS].map((a) => [a, "allow" as const])) as PermissionMatrix["actions"],
  }
}

export function EditorPage(props: {
  target: EditorTarget
  existingIds: () => string[]
  onBack: () => void
  onSaved: () => void
  onDelete?: () => void
}) {
  const ctx = usePlugin()
  const [loading, setLoading] = createSignal(props.target.mode === "edit")
  const [loadError, setLoadError] = createSignal<string | undefined>(undefined)
  const [hash, setHash] = createSignal<string | undefined>(undefined)
  const [format, setFormat] = createSignal<"v1" | "v2">("v2")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const [model, setModel] = createSignal<string | undefined>(undefined)
  const [variant, setVariant] = createSignal<string | undefined>(undefined)
  const [color, setColor] = createSignal<string | undefined>(undefined)
  const [hidden, setHidden] = createSignal(false)
  const [stepsText, setStepsText] = createSignal("")
  const [matrix, setMatrix] = createSignal<PermissionMatrix>(defaultMatrix())
  const [draftId, setDraftId] = createSignal(props.target.draftId ?? "")
  const [saving, setSaving] = createSignal(false)

  onMount(() => {
    if (props.target.mode !== "edit" || !props.target.path) return
    void (async () => {
      try {
        const res = (await ctx.client.rpc(Subagents).read({ path: props.target.path! })) as unknown as ReadOutput
        const meta = res.meta as Record<string, unknown>
        setHash(res.hash)
        setFormat(res.format)
        setDescription(typeof meta.description === "string" ? meta.description : "")
        setBody(res.body)
        const parts = splitModelRef(typeof meta.model === "string" ? meta.model : undefined)
        setModel(parts.model)
        setVariant(parts.variant)
        setColor(typeof meta.color === "string" ? meta.color : undefined)
        setHidden(meta.hidden === true)
        setStepsText(typeof meta.steps === "number" ? String(meta.steps) : "")
        setMatrix(
          matrixFromRules(
            Array.isArray(meta.permissions) ? (meta.permissions as never) : undefined,
            res.format === "v1" && meta.permission && typeof meta.permission === "object"
              ? (meta.permission as Record<string, unknown>)
              : undefined,
          ),
        )
      } catch (e) {
        setLoadError(String((e as { message?: string })?.message ?? e))
      } finally {
        setLoading(false)
      }
    })()
  })

  const id = () => (props.target.mode === "create" ? draftId() : props.target.id ?? "")
  const validation = createMemo(() =>
    validateEditor({
      mode: props.target.mode,
      id: id(),
      description: description(),
      stepsText: stepsText(),
      existingIds: props.existingIds(),
      loading: loading(),
    }),
  )

  const idErrorText = createMemo(() => {
    const e = validation().idError
    if (!e) return undefined
    if (e === "invalid") return ctx.t("editor.invalidId")
    if (e === "reserved") return ctx.t("editor.reservedId", { id: id() })
    return ctx.t("editor.duplicateId", { id: id() })
  })
  const descriptionErrorText = createMemo(() =>
    validation().descriptionError ? ctx.t("editor.description.required") : undefined,
  )
  const stepsErrorText = createMemo(() =>
    validation().stepsError ? ctx.t("editor.steps.invalid") : undefined,
  )

  const currentPatch = (): AgentPatch =>
    buildPatch({
      description: description(),
      body: body(),
      model: model(),
      variant: variant(),
      color: color(),
      hidden: hidden() ? true : undefined,
      stepsText: stepsText(),
      matrix: matrix(),
    })

  const save = async () => {
    if (!validation().canSave || saving()) return
    setSaving(true)
    try {
      if (props.target.mode === "create") {
        // P2-T7：作用域继承列表当前选择；可选字段按需带（createInputOf 已单测）
        await ctx.client.rpc(Subagents).create(
          createInputOf({ scope: props.target.scope, id: id(), patch: currentPatch() }),
        )
        ctx.toast.show({ title: ctx.t("toast.created"), variant: "success" })
      } else {
        const result = await saveUpdate()
        if (result === "reloaded") return
        ctx.toast.show({ title: ctx.t("toast.saved"), variant: "success" })
      }
      props.onSaved()
    } catch (e) {
      ctx.toast.show({
        title: ctx.t("common.error"),
        description: String((e as { message?: string })?.message ?? e),
        variant: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  const saveUpdate = async (): Promise<"saved" | "reloaded"> => {
    const pathArg = props.target.path!
    try {
      await ctx.client.rpc(Subagents).update({ path: pathArg, expectedHash: hash()!, patch: currentPatch() })
      return "saved"
    } catch (e) {
      const code = String((e as { type?: string; message?: string })?.type ?? (e as { message?: string })?.message ?? "")
      if (!code.includes("conflict")) throw e
      // goal.md §12.3：冲突三选一（重载 / 强制覆盖 / 取消）
      // 注意：宿主 SelectOptions 没有顶层 description，说明文案挂在各选项上。
      const choice = await ctx.dialogs.select<"reload" | "overwrite">({
        title: ctx.t("conflict.title"),
        placeholder: ctx.t("conflict.desc", { id: id() }),
        options: [
          { title: ctx.t("conflict.reload"), value: "reload" },
          { title: ctx.t("conflict.overwrite"), value: "overwrite", description: ctx.t("conflict.overwrite.desc") },
        ],
        current: "reload",
      })
      if (choice === "overwrite") {
        await ctx.client.rpc(Subagents).update({ path: pathArg, expectedHash: hash()!, patch: currentPatch(), force: true })
        return "saved"
      }
      // P2-1：选「重新加载」或取消弹窗都必须离开编辑页。
      // 停在旧 hash 的页面上再保存会立刻再次冲突。
      props.onBack()
      return "reloaded"
    }
  }

  const cancel = async () => {
    // 编辑期间恒有未保存内容，离开统一二次确认（goal.md §6.7）
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("editor.unsaved.title"),
      description: ctx.t("editor.unsaved.desc"),
    })
    if (!ok) return
    props.onBack()
  }

  return (
    <Show when={!loading()} fallback={<ctx.ui.Loader />}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "12px", padding: "12px", height: "100%", "overflow-y": "auto" }}>
        <Show when={loadError()}>
          <div style={{ border: "1px solid", "border-radius": "8px", padding: "16px", "font-size": "12px" }}>
            {loadError()}
          </div>
        </Show>

        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <ctx.ui.IconButton icon="outline-arrow-left" label={ctx.t("common.back")} onClick={() => void cancel()} />
          <div>
            <div style={{ "font-weight": 600 }}>
              {props.target.mode === "create" ? ctx.t("editor.create") : ctx.t("editor.title")}
            </div>
            <div style={{ opacity: 0.7, "font-size": "12px" }}>
              {ctx.t("editor.scope")}：
              {props.target.scope.kind === "user"
                ? ctx.t("list.scope.user")
                : ctx.t("list.scope.project", { project: props.target.scope.projectName })}
              {format() === "v1" ? " · V1" : ""}
            </div>
          </div>
        </div>

        {/* 名称：创建时可填并实时校验；编辑时只读（重命名走 P3-T6） */}
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <span style={{ width: "80px" }}>{ctx.t("editor.name")}</span>
          <Show
            when={props.target.mode === "create"}
            fallback={
              <span style={{ opacity: 0.8 }}>
                {id()} <span style={{ opacity: 0.5, "font-size": "12px" }}>{ctx.t("editor.nameReadonly")}</span>
              </span>
            }
          >
            <ctx.ui.TextInput
              label={ctx.t("editor.name")}
              value={draftId()}
              onInput={setDraftId}
              placeholder={ctx.t("editor.name.hint")}
              invalid={validation().idError !== undefined}
            />
          </Show>
        </div>
        <Show when={idErrorText()}>
          <span style={{ color: "#ef4444", "font-size": "12px" }}>{idErrorText()}</span>
        </Show>

        {/* 颜色 */}
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <span style={{ width: "80px" }}>{ctx.t("editor.color")}</span>
          <For each={COLORS}>
            {(c) => (
              <button
                title={c}
                aria-label={c}
                onClick={() => setColor(color() === c ? undefined : c)}
                style={{
                  width: "18px", height: "18px", "border-radius": "50%", background: c,
                  border: color() === c ? "2px solid currentColor" : "none", cursor: "pointer", padding: 0,
                }}
              />
            )}
          </For>
          <ctx.ui.Button variant="ghost" size="small" onClick={() => setColor(undefined)}>
            {ctx.t("editor.color.none")}
          </ctx.ui.Button>
        </div>

        {/* 模型 + 思考深度（goal.md §6.3） */}
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <span style={{ width: "80px" }}>{ctx.t("editor.model")}</span>
          <ctx.ui.Button
            variant="neutral"
            size="small"
            onClick={() =>
              openModelPicker(ctx, {
                current: model(),
                variant: variant(),
                onPick: (m, v) => { setModel(m); setVariant(v) },
              })
            }
          >
            {model() ? `${model()}${variant() ? `#${variant()}` : ""}` : ctx.t("list.inherit")}
          </ctx.ui.Button>
          <Show when={model()} fallback={<span style={{ opacity: 0.5 }}>{ctx.t("editor.depth.none")}</span>}>
            <DepthSelect model={model()} variant={variant()} onPick={setVariant} />
          </Show>
        </div>

        {/* 描述 */}
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <span style={{ width: "80px" }}>{ctx.t("editor.description")}</span>
          <ctx.ui.TextInput
            label={ctx.t("editor.description")}
            value={description()}
            onInput={setDescription}
            invalid={validation().descriptionError !== undefined}
          />
        </div>
        <Show when={descriptionErrorText()}>
          <span style={{ color: "#ef4444", "font-size": "12px" }}>{descriptionErrorText()}</span>
        </Show>

        <PermissionGrid matrix={matrix()} onChange={setMatrix} />

        {/* 系统提示词 */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
          <span style={{ "font-weight": 500 }}>{ctx.t("editor.prompt")}</span>
          <textarea
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
            style={{ "min-height": "180px", flex: 1, "font-family": "inherit", resize: "vertical" }}
          />
        </div>

        {/* 步数 + 隐藏 */}
        <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <span>{ctx.t("editor.steps")}</span>
            <ctx.ui.TextInput
              label={ctx.t("editor.steps")}
              value={stepsText()}
              onInput={setStepsText}
              invalid={validation().stepsError !== undefined}
            />
            <Show when={stepsErrorText()}>
              <span style={{ color: "#ef4444", "font-size": "12px" }}>{stepsErrorText()}</span>
            </Show>
          </div>
          <ctx.ui.Switch
            label={ctx.t("editor.hidden")}
            description={ctx.t("editor.hidden.desc")}
            checked={hidden()}
            onChange={setHidden}
          />
        </div>

        {/* 底部操作（删除在 P3-T1 接通） */}
        <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
          <Show when={props.target.mode === "edit" && props.onDelete}>
            <ctx.ui.Button variant="danger" onClick={() => void props.onDelete?.()}>
              {ctx.t("editor.delete")}
            </ctx.ui.Button>
          </Show>
          <div style={{ flex: 1 }} />
          <ctx.ui.Button variant="ghost" onClick={() => void cancel()}>{ctx.t("common.cancel")}</ctx.ui.Button>
          <ctx.ui.Button
            variant="contrast"
            disabled={!validation().canSave}
            busy={saving()}
            onClick={() => void save()}
          >
            {ctx.t("common.save")}
          </ctx.ui.Button>
        </div>
      </div>
    </Show>
  )
}

// 思考深度下拉：选项来自该模型的 variants（goal.md §6.3），复用 model-picker-logic 的推导
function DepthSelect(props: { model?: string; variant?: string; onPick: (v?: string) => void }) {
  const ctx = usePlugin()
  const [providers, setProviders] = createSignal<ProviderSummary[]>([])
  onMount(() => {
    void (async () => {
      try {
        const res = (await ctx.client.rpc(Subagents).models({})) as unknown as ModelsOutput
        setProviders(res.providers)
      } catch {
        setProviders([])
      }
    })()
  })
  const variants = createMemo(() => variantsOf(providers(), props.model))
  return (
    <Show when={variants().length > 0} fallback={<span style={{ opacity: 0.5 }}>{ctx.t("editor.depth.none")}</span>}>
      <ctx.ui.Menu
        label={props.variant ?? ctx.t("editor.depth.none")}
        trigger="button"
        items={[
          { label: ctx.t("editor.depth.none"), onSelect: () => props.onPick(undefined) },
          ...variants().map((v) => ({ label: v, onSelect: () => props.onPick(v) })),
        ]}
      />
    </Show>
  )
}
