# vue-ts-lsp

JSON-RPC proxy that sits between Claude Code and two downstream language servers (vtsls + vue-language-server), providing unified Vue + TypeScript LSP support.

## Build Commands

```bash
npm run build       # tsup: src/index.ts → dist/index.js (ESM, with shebang)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## Critical Constraint: stdout Is Sacred

`process.stdout` is the JSON-RPC transport to Claude Code. Any stray write to stdout (e.g., `console.log`) will corrupt the protocol. **All logging MUST go to stderr** via the logger module.

## Architecture

The proxy maintains three `vscode-jsonrpc` `MessageConnection`s:

- **Upstream**: `process.stdin`/`process.stdout` (Claude Code ↔ proxy)
- **vtsls downstream**: child process stdio (TypeScript intelligence)
- **vue_ls downstream**: child process stdio (Vue SFC features)

### Initialization order is mandatory

vtsls MUST be fully initialized before vue_ls starts. vue_ls immediately sends `tsserver/request` notifications on init, and vtsls must be ready to handle them.

### tsserver/request bridging

The critical glue between the two servers. vue_ls sends `tsserver/request` → proxy forwards via `workspace/executeCommand` (`typescript.tsserverRequest`) to vtsls → proxy sends `tsserver/response` back to vue_ls. **Always send a response, even on error** — failure causes memory leaks in vue_ls.

### Document routing

- `.vue` files: `didOpen`/`didChange`/`didClose` go to BOTH servers. LSP requests are split — TS-related methods (definition, hover, references, etc.) go to vtsls; Vue-specific methods (completion, rename, etc.) go to vue_ls.
- Non-`.vue` files: everything goes to vtsls only.

### Crash recovery

The document store tracks all open files. On child server restart, open documents are replayed (all docs for vtsls, only `.vue` docs for vue_ls). Restarts are rate-limited by `RetryTracker` (max 3 in 30s).

### vtsls didChange bug workaround

vtsls has a confirmed bug where full-document replacements (no `range` in contentChanges) use the NEW document's line count to compute the replacement range, crashing tsserver. The proxy patches these by injecting the correct range from the document store's pre-change content.

## Key Documentation

- `README.md` — installation, usage, and current limitations

## Plugin Files

- `.lsp.json` — Claude LSP plugin config (maps `.vue`, `.ts`, `.tsx`, `.js`, `.jsx` extensions)
- `.claude-plugin/` — Claude Code marketplace plugin metadata

## Testing

Tests live under `tests/`: fast module coverage in `tests/unit/`, proxy behavior coverage in `tests/integration/`, and real-child smoke coverage in `tests/smoke/`. `proxy.test.ts` uses mock `MessageConnection` objects with `triggerRequest`/`triggerNotification` helpers. The checked-in smoke workspace lives at `tests/fixtures/app-workspace`.
