---
"vue-ts-lsp": patch
---

Align docs and test coverage with Claude Code 2.1.226 client behavior: the evict → `didClose` → re-`didOpen` LRU cycle (live since client 2.1.208) is now covered by integration tests, README's `.lsp.json` guidance no longer warns against `restartOnCrash`/`shutdownTimeout` (implemented in current clients) and documents the newly accepted fields, and AGENTS.md records the verified client version.
