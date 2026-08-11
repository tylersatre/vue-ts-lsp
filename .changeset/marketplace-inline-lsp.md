---
'vue-ts-lsp': patch
---

Inline the LSP server config in `.claude-plugin/marketplace.json` so Claude Code's LSP auto-recommendation engine can offer vue-ts-lsp when a user opens a matching file with no active LSP — the recommender only considers marketplace entries with inline `lspServers` and skips ones that point at a separate `.lsp.json`. A test keeps the inline block in sync with `.lsp.json`.
