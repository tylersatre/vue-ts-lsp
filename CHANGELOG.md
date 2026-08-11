# Changelog

## 0.3.1

### Patch Changes

- 7b84c60: Align docs and test coverage with Claude Code 2.1.226 client behavior: the evict → `didClose` → re-`didOpen` LRU cycle (live since client 2.1.208) is now covered by integration tests, README's `.lsp.json` guidance no longer warns against `restartOnCrash`/`shutdownTimeout` (implemented in current clients) and documents the newly accepted fields, and AGENTS.md records the verified client version.
- 7b84c60: Update `@vue/language-server` to 3.3.9 (tsserver/request bridge verified unchanged; real-child smoke suite passes).
- 7b84c60: Inline the LSP server config in `.claude-plugin/marketplace.json` so Claude Code's LSP auto-recommendation engine can offer vue-ts-lsp when a user opens a matching file with no active LSP — the recommender only considers marketplace entries with inline `lspServers` and skips ones that point at a separate `.lsp.json`. A test keeps the inline block in sync with `.lsp.json`.
- 7b84c60: Two Pinia navigation fixes surfaced by review: go-to-definition through `storeToRefs` now resolves setup-store actions to their `function` declaration instead of the `return { ... }` shorthand (an ordering bug made the declaration branch unreachable), and options-store `state` members declared with the canonical concise arrow body `state: () => ({ ... })` now resolve (the parenthesized object literal was never unwrapped).
- 7b84c60: `textDocument/diagnostic` (pull diagnostics) now runs the same open-from-disk self-heal as other LSP requests, so a pull for a document the child servers never saw is preceded by a synthesized `didOpen`.
- 7b84c60: Fix a crash-recovery race: the replacement child connection was published to the router before its `initialize` completed, so upstream notifications during the recovery window could hit an uninitialized server (a protocol violation that could re-crash it and burn the restart budget) and a `didOpen` arriving mid-recovery was duplicated by the replay loop. The recovered connection is now published only after initialize, configuration push, and document replay have all completed, and a failed initialize kills the replacement child and keeps the old connection in place. The vtsls and vue_ls recovery paths are also unified into a single implementation so future fixes land in one place.
- 7b84c60: Bound crash-recovery retries independently of wall clock: the sliding 30-second retry window could never stop a retry chain whose attempts each took longer than ~10 seconds to fail (e.g. a replacement server that OOMs during startup), producing an endless respawn loop with no user-facing message. A consecutive-failure counter (reset on successful recovery) now gives up after the same `maxRestarts` bound and shows the crash message. Failed replacement connections are also disposed instead of leaking their listeners, and the LSP `shutdown` request now participates in the run-child-shutdown-once guard.
- 7b84c60: A failed crash-recovery attempt (e.g. the replacement child dies during initialize) no longer dead-ends the proxy: recovery now schedules another attempt itself — the crashed connection's close event has already fired, so nothing else would — and the existing retry cap still decides when to give up. A failed vtsls recovery also no longer aborts a concurrent vue_ls recovery, and duplicate shutdown triggers (signal plus stdin EOF) run the child shutdown only once.
- 7b84c60: Close the remaining crash-loop and orphan windows found in review: the recovery give-up budget now resets only after a replacement child stays alive through a stability window, so a child that crashes shortly after every successful recovery can no longer respawn forever (slow crash cycles defeated both the sliding retry window and a reset-on-publish counter). If the upstream connection closes while a graceful shutdown is still in flight, the proxy now force-kills both children before exiting instead of orphaning them. The per-document identifier index is bounded like the other scan caches (per-URI eviction on lifecycle events plus a TTL sweep), vue_ls publishes can no longer be mistaken for fresh vtsls diagnostics when deciding to skip a nudge (pinned by test), and the CI stdout guard now catches every `console.*` call — including `console.debug`, which writes to stdout.
- 7b84c60: A failed child respawn during crash recovery no longer kills the whole proxy. `process.exit(1)` on a spawn error is now reserved for the initial launch; recovery respawn failures fail only that recovery attempt, leaving the other (healthy) server and the upstream connection intact.
- 7b84c60: Prevent unhandled `sendNotification` rejections from terminating the proxy. All notification sends now go through a `safeSendNotification` helper that logs async write failures (e.g. EPIPE to a crashed child server) instead of letting them escape as unhandled rejections, and the entrypoint installs a defense-in-depth `unhandledRejection` handler that logs to stderr without exiting.
- 7b84c60: Harden the workspace scan caches from review: any document lifecycle event now also refreshes the cached directory listing (files created on disk without a `didOpen` — the normal case for agent-written files — were invisible to reference/diagnostics scans for up to 5 seconds), the disk-text cache is bounded and sweeps expired entries instead of retaining the whole workspace's source for the life of the process, and identifier reference collection now builds a per-document identifier index so repeated queries against the same text (up to 3 per edit) cost one TypeScript parse instead of one each. `VUE_TS_LSP_TSSERVER_LOG` no longer accepts `requestTime` (vtsls silently treats it as `off`) and warns on invalid values.
- 7b84c60: React to the upstream (stdin) connection closing: if Claude Code dies without the LSP shutdown/exit handshake (SIGKILL, OOM, hard crash), the proxy now shuts down both child servers and exits instead of running forever with two live, memory-heavy children. All shutdown paths (exit notification, SIGINT/SIGTERM, upstream close) also flush the file log to disk before exiting, so trailing log lines are no longer lost.
- 7b84c60: Cache workspace scans: the dependent-diagnostics nudge could trigger up to ~6 synchronous full-workspace walks (directory listing, per-file reads, TypeScript parsing) per `.ts` edit, blocking the JSON-RPC event loop on large repos. File listings, disk reads, and importer-graph results are now cached per proxy context with per-URI invalidation on document lifecycle events and a short TTL safety net, collapsing the walks within a nudge cycle into one. The path-alias config cache is also cleared on workspace config reload. Additionally, tsserver's own log now defaults to `off` instead of `verbose` (set `VUE_TS_LSP_TSSERVER_LOG` to re-enable for debugging), so tsserver no longer writes verbose log files on every user's machine.

## 0.3.0

### Minor Changes

- b8ddec1: Align the proxy with Claude Code 2.1.204's LSP client behavior and harden the document lifecycle:

    - Forwarded diagnostics now carry a `version` (downstream-reported when available, document-store version otherwise), so Claude Code's staleness filter drops pre-edit diagnostics instead of attributing them to the current edit.
    - Self-heal client/server lifecycle mismatches: Claude Code does not replay `didOpen` after restarting the proxy, so a full-text `didChange` for an unopened document now synthesizes a `didOpen`, a repeated `didOpen` is downgraded to a full-document `didChange`, and LSP requests for unopened documents open them from disk before forwarding.
    - Pull diagnostics (`textDocument/diagnostic`) for `.vue` files now include the latest vue_ls diagnostics merged with the tsserver results.
    - Stored diagnostics are dropped per-URI on `didClose` and per-server on crash recovery, so merged `.vue` diagnostics never blend pre-crash or pre-close entries.
    - The Claude Code plugin manifest version now tracks the npm package version automatically at release time.
    - Update @vue/language-server to 3.3.7, vscode-jsonrpc to 9.0.1, vscode-languageserver-protocol to 3.18.2.

## 0.2.1

### Patch Changes

- 4fb56b1: Refresh the published package metadata after the post-update lockfile regeneration.

## 0.2.0

### Minor Changes

- 50d991c: Drop Node 18 support (now requires >=20.19.0) and update dependencies: typescript 6.0, vitest 4.1, @vue/language-server 3.2.6, @types/node 25.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-03-11

### Added

- Initial release: unified Vue + TypeScript LSP proxy for Claude Code
- tsserver/request forwarding between vue-language-server and vtsls
- Crash recovery with document replay
- Diagnostic merging from both servers
