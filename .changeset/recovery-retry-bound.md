---
'vue-ts-lsp': patch
---

Bound crash-recovery retries independently of wall clock: the sliding 30-second retry window could never stop a retry chain whose attempts each took longer than ~10 seconds to fail (e.g. a replacement server that OOMs during startup), producing an endless respawn loop with no user-facing message. A consecutive-failure counter (reset on successful recovery) now gives up after the same `maxRestarts` bound and shows the crash message. Failed replacement connections are also disposed instead of leaking their listeners, and the LSP `shutdown` request now participates in the run-child-shutdown-once guard.
