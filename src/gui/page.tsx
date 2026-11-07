// src/gui/page.tsx —— 列表页。ZCode 视觉参考要点：组标题承载归属；行内徽标小圆角。
import { createSignal, createResource, createMemo, Show, Switch, Match, For } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Subagents } from "../rpc"
import type { AgentSummary, BuiltinSummary, ListOutput } from "../rpc"
import { listViewState, errorMessage } from "./list-state"

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
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", padding: "12px", height: "100%" }}>
      <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
        <ctx.ui.Menu label={scopeLabel()} items={scopeMenuItems()} trigger="button" placement="bottom-start" />
        <span style={{ opacity: 0.7 }}>{ctx.t("list.count", { count: filtered().length })}</span>
        <div style={{ flex: 1 }} />
        <ctx.ui.TextInput label={ctx.t("list.search")} value={query()} onInput={setQuery} />
        <ctx.ui.IconButton icon="refresh" label={ctx.t("list.refresh")} onClick={() => void refetch()} />
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
          <For each={filtered()}>{(agent) => <AgentRow agent={agent} />}</For>
        </Match>
      </Switch>

      <Show when={view().kind !== "error" && view().kind !== "loading"}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <div style={{ "font-weight": 600, opacity: 0.8 }}>{ctx.t("list.builtin")}</div>
          <For each={data()?.builtins ?? []}>{(b) => <BuiltinRow builtin={b} />}</For>
        </div>
      </Show>
    </div>
  )
}

function AgentRow(props: { agent: AgentSummary }) {
  const ctx = usePlugin()
  return (
    <div style={{ display: "flex", gap: "8px", "align-items": "center", padding: "8px", "border-radius": "8px" }}>
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
