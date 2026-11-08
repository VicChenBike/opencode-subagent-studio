// src/gui/editor.tsx —— 编辑 / 新建页（goal.md §6、§7）
// 判定逻辑在 editor-form.ts（可单测），本文件只负责渲染与事件。
import { createSignal, createMemo, Show, For, onMount, onCleanup } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Subagents, ACTIONS } from "../rpc"
import type { AgentPatch, PermissionMatrix, ReadOutput, ProviderSummary, ModelsOutput, MigrateChange } from "../rpc"
import { matrixFromRules } from "../core/permissions.ts"
import { buildPatch, validateEditor, createInputOf, conflictAction, isConflictError, sanitizeLoadedColor, sanitizeLoadedModelRef, formValuesEqual, type EditorFormValues } from "./editor-form"
import { variantsOf } from "./model-picker-logic"
import { saveStep } from "./migration-logic"
import { MigrationDialog } from "./migration-dialog"
import { renameAgentWithPrompt } from "./rename-flow"
import { errorDescription } from "./error-copy"
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
  /**
   * 自致写操作窗口（第十二轮 G-12-3）：编辑页发起写 RPC 前置位、响应后复位。
   * 列表页据此忽略服务端「先 emit changed 再返回结果」造成的那条事件，避免误弹「磁盘已更新」。
   */
  onSelfWriteChange?: (active: boolean) => void
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
  // 迁移预览打开期间禁止再次触发保存（第十一轮 GUI-5：否则会叠加第二个预览弹窗）
  const [previewOpen, setPreviewOpen] = createSignal(false)
  // V1 文件本次编辑是否已确认迁移预览（goal.md §9.1：首次保存前弹一次）
  const [migrateConfirmed, setMigrateConfirmed] = createSignal(false)
  /**
   * 装载时的表单快照（第十二轮 G-12-9）。
   * 重命名成功后编辑页会被关闭；若表单有未保存修改就会无声丢弃。
   * cancel() 有二次确认，两条路径必须一致，所以需要「相对装载基线是否改过」的判定。
   * create 模式没有基线：新建页面上填的任何内容都算未保存。
   */
  const [baseline, setBaseline] = createSignal<EditorFormValues | undefined>(undefined)

  /**
   * 自致写操作窗口（第十二轮 G-12-3）。
   * 服务端每次写操作都是「先 emit changed 再返回 RPC 结果」，
   * 窗口必须在发起 RPC 之前打开、在响应（含失败）之后关闭，
   * 否则先到达的 changed 会被当成外部修改，弹出语义误导的「磁盘已更新」。
   */
  const withSelfWrite = async <T,>(run: () => Promise<T>): Promise<T> => {
    props.onSelfWriteChange?.(true)
    try {
      return await run()
    } finally {
      props.onSelfWriteChange?.(false)
    }
  }

  // 编辑页被卸载时兜底复位自致窗口：否则列表页会永久忽略 changed，外部修改再也刷不出来
  onCleanup(() => props.onSelfWriteChange?.(false))

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
        // 缺陷 B：V1 的 variant 是独立字段，必须并进 modelRef，否则保存时 patch 会丢掉 #variant
        // 第十二轮 G-12-8：非法 model / color 视为未设置（UI 显示继承默认），
        // 首次保存时 patch 不带这两个键，服务端随之把它们从文件里删除。
        const parts = sanitizeLoadedModelRef(meta, res.format)
        const nextColor = sanitizeLoadedColor(meta.color)
        const nextHidden = meta.hidden === true
        const nextSteps = typeof meta.steps === "number" ? String(meta.steps) : ""
        const nextMatrix = matrixFromRules(
          Array.isArray(meta.permissions) ? (meta.permissions as never) : undefined,
          res.format === "v1" && meta.permission && typeof meta.permission === "object"
            ? (meta.permission as Record<string, unknown>)
            : undefined,
        )
        setModel(parts.model)
        setVariant(parts.variant)
        setColor(nextColor)
        setHidden(nextHidden)
        setStepsText(nextSteps)
        setMatrix(nextMatrix)
        setBaseline({
          description: typeof meta.description === "string" ? meta.description : "",
          body: res.body,
          model: parts.model,
          variant: parts.variant,
          color: nextColor,
          hidden: nextHidden,
          stepsText: nextSteps,
          matrix: nextMatrix,
        })
      } catch (e) {
        setLoadError(errorDescription(ctx.t, e))
      } finally {
        setLoading(false)
      }
    })()
  })

  /** 当前表单值（与 baseline 同形状），用于 dirty 判定。 */
  const formValues = (): EditorFormValues => ({
    description: description(),
    body: body(),
    model: model(),
    variant: variant(),
    color: color(),
    hidden: hidden(),
    stepsText: stepsText(),
    matrix: matrix(),
  })

  /** 是否有未保存修改。create 模式恒为 true（用户输入的任何内容都没落盘）。 */
  const dirty = (): boolean => {
    if (props.target.mode === "create") return true
    const base = baseline()
    if (!base) return false
    return !formValuesEqual(formValues(), base)
  }

  const id = () => (props.target.mode === "create" ? draftId() : props.target.id ?? "")
  const validation = createMemo(() =>
    validateEditor({
      mode: props.target.mode,
      id: id(),
      description: description(),
      stepsText: stepsText(),
      existingIds: props.existingIds(),
      // 加载失败时禁止保存：否则 expectedHash 是 undefined，只会得到 schema 错误（第六轮 M8）
      loading: loading() || loadError() !== undefined,
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
    // V1 文件先弹迁移预览；确认后由预览弹窗的回调继续走 runSave（不在这里 await 预览结果）
    if (saveStep({ mode: props.target.mode, format: format(), migrateConfirmed: migrateConfirmed() }) === "preview") {
      if (previewOpen()) return
      await openMigrationPreview()
      return
    }
    await runSave()
  }

  // 真正的写入。预览确认后由弹窗回调再次调用，所以 saving 状态与 toast 都在这里管理。
  const runSave = async () => {
    if (saving()) return
    setSaving(true)
    try {
      // G-12-3：自致窗口只包住写 RPC（见 saveUpdate 内部的 withSelfWrite）。
      // 冲突弹窗等用户交互期间不置位——那段时间的外部修改仍应照常提示。
      if (props.target.mode === "create") {
        // P2-T7：作用域继承列表当前选择；可选字段按需带（createInputOf 已单测）
        await withSelfWrite(() =>
          ctx.client.rpc(Subagents).create(
            createInputOf({ scope: props.target.scope, id: id(), patch: currentPatch() }),
          ),
        )
        ctx.toast.show({ title: ctx.t("toast.created"), variant: "success" })
        props.onSaved()
        return
      }
      const outcome = await saveUpdate()
      if (outcome === "reloaded") return
      ctx.toast.show({ title: ctx.t("toast.saved"), variant: "success" })
      props.onSaved()
    } catch (e) {
      ctx.toast.show({
        title: ctx.t("common.error"),
        description: errorDescription(ctx.t, e),
        variant: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  // V1 迁移预览（goal.md §9.1）。
  // 关键：这里**不 await** 预览结果。宿主 Ui.Dialog 的 closable={false} 只隐藏关闭按钮，
  // Esc 与点外点击仍会关闭且不触发任何回调；若保存流程挂在弹窗回调 resolve 的 Promise 上，
  // 用户按 Esc 后 save() 的 finally 永不执行，保存按钮会永久 busy。
  // 因此拆成「弹预览」→「用户点确认才继续保存」两步。
  const openMigrationPreview = async () => {
    const pathArg = props.target.path!
    // G-12-1：in-flight 置位必须在 await 之前（同步执行到第一个 await 前），
    // 否则 RPC 返回前的第二次点击会再发一次 migratePreview 并叠加第二个预览弹窗。
    setPreviewOpen(true)
    try {
      const preview = (await ctx.client.rpc(Subagents).migratePreview({ path: pathArg })) as unknown as {
        before: string
        after: string
        changes: MigrateChange[]
      }
      ctx.dialogs.open((dialog) => (
        <MigrationDialog
          ctx={ctx}
          before={preview.before}
          after={preview.after}
          changes={preview.changes}
          onConfirm={() => {
            setPreviewOpen(false)
            dialog.close()
            setMigrateConfirmed(true)
            void runSave()
          }}
          onCancel={() => { setPreviewOpen(false); dialog.close() }}
          onClosed={() => setPreviewOpen(false)}
        />
      ))
    } catch (e) {
      // RPC 失败：复位，否则保存按钮会被永久挡住
      setPreviewOpen(false)
      ctx.toast.show({
        title: ctx.t("common.error"),
        description: errorDescription(ctx.t, e),
        variant: "error",
      })
    }
  }

  const saveUpdate = async (): Promise<"saved" | "reloaded"> => {
    const pathArg = props.target.path!
    try {
      // G-12-3：自致窗口只覆盖写 RPC 本身
      await withSelfWrite(() =>
        ctx.client.rpc(Subagents).update({ path: pathArg, expectedHash: hash()!, patch: currentPatch() }),
      )
      return "saved"
    } catch (e) {
      if (!isConflictError(e)) throw e
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
      if (conflictAction(choice) === "overwrite") {
        await withSelfWrite(() =>
          ctx.client.rpc(Subagents).update({ path: pathArg, expectedHash: hash()!, patch: currentPatch(), force: true }),
        )
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

  /**
   * 重命名成功后是否可以直接离开编辑页（第十二轮 G-12-9）。
   *
   * 旧实现无条件 onSaved()，表单里未保存的修改被无声丢弃；
   * 而 cancel() 是有二次确认的，两条离开路径行为不一致。
   * 这里复用 cancel 的同一套文案（不新增 i18n 键）：dirty 时先确认，拒绝则留在编辑页。
   */
  const closeAfterRename = async () => {
    if (dirty()) {
      const ok = await ctx.dialogs.confirm({
        title: ctx.t("editor.unsaved.title"),
        description: ctx.t("editor.unsaved.desc"),
      })
      if (!ok) return
    }
    props.onSaved()
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
              {ctx.t("editor.scopeValue", {
                scope:
                  props.target.scope.kind === "user"
                    ? ctx.t("list.scope.user")
                    : ctx.t("list.scope.project", { project: props.target.scope.projectName }),
              })}
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
                {/* goal.md §6.1：改 ID 会让引用失效，所以走带警告的二次确认 */}
                <ctx.ui.Button
                  variant="ghost"
                  size="small"
                  icon="edit"
                  onClick={() => {
                    void (async () => {
                      // 先弹「ID 会改变、引用会失效」的警告，再让用户输入新 ID
                      const result = await renameAgentWithPrompt(
                        {
                          confirm: (input) => ctx.dialogs.confirm(input),
                          prompt: (input) => ctx.dialogs.prompt(input),
                          // G-12-3：自致窗口只包住写 RPC，确认 / 输入弹窗期间的外部修改仍要提示
                          rename: (input) =>
                            withSelfWrite(() =>
                              ctx.client.rpc(Subagents).rename(input) as unknown as Promise<{ path: string }>,
                            ),
                          toast: (input) => ctx.toast.show(input),
                          t: ctx.t,
                        },
                        { id: id(), path: props.target.path! },
                      )
                      // G-12-9：重命名成功但表单有未保存修改时，先走与 cancel 相同的确认流程
                      if (result === "renamed") await closeAfterRename()
                    })().catch((err) => {
                      ctx.toast.show({
                        title: ctx.t("common.error"),
                        description: errorDescription(ctx.t, err),
                        variant: "error",
                      })
                    })
                  }}
                >
                  {ctx.t("common.rename")}
                </ctx.ui.Button>
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
  // 拉取失败要显示错误态，不能静默吞成「无深度」（第十一轮 GUI-4）
  const [loadError, setLoadError] = createSignal<string | undefined>(undefined)
  onMount(() => {
    void (async () => {
      try {
        const res = (await ctx.client.rpc(Subagents).models({})) as unknown as ModelsOutput
        setProviders(res.providers)
      } catch (e) {
        setLoadError(errorDescription(ctx.t, e) || String((e as { message?: string })?.message ?? e))
      }
    })()
  })
  const variants = createMemo(() => variantsOf(providers(), props.model))
  return (
    <Show when={loadError()} fallback={
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
    }>
      <span style={{ color: "#ef4444", "font-size": "12px" }}>{loadError()}</span>
    </Show>
  )
}
