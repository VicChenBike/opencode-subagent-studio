// src/gui/gui.tsx —— GUI 入口（渲染进程）。默认导出即 ./gui-experimental 的插件定义。
import { Plugin } from "@opencode/plugin/gui"
import { SettingsPage } from "@opencode/plugin/gui"
import { catalog } from "./i18n"

export default Plugin.define({
  i18n: catalog,
  setup(ctx) {
    ctx.add(SettingsPage, {
      id: "subagent-manager",
      icon: "brain", // 实测 IconName：sparkles/agent/bots 不存在（§0.2-1）
      get title() {
        return ctx.t("page.title")
      },
      get entries() {
        return [{ id: "subagent-manager", title: ctx.t("page.title") }]
      },
      render: (input) => {
        void input
        return <div>subagent-manager placeholder</div>
      },
    })
  },
})
