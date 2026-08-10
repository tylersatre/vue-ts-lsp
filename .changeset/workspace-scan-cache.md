---
"vue-ts-lsp": patch
---

Cache workspace scans: the dependent-diagnostics nudge could trigger up to ~6 synchronous full-workspace walks (directory listing, per-file reads, TypeScript parsing) per `.ts` edit, blocking the JSON-RPC event loop on large repos. File listings, disk reads, and importer-graph results are now cached per proxy context with per-URI invalidation on document lifecycle events and a short TTL safety net, collapsing the walks within a nudge cycle into one. The path-alias config cache is also cleared on workspace config reload. Additionally, tsserver's own log now defaults to `off` instead of `verbose` (set `VUE_TS_LSP_TSSERVER_LOG` to re-enable for debugging), so tsserver no longer writes verbose log files on every user's machine.
