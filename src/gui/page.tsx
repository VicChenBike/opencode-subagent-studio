// src/gui/page.tsx —— 列表页。视觉参考宿主设置页的排版要点：组标题承载归属；行内徽标小圆角。
import { createSignal, createResource, createMemo, onCleanup, Show, Switch, Match, For } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Subagents } from "../rpc"
import type { AgentSummary, BuiltinSummary, ListOutput } from "../rpc"
import { listViewState, errorMessage, changedAction, agentRowState } from "./list-state"
import { errorDescription } from "./error-copy"
import { EditorPage, type EditorTarget } from "./editor"
import { trashAgent } from "./trash-flow"
import { toggleDisabled, switchEventToDisabled } from "./disable-flow"
import { beginInFlight, endInFlight, isInFlight, onInFlightChange } from "./inflight"
import { MigrationDialog } from "./migration-dialog"
import { openModelPicker } from "./model-picker"
import type { MigrateChange, ReadOutput } from "../rpc"

type Scope =
  | { kind: "user" }
  | { kind: "project"; projectPath: string; projectName: string }

/** resource 的结果自带来源键，用于判断当前展示的数据是否属于当前作用域（G-12-4）。 */
interface ListResult {
  scopeKey: string
  output: ListOutput
}

interface ProjectLike {
  id: string
  canonical: string
  name?: string
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function Page(_props: { target?: string }) {
  const ctx = usePlugin()
  const [scope, setScope] = createSignal<Scope>({ kind: "user" })
  const [query, setQuery] = createSignal("")
  const [editorTarget, setEditorTarget] = createSignal<EditorTarget | null>(null)
  const openEditor = (agent: AgentSummary) =>
    setEditorTarget({ mode: "edit", path: agent.path, id: agent.id, scope: scope() })
  const openCreate = () =>
    setEditorTarget({ mode: "create", scope: scope(), draftId: "" })

  // 本机项目列表：ctx.servers.list() → 第一个（本机 sidecar）→ data.project.list()（响应式同步）
  const projects = createMemo<ProjectLike[]>(() => {
    const id = ctx.servers.list()[0]
    const server = id ? ctx.servers.get(id) : undefined
    if (!server) return []
    return (server.data.project.list() as unknown as ProjectLike[]) ?? []
  })

  // source 传 scope 信号：切换作用域时自动重新拉取（goal.md §16-3 要求切项目能看到该项目内容）
  // 结果里带上来源键：切作用域时旧行不能继续显示，而并发请求的返回顺序无法保证，
  // 只有让「数据自己记住来源」才能无竞态地判断当前展示的是不是本作用域的内容。
  const scopeKeyOf = (s: Scope) => (s.kind === "user" ? "user" : `project:${s.projectPath}`)
  const [data, { refetch }] = createResource<ListResult, Scope>(scope, async (s) => {
    const res =
      s.kind === "user"
        ? await ctx.client.rpc(Subagents).list({ scope: "user" })
        : await ctx.client.rpc(Subagents).list({ scope: "project", projectPath: s.projectPath })
    return { scopeKey: scopeKeyOf(s), output: res as unknown as ListOutput }
  })

  /**
   * 已加载到的列表数据（第十二轮 G-12-4）。
   *
   * 直接调 `data()` 在 errored 状态会抛错（Solid 的 resource read 语义），
   * 所以这里按 state 守卫：只有确实拿到过结果时才返回内容。
   * refetch 期间 value 仍是上一次成功结果，正是我们要继续显示的行；
   * 但切换作用域后旧数据不属于当前来源，必须视为「尚未加载」。
   */
  const listData = createMemo<ListOutput | undefined>(() => {
    if (data.state === "unresolved" || data.state === "errored") return undefined
    try {
      const value = data() as ListResult | undefined
      if (!value || value.scopeKey !== scopeKeyOf(scope())) return undefined
      return value.output
    } catch {
      return undefined
    }
  })

  const filtered = createMemo<AgentSummary[]>(() => {
    const q = query().trim().toLowerCase()
    const agents = listData()?.agents ?? []
    if (!q) return agents
    return agents.filter(
      (a) => a.id.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
    )
  })

  // 编辑页自致写操作窗口（第十二轮 G-12-3）：服务端先 emit changed 再返回 RPC 结果，
  // 编辑页自己的保存 / 重命名会先收到一条 changed；把它当成「磁盘被别人改了」是语义误导。
  // 编辑页在发起写 RPC 前置位、响应后复位，期间到达的 changed 直接忽略。
  const [editorSelfWrite, setEditorSelfWrite] = createSignal(false)

  // 视图状态：首次加载显示 Loader；已有数据时刷新保持现有内容，不闪 Loader、不显示旧错误。
  // goal.md §12.1：changed → 列表重拉；编辑页打开时不覆盖表单，只提示磁盘已更新
  onCleanup(
    ctx.client.rpc(Subagents).events.on("changed", () => {
      const action = changedAction({
        editorOpen: editorTarget() !== null,
        formDirty: true,
        selfWrite: editorSelfWrite(),
      })
      if (action === "ignore") return
      if (action === "notify") {
        ctx.toast.show({ title: ctx.t("list.diskUpdated") })
        return
      }
      void refetch()
    }),
  )

  const view = createMemo(() =>
    listViewState({
      loading: data.loading,
      error: data.error,
      agents: filtered(),
      query: query(),
      hasData: listData() !== undefined,
    }),
  )

  // 已知错误码优先用 i18n 文案，其余回退到原始 message（P3-T8）
  const errorText = () => errorDescription(ctx.t, data.error) || errorMessage(data.error)

  const scopeLabel = () => {
    const s = scope()
    return s.kind === "user" ? ctx.t("list.scope.user") : ctx.t("list.scope.project", { project: s.projectName })
  }

  const scopeMenuItems = () => [
    {
      label: ctx.t("list.scope.user"),
      onSelect: () => setScope({ kind: "user" }),
    },
    { type: "separator" as const },
    {
      type: "group" as const,
      label: ctx.t("list.scope"),
      items: projects().map((p) => ({
        label: p.name || basename(p.canonical),
        onSelect: () => setScope({ kind: "project", projectPath: p.canonical, projectName: p.name || basename(p.canonical) }),
      })),
    },
  ]

  return (
    <Show
      when={!editorTarget()}
      fallback={
        <EditorPage
          target={editorTarget()!}
          existingIds={() => (listData()?.agents ?? []).map((a) => a.id)}
          onSelfWriteChange={setEditorSelfWrite}
          onBack={() => setEditorTarget(null)}
          onSaved={() => { setEditorTarget(null); void refetch() }}
          onDelete={() => {
            const target = editorTarget()
            if (!target?.path || !target.id) return
            void (async () => {
              const result = await trashAgent(
                {
                  confirm: (input) => ctx.dialogs.confirm(input),
                  // G-12-3：删除同样是编辑页自致的写操作，服务端会先 emit changed。
                  // 只包住 remove RPC（确认弹窗期间的外部修改仍要提示）。
                  remove: (input) => {
                    setEditorSelfWrite(true)
                    return (ctx.client.rpc(Subagents).remove(input) as unknown as Promise<{ trashPath: string }>)
                      .finally(() => setEditorSelfWrite(false))
                  },
                  toast: (input) => ctx.toast.show(input),
                  t: ctx.t,
                },
                { id: target.id!, path: target.path! },
              )
              if (result === "deleted") {
                setEditorTarget(null)
                void refetch()
              }
            })().catch((err) => {
              // flow 内部只兜 RPC 失败；confirm / dialogs 抛错也要落到可见提示
              ctx.toast.show({
                title: ctx.t("common.error"),
                description: errorDescription(ctx.t, err),
                variant: "error",
              })
            })
          }}
        />
      }
    >
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", padding: "12px", height: "100%" }}>
      <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
        <ctx.ui.Menu label={scopeLabel()} items={scopeMenuItems()} trigger="button" placement="bottom-start" />
        <span style={{ opacity: 0.7 }}>{ctx.t("list.count", { count: filtered().length })}</span>
        <div style={{ flex: 1 }} />
        <ctx.ui.TextInput label={ctx.t("list.search")} value={query()} onInput={setQuery} />
        <ctx.ui.IconButton icon="refresh" label={ctx.t("list.refresh")} onClick={() => void refetch()} />
        <ctx.ui.Button variant="contrast" size="small" icon="plus" onClick={openCreate}>
          {ctx.t("list.create")}
        </ctx.ui.Button>
      </div>

      <Switch fallback={<ctx.ui.Loader />}>
        <Match when={view().kind === "error"}>
          {/* 错误态：显示宿主返回的错误信息 + 重试，避免 500 时整页空白 */}
          <div style={{ border: "1px solid", "border-radius": "8px", padding: "24px", display: "flex", "flex-direction": "column", gap: "12px", "align-items": "center", "text-align": "center" }}>
            <div style={{ "font-weight": 600 }}>{ctx.t("list.error.title")}</div>
            <Show when={errorText()}>
              <div style={{ "font-size": "12px", opacity: 0.7, "word-break": "break-word", "max-width": "100%" }}>
                {errorText()}
              </div>
            </Show>
            <ctx.ui.Button variant="neutral" icon="refresh" onClick={() => void refetch()}>
              {ctx.t("list.error.retry")}
            </ctx.ui.Button>
          </div>
        </Match>

        <Match when={view().kind === "loading"}>
          <ctx.ui.Loader />
        </Match>

        <Match when={view().kind === "empty"}>
          <div style={{ border: "1px dashed", "border-radius": "8px", padding: "24px", opacity: 0.6, "text-align": "center" }}>
            {ctx.t("list.empty")}
          </div>
        </Match>

        <Match when={view().kind === "emptySearch"}>
          <div style={{ border: "1px dashed", "border-radius": "8px", padding: "24px", opacity: 0.6, "text-align": "center" }}>
            {ctx.t("list.emptySearch", { query: query().trim() })}
          </div>
        </Match>

        <Match when={view().kind === "rows"}>
          <For each={filtered()}>{(agent) => <AgentRow agent={agent} onOpen={() => openEditor(agent)} onDeleted={() => void refetch()} onChanged={() => void refetch()} />}</For>
        </Match>
      </Switch>

      <Show when={view().kind !== "error" && view().kind !== "loading"}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <div style={{ "font-weight": 600, opacity: 0.8 }}>{ctx.t("list.builtin")}</div>
          <For each={listData()?.builtins ?? []}>{(b) => <BuiltinRow builtin={b} onChanged={() => void refetch()} />}</For>
        </div>
      </Show>
    </div>
    </Show>
  )
}

function AgentRow(props: { agent: AgentSummary; onOpen?: () => void; onDeleted?: () => void; onChanged?: () => void }) {
  const ctx = usePlugin()
  // 徽标 / 开关 / 变灰三处统一从一处派生，避免各自判定走偏（goal.md §10）
  const rowState = () => agentRowState(props.agent)
  // 开关流程进行中拒绝连点（第十一轮 GUI-3：并发 toggle 会让第二个 update 撞 conflict）。
  // 第十二轮 G-12-6：守卫改按 path 记在模块级——列表用 <For> 按引用 keyed，
  // refetch 会重挂载行组件，组件实例信号会归零；V1 迁移流程中途再点开关就会并发第二个 setDisabled。
  // 模块级登记本身不是响应式源，用本地 tick 跟随 onInFlightChange 重算。
  const [tick, setTick] = createSignal(0)
  onCleanup(
    onInFlightChange(() => {
      setTick((n) => n + 1)
    }),
  )
  const busy = () => {
    tick()
    return isInFlight(props.agent.path)
  }
  return (
    <div
      onClick={() => props.onOpen?.()}
      style={{
        display: "flex", gap: "8px", "align-items": "center", padding: "8px", "border-radius": "8px",
        cursor: props.onOpen ? "pointer" : "default",
        opacity: rowState().dimmed ? 0.5 : 1,
      }}
    >
      <span style={{
        width: "10px", height: "10px", "border-radius": "50%",
        background: props.agent.color ?? "var(--oc-text-muted, #888)",
        display: "inline-block", flex: "none",
      }} />
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: 1, "min-width": 0 }}>
        <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
          <span style={{ "font-weight": 500 }}>{props.agent.id}</span>
          <Show when={props.agent.model}>
            <span style={{ "font-size": "12px", padding: "1px 6px", border: "1px solid", "border-radius": "6px", opacity: 0.8 }}>
              {props.agent.model}
            </span>
          </Show>
          <Show when={props.agent.hidden}>
            <span style={{ "font-size": "12px", padding: "1px 6px", border: "1px solid", "border-radius": "6px", opacity: 0.7 }}>
              {ctx.t("list.hidden")}
            </span>
          </Show>
          <Show when={rowState().showDisabledBadge}>
            <span style={{ "font-size": "12px", padding: "1px 6px", border: "1px solid", "border-radius": "6px", opacity: 0.5 }}>
              {ctx.t("list.disabled")}
            </span>
          </Show>
        </div>
        <span style={{ "font-size": "12px", opacity: 0.7, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
          {props.agent.description}
        </span>
      </div>
      {/* goal.md §10：开关写 disabled true/false；V1 先走迁移预览。
          开关是「启用」语义（checked = 启用，蓝色 = 开），写盘前用
          switchEventToDisabled 逆映射回数据层的 disabled。
          P3-a：Ui.Switch 的 onChange 只给 boolean、拿不到事件，所以用容器拦住冒泡，
          否则点开关会同时触发行 onClick 跳进编辑页。 */}
      <span onClick={(event) => event.stopPropagation()}>
      <ctx.ui.Switch
        label={ctx.t("list.enabled")}
        hideLabel
        checked={rowState().switchChecked}
        // 流程进行中开关不可再翻转（与 onChange 里的 beginInFlight 守卫双保险）
        disabled={busy()}
        onChange={(checked) => {
          if (!beginInFlight(props.agent.path)) return
          void (async () => {
            try {
              const result = await toggleDisabled(
              {
                migratePreview: (input) => ctx.client.rpc(Subagents).migratePreview(input) as unknown as Promise<{ before: string; after: string; changes: MigrateChange[] }>,
                confirmMigration: (preview) =>
                  new Promise<boolean>((resolve) => {
                    ctx.dialogs.open((dialog) => (
                      <MigrationDialog
                        ctx={ctx}
                        before={preview.before}
                        after={preview.after}
                        changes={preview.changes}
                        onConfirm={() => { resolve(true); dialog.close() }}
                        onCancel={() => { resolve(false); dialog.close() }}
                        // Esc / 点外 / owner 卸载没有按钮回调：cleanup 兜底 resolve(false)，
                        // 否则 Promise 永久悬挂、流程无声死掉（第十一轮 GUI-1，坑 13 的漏网路径）
                        onClosed={() => resolve(false)}
                      />
                    ))
                  }),
                read: (input) => ctx.client.rpc(Subagents).read(input) as unknown as Promise<ReadOutput>,
                update: (input) => ctx.client.rpc(Subagents).update(input) as unknown as Promise<{ hash: string }>,
                setDisabled: (input) => ctx.client.rpc(Subagents).setDisabled(input) as unknown as Promise<{ hash: string }>,
                toast: (input) => ctx.toast.show(input),
                t: ctx.t,
              },
                props.agent,
                switchEventToDisabled(checked),
              )
              // 失败（如 conflict）也重拉：行 hash 可能已过期，刷新后用户才能再次切换（第十一轮 F9）
              if (result !== "cancelled") props.onChanged?.()
            } finally {
              // 守卫按 path 记在模块级，流程结束（成功 / 失败 / 取消）一律释放
              endInFlight(props.agent.path)
            }
          })().catch((err) => {
            ctx.toast.show({
              title: ctx.t("common.error"),
              description: errorDescription(ctx.t, err),
              variant: "error",
            })
          })
        }}
      />
      </span>
      {/* goal.md §10：删除 = 移入同级回收站，二次确认 */}
      <ctx.ui.IconButton
        icon="trash"
        label={ctx.t("common.delete")}
        variant="ghost-muted"
        onClick={(event) => {
          event.stopPropagation()
          void (async () => {
            const result = await trashAgent(
              {
                confirm: (input) => ctx.dialogs.confirm(input),
                remove: (input) => ctx.client.rpc(Subagents).remove(input) as unknown as Promise<{ trashPath: string }>,
                toast: (input) => ctx.toast.show(input),
                t: ctx.t,
              },
              props.agent,
            )
            if (result === "deleted") props.onDeleted?.()
          })().catch((err) => {
            ctx.toast.show({
              title: ctx.t("common.error"),
              description: errorDescription(ctx.t, err),
              variant: "error",
            })
          })
        }}
      />
    </div>
  )
}

function BuiltinRow(props: { builtin: BuiltinSummary; onChanged?: () => void }) {
  const ctx = usePlugin()
  const toolLabel = () =>
    props.builtin.id === "general" ? ctx.t("list.builtin.general.tools") : ctx.t("list.builtin.explore.tools")
  // goal.md §5.4 / §11：内置代理只有模型控件，没有编辑、开关、垃圾桶
  const pickModel = () => {
    const current = props.builtin.model
    const hashIndex = current?.indexOf("#") ?? -1
    openModelPicker(ctx, {
      current: hashIndex >= 0 ? current!.slice(0, hashIndex) : current,
      variant: hashIndex >= 0 ? current!.slice(hashIndex + 1) : undefined,
      onPick: (model, variant) => {
        void (async () => {
          try {
            // P3-e：继承默认时不发送 model 键（避免传输层对显式 undefined 的校验差异）
            const nextModel = model === undefined ? undefined : variant ? `${model}#${variant}` : model
            await ctx.client.rpc(Subagents).setBuiltinModel({
              id: props.builtin.id,
              ...(nextModel === undefined ? {} : { model: nextModel }),
            })
            ctx.toast.show({ title: ctx.t("toast.saved"), variant: "success" })
            props.onChanged?.()
          } catch (err) {
            ctx.toast.show({
              title: ctx.t("common.error"),
              description: errorDescription(ctx.t, err),
              variant: "error",
            })
          }
        })()
      },
    })
  }
  return (
    <div style={{ display: "flex", gap: "8px", "align-items": "center", padding: "8px", "border-radius": "8px" }}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: 1 }}>
        <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
          <span style={{ "font-weight": 500 }}>{props.builtin.id}</span>
          <ctx.ui.Button variant="ghost" size="small" onClick={pickModel}>
            {props.builtin.model ?? ctx.t("list.inherit")}
          </ctx.ui.Button>
          <span style={{ "font-size": "12px", padding: "1px 6px", border: "1px solid", "border-radius": "6px", opacity: 0.7 }}>
            {toolLabel()}
          </span>
        </div>
      </div>
    </div>
  )
}
