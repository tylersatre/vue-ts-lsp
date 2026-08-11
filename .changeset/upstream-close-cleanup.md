---
'vue-ts-lsp': patch
---

React to the upstream (stdin) connection closing: if Claude Code dies without the LSP shutdown/exit handshake (SIGKILL, OOM, hard crash), the proxy now shuts down both child servers and exits instead of running forever with two live, memory-heavy children. All shutdown paths (exit notification, SIGINT/SIGTERM, upstream close) also flush the file log to disk before exiting, so trailing log lines are no longer lost.
