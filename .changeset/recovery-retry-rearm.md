---
'vue-ts-lsp': patch
---

A failed crash-recovery attempt (e.g. the replacement child dies during initialize) no longer dead-ends the proxy: recovery now schedules another attempt itself — the crashed connection's close event has already fired, so nothing else would — and the existing retry cap still decides when to give up. A failed vtsls recovery also no longer aborts a concurrent vue_ls recovery, and duplicate shutdown triggers (signal plus stdin EOF) run the child shutdown only once.
