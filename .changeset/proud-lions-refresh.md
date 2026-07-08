---
'vue-ts-lsp': minor
---

Align the proxy with Claude Code 2.1.204's LSP client behavior and harden the document lifecycle:

- Forwarded diagnostics now carry a `version` (downstream-reported when available, document-store version otherwise), so Claude Code's staleness filter drops pre-edit diagnostics instead of attributing them to the current edit.
- Self-heal client/server lifecycle mismatches: Claude Code does not replay `didOpen` after restarting the proxy, so a full-text `didChange` for an unopened document now synthesizes a `didOpen`, a repeated `didOpen` is downgraded to a full-document `didChange`, and LSP requests for unopened documents open them from disk before forwarding.
- Pull diagnostics (`textDocument/diagnostic`) for `.vue` files now include the latest vue_ls diagnostics merged with the tsserver results.
- Stored diagnostics are dropped per-URI on `didClose` and per-server on crash recovery, so merged `.vue` diagnostics never blend pre-crash or pre-close entries.
- The Claude Code plugin manifest version now tracks the npm package version automatically at release time.
- Update @vue/language-server to 3.3.7, vscode-jsonrpc to 9.0.1, vscode-languageserver-protocol to 3.18.2.
