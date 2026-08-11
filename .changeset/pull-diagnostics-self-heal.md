---
'vue-ts-lsp': patch
---

`textDocument/diagnostic` (pull diagnostics) now runs the same open-from-disk self-heal as other LSP requests, so a pull for a document the child servers never saw is preceded by a synthesized `didOpen`.
