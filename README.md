# opencode-subagent-manager

Manage OpenCode V2 subagents from the desktop app: a settings page to view, create, edit, disable, rename and trash subagent markdown files, with live sync from disk.

在 OpenCode Desktop 的设置里管理 V2 子智能体：查看、新建、编辑、停用、重命名、回收站删除，并与磁盘 Markdown 文件实时同步。

> Status: experimental. Built against OpenCode Desktop 2.2.5 and its experimental plugin API.
>
> 状态：实验性。基于 OpenCode Desktop 2.2.5 及其 experimental 插件 API 构建。

---

## Features / 功能

| | English | 中文 |
|---|---|---|
| **List** | User-level and project-level scopes, natural sort, search, hidden badge, disabled badge | 用户级与项目级作用域、自然排序、搜索、「隐藏」与「已停用」徽标 |
| **Create** | Live ID validation, reserved-ID guard, no-clobber | 实时校验、保留 ID 拦截、存在即拒绝 |
| **Edit** | Name, colour, model with reasoning effort, description, three-state permission matrix (allow / ask / deny), system prompt, max steps, hidden | 名称、颜色、模型与思考深度、描述、三态权限矩阵、系统提示词、最大步数、隐藏 |
| **Rename** | Warning first, then the new ID; refuses an existing target | 先警告再输入新 ID；目标已存在则拒绝 |
| **V1 → V2 migration** | Whole-file conversion per the official rules, previewed before saving; comments and unknown fields preserved | 按官方规则整份转换，保存前预览；注释与未知字段保留 |
| **Trash** | Deletes move to `agents-trash/` beside the agents directory, restorable by hand | 删除移入 agents 目录旁的 `agents-trash/`，可手动恢复 |
| **Built-in overrides** | Switch `general` / `explore` models at runtime through plugin storage; nothing is written to `opencode.jsonc` | 内置代理换模型走插件存储，不写配置文件 |
| **Live sync** | `fs.watch` + 300 ms debounce + `agent.reload()`; the list refreshes when another process writes a file | 外部进程写文件后列表自动刷新 |
| **i18n** | English and Simplified Chinese | 英文与简体中文 |

<!-- TODO: add screenshots of the list page and the editor page -->

## Compatibility / 兼容性

- **OpenCode Desktop 2.2.5** — the version this plugin was built and verified against. The plugin API is marked experimental upstream, so a newer desktop release may change it and break this plugin. Pin the desktop version if that matters to you.
- **以 OpenCode Desktop 2.2.5 为准** —— 本插件在该版本上开发与验证。上游的插件 API 标注为 experimental，桌面端升级后可能变化并导致本插件失效；如需稳定，请固定桌面端版本。
- The server half needs a Node-compatible runtime (the desktop ships one). The GUI half is a single CommonJS bundle loaded by the desktop renderer.
- 服务端部分需要 Node 兼容运行时（桌面端自带）；GUI 部分是桌面渲染进程加载的单文件 CommonJS bundle。

## Install / 安装

1. Clone into the plugins directory / 克隆到插件目录：

```bash
git clone <this-repo> ~/.config/opencode/plugins/opencode-subagent-manager
cd ~/.config/opencode/plugins/opencode-subagent-manager
npm install
npm run build
```

2. Add the **directory** to `opencode.jsonc`. The desktop reads `opencode.jsonc`, not `cli.json`, and the entry must point at the folder (not a file inside it):

```jsonc
{
  "plugins": [
    "<your home>/.config/opencode/plugins/opencode-subagent-manager"
  ]
}
```

Use your platform's path separator and escape backslashes in JSON, for example on Windows: `"C:\\Users\\<you>\\.config\\opencode\\plugins\\opencode-subagent-manager"`.

在 Windows 上注意 JSON 需要转义反斜杠，例如 `"C:\\Users\\<you>\\.config\\opencode\\plugins\\opencode-subagent-manager"`。

3. Restart the desktop app fully (quit from the tray, then relaunch — a window reload is not enough because the server half only loads at process start). Open **Settings → Agent capability → Subagents**.

重启桌面端（从托盘完全退出后重新启动，仅刷新窗口不够，服务端部分只在进程启动时加载）。打开 **设置 → Agent 能力 → 子智能体**。

## Development / 开发

```bash
npm install     # install dependencies
npm test        # unit tests (node --test with type stripping)
npm run build   # single-file CJS bundle at dist/gui-experimental.cjs
npm run watch   # rebuild the GUI on change; server changes need an app restart
```

The build must produce exactly one file in `dist/`. Modules the desktop provides (`solid-js`, `@opencode/plugin/gui`, `@opencode/plugin/rpc`) stay external; the build fails if anything else from those families is bundled.

构建产物在 `dist/` 内必须只有一个文件。桌面端提供的模块保持 external；若误打包同族模块，构建会失败。

## Restore from trash / 从回收站恢复

Deleted agents move to the trash folder beside the agents directory:

- User level / 用户级：`~/.config/opencode/agents-trash/`
- Project level / 项目级：`<project>/.opencode/agents-trash/`

Files are named `<yyyyMMdd-HHmmss>-<original-name>.md`. Move the file back into `agents/` to restore it (the timestamp prefix can be dropped). There is no restore UI in this version.

文件名形如 `<yyyyMMdd-HHmmss>-<原名>.md`。把它移回 `agents/` 即可恢复（可去掉时间戳前缀）。本版本没有恢复界面。

## Data and privacy / 数据与隐私

The plugin reads and writes only:

- the markdown files under the agents directories above;
- one key per built-in override in the plugin's own storage (`builtin-model.general`, `builtin-model.explore`).

It makes no network requests and collects no telemetry.

插件只读写上述 agents 目录里的 Markdown 文件，以及插件存储中每个内置覆盖一个键；不发起网络请求，不收集遥测数据。

## License / 许可

MIT. See [LICENSE](LICENSE).

## Acknowledgements / 致谢

- [opencode-agent-models](https://github.com/) for the shape of a model-picker plugin and the pattern of storing overrides outside the config file.
- [ZCode](https://github.com/zai-org/ZCode) for the settings page layout this UI follows (scope menu, count, row badges, built-in group).
- The OpenCode team for the plugin SDK and its documentation.

- 参考 [opencode-agent-models](https://github.com/) 的模型选择插件形态与「覆盖值存在插件侧」的做法。
- 参考 [ZCode](https://github.com/zai-org/ZCode) 的设置页布局（作用域菜单、计数、行内徽标、内置分组）。
- 感谢 OpenCode 团队提供插件 SDK 与文档。
