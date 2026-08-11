---
'vue-ts-lsp': patch
---

Harden the workspace scan caches from review: any document lifecycle event now also refreshes the cached directory listing (files created on disk without a `didOpen` — the normal case for agent-written files — were invisible to reference/diagnostics scans for up to 5 seconds), the disk-text cache is bounded and sweeps expired entries instead of retaining the whole workspace's source for the life of the process, and identifier reference collection now builds a per-document identifier index so repeated queries against the same text (up to 3 per edit) cost one TypeScript parse instead of one each. `VUE_TS_LSP_TSSERVER_LOG` no longer accepts `requestTime` (vtsls silently treats it as `off`) and warns on invalid values.
