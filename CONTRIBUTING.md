# Contributing to opencode-subagent-studio

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in contributing! This document covers everything you need to get started.

## Development setup

Requirements: **Node.js 24+**, **npm**, and an OpenCode Desktop install for manual testing (2.2.5 or newer).

```bash
npm install
npm test          # unit tests (node --test with type stripping)
npm run typecheck # tsc --noEmit
npm run build     # single-file CJS GUI bundle at dist/gui-experimental.cjs
npm run watch     # rebuild the GUI on change
```

## How the code is organised

- `src/index.ts` — server entry (`Plugin.define`): RPC handlers, fs.watch, builtin model overrides.
- `src/core/*` — pure server logic, no host imports; everything here runs under `node --test`.
- `src/gui/*` — SolidJS settings page. Each component has a sibling `*.ts` pure-logic module so the logic stays unit-testable.
- `src/gui/i18n/*` — interface dictionaries. `en.ts` is the required fallback and the only place `page.title` is defined; other locales use host short-code keys (`fr`, `es`, `br`, `ru`, `ar`, `de`, `ja`, `hi`, `ko`).
- `src/rpc.ts` — the RPC contract shared by both processes.
- `test/*` — unit and regression tests.

## Ground rules

1. **Test-driven development.** Write the failing test first, then make it pass. Every bug fix must come with a regression test that fails without the fix.
2. **Keep GUI logic pure.** Solid components cannot run under `node --test`; put new behaviour in the sibling `*.ts` module and keep components thin.
3. **Conventional Commits.** `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:` — one logical change per commit.
4. **All tests green.** `npm test` and `npm run typecheck` must pass before you open a PR.
5. **GUI bundle constraints.** `dist/` must contain exactly one file; `solid-js`, `solid-js/web`, `@opencode/plugin/gui` and `@opencode/plugin/rpc` stay external; no dynamic imports. `npm run build` fails if these are violated.
6. **RPC contract.** Declared failures go through `context.error` with a data payload (never a thrown plain error), optional output fields must be omitted entirely rather than set to `undefined`, and error codes must not use the reserved `rpc.` prefix.
7. **No personal paths or network calls.** Paths derive from `os.homedir()` / the host project list; the plugin makes no network requests and collects no telemetry.
8. **i18n dictionaries.** If you add or change keys, update `en.ts` first (it must always contain every key), keep `{{placeholder}}` names intact, and register new locales under host short-code keys only. Translations are welcome — machine translation is fine, the English copy is authoritative.

## Submitting changes

1. Fork the repo and create a branch: `git checkout -b feat/my-change`.
2. Make your change following the ground rules above.
3. Run `npm test && npm run typecheck` — both must pass.
4. Push and open a Pull Request describing **what** changed and **why**. Link any related issue.

## Reporting bugs

Open an issue with:

- OpenCode Desktop version (Settings → About)
- OS and locale
- What you did, what you expected, what happened
- Console output if available, and the affected agent markdown file if you can share it (redact personal content first)

## Feature requests

Open an issue first and describe the problem you are trying to solve — features are weighed against the plugin's scope: managing subagent markdown files inside OpenCode Desktop.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
