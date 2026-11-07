// src/gui/page.tsx —— 列表页。ZCode 视觉参考要点：组标题承载归属；行内徽标小圆角。
import { createSignal, createResource, createMemo, onCleanup, Show, Switch, Match, For } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Subagents } from "../rpc"
import type { AgentSummary, BuiltinSummary, ListOutput } from "../rpc"
import { listViewState, errorMessage, changedAction } from "./list-state"
import { EditorPage, type EditorTarget } from "./editor"
import { trashAgent } from "./trash-flow"
import { toggleDisabled } from "./disable-flow"
import { MigrationDialog } from "./migration-dialog"
import type { MigrateChange, ReadOutput } from "../rpc"

type Scope =
  | { kind: "user" }
  | { kind: "project"; projectPath: string; projectName: string }

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
  const [data, { refetch }] = createResource<ListOutput, Scope>(scope, async (s) => {
    const res =
      s.kind === "user"
        ? await ctx.client.rpc(Subagents).list({ scope: "user" })
        : await ctx.client.rpc(Subagents).list({ scope: "project", projectPath: s.projectPath })
    return res as unknown as ListOutput
  })

  const filtered = createMemo<AgentSummary[]>(() => {
    const q = query().trim().toLowerCase()
    const agents = data()?.agents ?? []
    if (!q) return agents
    return agents.filter(
      (a) => a.id.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
    )
  })

  // 视图状态：错误优先（避免 500 时整页空白），其次 loading / 空态 / 搜索空态 / 行列表
  // goal.md §12.1：changed → 列表重拉；编辑页打开时不覆盖表单，只提示磁盘已更新
  onCleanup(
    ctx.client.rpc(Subagents).events.on("changed", () => {
      const action = changedAction({ editorOpen: editorTarget() !== null, formDirty: true })
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
    }),
  )

  const errorText = () => errorMessage(data.error)

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
          existingIds={() => (data()?.agents ?? []).map((a) => a.id)}
          onBack={() => setEditorTarget(null)}
          onSaved={() => { setEditorTarget(null); void refetch() }}
          onDelete={() => {
            const target = editorTarget()
            if (!target?.path || !target.id) return
            void (async () => {
              const result = await trashAgent(
                {
                  confirm: (input) => ctx.dialogs.confirm(input),
                  remove: (input) => ctx.client.rpc(Subagents).remove(input) as unknown as Promise<{ trashPath: string }>,
                  toast: (input) => ctx.toast.show(input),
                  t: ctx.t,
                },
                { id: target.id!, path: target.path! },
              )
              if (result === "deleted") {
                setEditorTarget(null)
                void refetch()
              }
            })()
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
          <For each={data()?.builtins ?? []}>{(b) => <BuiltinRow builtin={b} />}</For>
        </div>
      </Show>
    </div>
    </Show>
  )
}

function AgentRow(props: { agent: AgentSummary; onOpen?: () => void; onDeleted?: () => void; onChanged?: () => void }) {
  const ctx = usePlugin()
  return (
    <div
      onClick={() => props.onOpen?.()}
      style={{
        display: "flex", gap: "8px", "align-items": "center", padding: "8px", "border-radius": "8px",
        cursor: props.onOpen ? "pointer" : "default",
        opacity: props.agent.disabled ? 0.5 : 1,
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
          <Show when={props.agent.disabled}>
            <span style={{ "font-size": "12px", padding: "1px 6px", border: "1px solid", "border-radius": "6px", opacity: 0.5 }}>
              {ctx.t("list.disabled")}
            </span>
          </Show>
        </div>
        <span style={{ "font-size": "12px", opacity: 0.7, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
          {props.agent.description}
        </span>
      </div>
      {/* goal.md §10：开关写 disabled true/false；V1 先走迁移预览 */}
      <ctx.ui.Switch
        label={ctx.t("list.disabled")}
        hideLabel
        checked={props.agent.disabled}
        onChange={(checked) => {
          void (async () => {
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
              checked,
            )
            if (result === "toggled") props.onChanged?.()
          })()
        }}
      />
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
          })()
        }}
      />
    </div>
  )
}

function BuiltinRow(props: { builtin: BuiltinSummary }) {
  const ctx = usePlugin()
  const toolLabel = () =>
    props.builtin.id === "general" ? ctx.t("list.builtin.general.tools") : ctx.t("list.builtin.explore.tools")
  return (
    <div style={{ display: "flex", gap: "8px", "align-items": "center", padding: "8px", "border-radius": "8px" }}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px", flex: 1 }}>
        <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
          <span style={{ "font-weight": 500 }}>{props.builtin.id}</span>
          <span style={{ "font-size": "12px", padding: "1px 6px", border: "1px solid", "border-radius": "6px", opacity: 0.8 }}>
            {props.builtin.model ?? ctx.t("list.inherit")}
          </span>
          <span style={{ "font-size": "12px", padding: "1px 6px", border: "1px solid", "border-radius": "6px", opacity: 0.7 }}>
            {toolLabel()}
          </span>
        </div>
      </div>
    </div>
  )
}
