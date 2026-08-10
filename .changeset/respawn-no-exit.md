---
"vue-ts-lsp": patch
---

A failed child respawn during crash recovery no longer kills the whole proxy. `process.exit(1)` on a spawn error is now reserved for the initial launch; recovery respawn failures fail only that recovery attempt, leaving the other (healthy) server and the upstream connection intact.
