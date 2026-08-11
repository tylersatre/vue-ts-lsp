# vue-ts-lsp

JSON-RPC proxy that sits between Claude Code and two downstream language servers (vtsls + vue-language-server), providing unified Vue + TypeScript LSP support.

## Build Commands

```bash
npm run build                 # tsup: src/index.ts → dist/index.js (ESM, with shebang)
npm run typecheck             # two projects: typecheck:src + typecheck:tests (both tsc --noEmit)
npm test                      # vitest run (unit + integration + smoke; smoke self-skips without the fixture)
npm run test:coverage         # vitest run --coverage (v8, thresholds enforced in CI)
npm run install:smoke-fixture # install tests/fixtures/app-workspace deps so smoke tests run
npm run format                # prettier --write; format:check runs in CI
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

- `.vue` files: `didOpen`/`didChange`/`didClose` go to BOTH servers. LSP requests are split — TS-related methods (definition, implementation, hover, references, call hierarchy) go to vtsls; the only `.vue` method routed to vue_ls is `documentSymbol` (`src/router.ts`). The proxy advertises no completion, rename, or formatting support.
- Non-`.vue` files: everything goes to vtsls only.

### Client lifecycle self-healing

Claude Code (verified against 2.1.226; re-verify and bump this version when client behavior is re-audited) always sends **full-text** `didChange` (it ignores the advertised sync kind) and — critically — does **not** replay `didOpen` when it restarts a crashed proxy: its open-file map survives the restart, so didChange notifications and LSP requests arrive for documents the child servers never saw. Since 2.1.208 it _does_ send `didClose` when a document is evicted from its 50-open-doc LRU cap (evicted docs get a fresh `didOpen` when touched again) — before that it never sent `didClose` at all. The proxy self-heals the remaining mismatches:

- `didChange` for an unopened document with a full-text change → synthesized `didOpen` downstream.
- `didOpen` for an already-open document → forwarded as a ranged full-document `didChange` (a second didOpen is a protocol violation).
- An LSP request for an unopened document → opened from disk first (Claude Code saves after every edit, so disk is current; 10MB cap).

### Diagnostics versioning

Forwarded `textDocument/publishDiagnostics` carry a `version`: the downstream server's reported version when present (vue_ls reports one, vtsls never does), else the document store's version at forward time. Claude Code drops publishes whose version is older than its tracked document version, which prevents pre-edit diagnostics from being attributed to the current edit. The `DiagnosticsStore` is cleared per-URI on `didClose` and per-server on crash recovery so merges never blend stale entries.

### Crash recovery

The document store tracks all open files. On child server restart, open documents are replayed (all docs for vtsls, only `.vue` docs for vue_ls). Restarts are rate-limited by `RetryTracker` (max 3 in 30s).

### vtsls didChange bug workaround

vtsls has a confirmed bug where full-document replacements (no `range` in contentChanges) use the NEW document's line count to compute the replacement range, crashing tsserver. The proxy patches these by injecting the correct range from the document store's pre-change content.

### Subsystems worth knowing about

- **Definition mirrors** — go-to-definition results pointing into `node_modules` are rewritten to a copy under `~/.cache/vue-ts-lsp/definition-mirrors/` (`src/definition-mirrors.ts`), so the client shows a stable readable file. Root overridable via `VUE_TS_LSP_DEFINITION_MIRROR_ROOT`; the cache is safe to delete.
- **Workspace config** — `.claude/vue-ts-lsp.json` in the workspace root supplies `ignoreDirectories` (skipped by fallback scans) and `logLevel` (`src/config.ts`), applied at `initialize`.
- **Diagnostics nudges** — after edits, the proxy asks tsserver for fresh diagnostics via `geterr` (`src/proxy-diagnostics.ts`) on three channels (`vue`, `script`, `script-dependent`, one `Map` on the context). Nudges run on a background queue that waits for vtsls to be idle from foreground requests (`src/proxy-communication.ts`).
- **Workspace scan caching** — file listings, disk reads, importer-graph results (`src/proxy-workspace.ts`) and per-document identifier indexes (`src/helpers/references.ts`) are cached with per-URI invalidation on document lifecycle events plus a short TTL; config reload clears everything.
- **Fallback ladders** — each request module (`proxy-definitions`, `proxy-hover`, `proxy-references`, `proxy-symbols`, `proxy-call-hierarchy`) encodes its own multi-stage fallback chain (probes, workspace scans, Pinia/storeToRefs resolution). They are deliberately NOT unified behind a generic pipeline — each ladder differs for real reasons.
- **Workspace-symbol synthesis** — an empty `workspace/symbol` query is rewritten to the identifier at the most recent request position (`src/proxy-symbols.ts`) so the client's habit of sending empty queries still returns something useful.
- **Timeout-triggered restart** — a vtsls definition/hover timeout during a Vue request can trigger a background vtsls restart (`src/proxy-communication.ts`), reusing the crash-recovery machinery.
- **Pull diagnostics** — `textDocument/diagnostic` is served by running tsserver's sync diagnostic commands through the bridge (`src/proxy-handlers.ts`); Claude Code doesn't send pulls today, other clients do.

### Module layering

`helpers/*` (pure, no context) → `proxy-utils` / `proxy-workspace` / `proxy-communication` (context-aware plumbing) → feature modules (`proxy-definitions`, `proxy-hover`, …) → `proxy-handlers` (wiring) → `proxy.ts` (orchestration) → `index.ts` (entrypoint). Keep imports pointing left.

## Key Documentation

- `README.md` — installation, usage, and current limitations

## Plugin Files

- `.lsp.json` — Claude LSP plugin config (maps `.vue`, `.ts`, `.tsx`, `.js`, `.jsx`; the code additionally handles `.mts`/`.cts`/`.mjs`/`.cjs` — a deliberate superset, pinned by a coherence test). Mirrored inline in `marketplace.json` for the LSP recommender; a sync test keeps them identical.
- `.claude-plugin/` — Claude Code marketplace plugin metadata

## Testing

Tests live under `tests/`: fast module coverage in `tests/unit/`, proxy behavior coverage in `tests/integration/` (13 files split along subsystem lines; the shared mock `MessageConnection` harness with `triggerRequest`/`triggerNotification` helpers lives in `tests/integration/helpers/harness.ts`), and real-child smoke coverage in `tests/smoke/`. The checked-in smoke workspace lives at `tests/fixtures/app-workspace`.
