---
'vue-ts-lsp': patch
---

Close the remaining crash-loop and orphan windows found in review: the recovery give-up budget now resets only after a replacement child stays alive through a stability window, so a child that crashes shortly after every successful recovery can no longer respawn forever (slow crash cycles defeated both the sliding retry window and a reset-on-publish counter). If the upstream connection closes while a graceful shutdown is still in flight, the proxy now force-kills both children before exiting instead of orphaning them. The per-document identifier index is bounded like the other scan caches (per-URI eviction on lifecycle events plus a TTL sweep), vue_ls publishes can no longer be mistaken for fresh vtsls diagnostics when deciding to skip a nudge (pinned by test), and the CI stdout guard now catches every `console.*` call — including `console.debug`, which writes to stdout.
