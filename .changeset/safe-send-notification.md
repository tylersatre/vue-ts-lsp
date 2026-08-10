---
"vue-ts-lsp": patch
---

Prevent unhandled `sendNotification` rejections from terminating the proxy. All notification sends now go through a `safeSendNotification` helper that logs async write failures (e.g. EPIPE to a crashed child server) instead of letting them escape as unhandled rejections, and the entrypoint installs a defense-in-depth `unhandledRejection` handler that logs to stderr without exiting.
