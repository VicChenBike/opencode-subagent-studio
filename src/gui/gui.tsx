// src/gui/gui.tsx —— GUI 入口（渲染进程）。
import { Plugin, SettingsPage } from "@opencode/plugin/gui"
import { catalog } from "./i18n"
import { Page } from "./page"

export default Plugin.define({
  i18n: catalog,
  setup(ctx) {
    ctx.add(SettingsPage, {
      id: "subagent-manager",
      icon: "brain",
      get title() {
        return ctx.t("page.title")
      },
      get entries() {
        return [{
          id: "subagent-manager",
          title: ctx.t("page.title"),
          description: ctx.t("page.entry.desc"),
          keywords: ctx.t("page.keywords"),
        }]
      },
      render: (input) => <Page target={input.target} />,
    })
  },
})
