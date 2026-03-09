[![CI](https://github.com/tylersatre/vue-ts-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/tylersatre/vue-ts-lsp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/vue-ts-lsp.svg)](https://www.npmjs.com/package/vue-ts-lsp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

# vue-ts-lsp

A unified LSP proxy that gives Claude Code full TypeScript intelligence across `.ts` files **and** `.vue` files — including `<template>` expressions.

## Why

Claude Code's LSP integration supports go-to-definition, hover, find-references, document symbols, workspace symbols, call hierarchy, and diagnostics. Getting all of these to work across `.ts` and `.vue` files requires two language servers:

- **vtsls** — TypeScript language server (handles `.ts`, `.js`, and `.vue` `<script>` blocks via `@vue/typescript-plugin`)
- **vue-language-server (v3)** — handles `.vue` `<template>` expressions, providing type-aware diagnostics and navigation

The problem: in Vue Language Tools v3, the LSP **client** must forward `tsserver/request` notifications from `vue-language-server` to `vtsls` and return responses. Claude Code's plugin system can't do this — it just spawns a stdio process.

This proxy fills the gap by acting as both the LSP server (to Claude Code) and the LSP client (to both child servers), implementing the v3 request forwarding protocol internally.

## What you get

| Scenario                                        | Without Proxy  | With Proxy |
| ----------------------------------------------- | -------------- | ---------- |
| Go-to-definition in `.ts`                       | ✅             | ✅         |
| Go-to-definition into `.vue` component          | ⚠️ file only   | ✅ symbol  |
| Hover on `{{ ref.value }}` in `<template>`      | ❌             | ✅         |
| Diagnostics for wrong prop type in `<template>` | ❌             | ✅         |
| Find references across `.ts` and `.vue`         | ⚠️ partial     | ✅         |
| Symbols in `.vue` file                          | ⚠️ script only | ✅         |

## Installation

### 1. Install the language server

```bash
npm install -g vue-ts-lsp
```

This installs the `vue-ts-lsp` binary along with `vtsls`, `@vue/language-server`, and `typescript` as bundled dependencies.

Verify the binary is in your PATH:

```bash
which vue-ts-lsp
```

### 2. Install the Claude Code plugin

The plugin tells Claude Code to use `vue-ts-lsp` for Vue and TypeScript files.

**From a marketplace**:

```bash
claude plugin install vue-ts-lsp@vue-ts-lsp
```

**Manually** — create an `.lsp.json` file at the root of your project or in a [plugin directory](https://code.claude.com/docs/en/plugins) loaded via `claude --plugin-dir`:

```json
{
    "vue-ts-lsp": {
        "command": "vue-ts-lsp",
        "extensionToLanguage": {
            ".vue": "vue",
            ".ts": "typescript",
            ".tsx": "typescriptreact",
            ".js": "javascript",
            ".jsx": "javascriptreact"
        },
        "startupTimeout": 30000
    }
}
```

> **Note:** This proxy replaces separate vtsls and vue-volar plugins. Do not install them simultaneously — you'll get duplicate diagnostics.

### 3. Verify

Start Claude Code (`claude --debug` for verbose output) and open a `.vue` or `.ts` file. You should see diagnostics, hover information, and go-to-definition working.

## Architecture

```
┌─────────────┐     stdio      ┌──────────────────────────────┐
│ Claude Code  │◄──────────────►│  vue-ts-lsp (proxy)          │
│ (LSP client) │                │                              │
└─────────────┘                │  ┌─────────┐  ┌───────────┐  │
                                │  │  vtsls   │  │  vue_ls   │  │
                                │  │ (child)  │  │  (child)  │  │
                                │  └────▲─────┘  └─────▲─────┘  │
                                │       │              │         │
                                │       │  tsserver/   │         │
                                │       │◄─request ────┘         │
                                │       │──response──►           │
                                └──────────────────────────────┘
```

### Request routing

The proxy currently exposes the Claude Code request surface implemented in this repository. It does not currently advertise completion, rename, or formatting support.

| File Type                    | Supported Operation                                                             | Routed To                |
| ---------------------------- | ------------------------------------------------------------------------------- | ------------------------ |
| `.ts`, `.js`, `.tsx`, `.jsx` | definition, implementation, hover, references, document symbols, call hierarchy | vtsls                    |
| `.vue`                       | definition, implementation, hover, references, call hierarchy                   | vtsls                    |
| `.vue`                       | document symbols                                                                | vue_ls                   |
| `.vue`                       | diagnostics                                                                     | Merged from both servers |
| Any                          | workspace/symbol                                                                | vtsls                    |

For architecture details, see [CLAUDE.md](CLAUDE.md).

## CLI usage

```bash
vue-ts-lsp [--log-level=<error|warn|info|debug>]
```

| Flag          | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| `--log-level` | Logging verbosity: `error` (default), `warn`, `info`, `debug` |

All logging goes to stderr and to `~/.cache/vue-ts-lsp/vue-ts-lsp.log`. stdout is reserved for the JSON-RPC protocol.

## Project config

The proxy optionally reads project-local settings from `.claude/vue-ts-lsp.json` in the workspace root.

```json
{
    "ignoreDirectories": ["vendor", "public"],
    "logLevel": "debug"
}
```

| Option              | Type                                   | Default | Description                                                                                    |
| ------------------- | -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `ignoreDirectories` | `string[]`                             | `[]`    | Workspace-root-relative directories to skip when the proxy runs local workspace fallback scans |
| `logLevel`          | `error` \| `warn` \| `info` \| `debug` | unset   | Sets the proxy log level without needing to pass a CLI flag                                    |

Notes:

- The config file is optional.
- `ignoreDirectories` defaults to an empty list.
- `ignoreDirectories` only affects proxy-managed workspace fallback scans; it does not change your TypeScript project configuration.
- `--log-level` on the CLI overrides `logLevel` from `.claude/vue-ts-lsp.json`.

## Known limitations

- Same-file diagnostics are generally reliable, but Claude Code may occasionally fail to attach a diagnostic to the current edit even when the proxy already published it.
- Cross-file diagnostics after changing exported function signatures, store APIs, or narrowed unions are improved but not guaranteed to appear immediately in every dependent file, especially in large mixed workspaces.
- If your workflow depends on catching downstream breakage after API changes, do not treat "no diagnostic appeared" as proof that all callers are valid. Prefer `findReferences`, a targeted typecheck, or project-specific verification hooks for high-confidence changes.
- Go-to-definition can be sensitive to the exact character position in complex TypeScript expressions such as `keyof typeof ...`. If a lookup misses unexpectedly, retry with the cursor placed directly on the referenced symbol.
- Template definition support is strongest for standard bound expressions such as `:prop="value"`. Shorthand boolean props and directive-based bindings such as `v-model` may not always resolve to the child prop or backing script symbol.
- `textDocument/implementation` follows downstream TypeScript and Vue language-server behavior. Interfaces or structural types backed by object literals may legitimately return no implementation result.
- Project hooks that rewrite files after `Edit` or `Write` tool calls, such as running Prettier, can add an extra mutation step and make diagnostic timing harder to reason about.
- After reverting a cross-file type break, dependent-file diagnostics may occasionally clear a beat later than the edit that fixed them.
- `ignoreDirectories` can reduce noisy fallback scanning in projects with generated, vendored, or public asset trees, but it only affects proxy fallback scans, not TypeScript's own project graph.

## Troubleshooting

| Issue                                                   | Solution                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server not starting                                     | Verify `which vue-ts-lsp` returns a path. Check `claude --debug` output for initialization errors.                                                                       |
| No diagnostics or hover                                 | Ensure your project has a `tsconfig.json` and `typescript` is installed in the project.                                                                                  |
| Slow startup                                            | The first initialization can take time on large projects. Increase `startupTimeout` in `.lsp.json` if needed.                                                            |
| Server crashes repeatedly                               | Check `~/.cache/vue-ts-lsp/vue-ts-lsp.log` for errors. The proxy auto-restarts up to 3 times per 30 seconds.                                                             |
| Debug logging                                           | Set `--log-level=debug` in the `.lsp.json` args, or set `"logLevel": "debug"` in `.claude/vue-ts-lsp.json`, to see full JSON-RPC payloads in the log file.               |
| Cross-file diagnostics missing in noisy workspaces      | Add project-specific ignores in `.claude/vue-ts-lsp.json`, for example `"ignoreDirectories": ["vendor", "public"]`, to keep fallback scans focused on real source files. |
| Go-to-definition misses on a valid TS symbol            | Retry with the cursor placed directly on the symbol token. Complex type expressions can be character-position-sensitive.                                                 |
| Template prop or `v-model` definition does not resolve  | Prefer testing the bound script symbol or a standard `:prop="..."` binding first. Shorthand boolean attrs and directive targets are less reliable today.                 |
| Go-to-implementation returns no result for an interface | This can be expected for structural typing or object-literal implementations. Use references or definitions instead if you need to trace usage sites.                    |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and how to submit changes.

```bash
git clone https://github.com/tylersatre/vue-ts-lsp.git
cd vue-ts-lsp
npm install
```

| Command                         | Description                                    |
| ------------------------------- | ---------------------------------------------- |
| `npm run build`                 | Build with tsup (src/index.ts → dist/index.js) |
| `npm run format`                | Format the repository with Prettier            |
| `npm run format:check`          | Check repository formatting with Prettier      |
| `npm run typecheck`             | Type-check source and tests                    |
| `npm test`                      | Run unit and integration tests (vitest)        |
| `npm run install:smoke-fixture` | Install smoke test fixture dependencies        |

> **Note:** The repo includes `.claude/settings.json` which enables the `typescript-lsp` plugin for Claude Code. This gives contributors TypeScript LSP support while working on this project. If it conflicts with your setup, you can override it in `.claude/settings.local.json`.

### Adding changesets

This project uses [changesets](https://github.com/changesets/changesets) for versioning and releases. When submitting a PR with user-facing changes, add a changeset:

```bash
npx changeset
```

You'll be prompted to select the version bump type (major, minor, or patch) and a summary. Commit the generated changeset file with your PR.

## License

[MIT](LICENSE)
