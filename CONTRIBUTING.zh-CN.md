# 为 opencode-subagent-studio 贡献

[English](CONTRIBUTING.md) | 简体中文

感谢你有兴趣参与贡献！本文档涵盖入门所需的全部内容。

## 开发环境

前置要求：**Node.js 24+**、**npm**，以及一份用于手动测试的 OpenCode Desktop 安装（2.2.5 或更新版本）。

```bash
npm install
npm test          # 单元测试（node --test，直接运行 TS）
npm run typecheck # tsc --noEmit 类型检查
npm run build     # 生成单文件 CJS GUI bundle：dist/gui-experimental.cjs
npm run watch     # 监听并重建 GUI
```

## 代码结构

- `src/index.ts` —— 服务端入口（`Plugin.define`）：RPC handler、fs.watch、内置模型覆盖。
- `src/core/*` —— 纯服务端逻辑，不 import 宿主 API；这里的全部代码都跑在 `node --test` 下。
- `src/gui/*` —— SolidJS 设置页。每个组件旁都有一个对应的 `*.ts` 纯逻辑模块，让逻辑保持可单测。
- `src/gui/i18n/*` —— 界面词典。`en.ts` 是强制兜底基准，也是唯一定义 `page.title` 的地方；其他语言使用宿主短码键（`fr`、`es`、`br`、`ru`、`ar`、`de`、`ja`、`hi`、`ko`）。
- `src/rpc.ts` —— 两个进程共享的 RPC 契约。
- `test/*` —— 单元测试与回归测试。

## 基本规则

1. **测试驱动开发（TDD）。** 先写失败的测试，再让它通过。每个 bug 修复必须附带一个「没有修复就会失败」的回归测试。
2. **保持 GUI 逻辑纯净。** Solid 组件无法在 `node --test` 下运行；新行为放进同名的 `*.ts` 纯逻辑模块，组件保持轻薄。
3. **Conventional Commits。** `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:` —— 每个提交一个逻辑变更。
4. **测试全绿。** 开 PR 前 `npm test` 与 `npm run typecheck` 必须全部通过。
5. **GUI bundle 约束。** `dist/` 内必须恰好一个文件；`solid-js`、`solid-js/web`、`@opencode/plugin/gui`、`@opencode/plugin/rpc` 保持 external；不允许动态 import。违反时 `npm run build` 会失败。
6. **RPC 契约。** 可预期的失败一律通过 `context.error` 返回并携带 data 载荷（绝不 throw 普通 Error）；output 的可选字段必须整体省略而不是设为 `undefined`；错误码不得使用宿主保留的 `rpc.` 前缀。
7. **无个人路径、无网络调用。** 路径一律从 `os.homedir()` / 宿主项目列表推导；插件不发起网络请求，也不收集遥测。
8. **i18n 词典。** 新增或修改键时，先更新 `en.ts`（它必须始终包含全部键），保持 `{{placeholder}}` 占位符名称不变；新语言只用宿主短码键注册。欢迎翻译贡献——机翻也没问题，以英文文案为准。

## 提交变更

1. Fork 本仓库并创建分支：`git checkout -b feat/my-change`。
2. 按上述基本规则完成修改。
3. 运行 `npm test && npm run typecheck` —— 两者都必须通过。
4. Push 并发起 Pull Request，说明改了**什么**以及**为什么**。如有相关 issue 请关联。

## 报告 Bug

提 issue 时请附上：

- OpenCode Desktop 版本（设置 → 关于）
- 操作系统与界面语言
- 你做了什么、预期是什么、实际发生了什么
- 可用的控制台输出；如能提供出问题的代理 Markdown 文件更好（请先抹除个人内容）

## 功能请求

请先开 issue 描述你想解决的问题——功能会按本插件的范围来权衡：在 OpenCode Desktop 内管理子代理 Markdown 文件。

## 许可

提交贡献即表示你同意这些贡献按 [MIT 许可证](LICENSE) 授权。
