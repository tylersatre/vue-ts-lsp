---
"vue-ts-lsp": patch
---

Fix a crash-recovery race: the replacement child connection was published to the router before its `initialize` completed, so upstream notifications during the recovery window could hit an uninitialized server (a protocol violation that could re-crash it and burn the restart budget) and a `didOpen` arriving mid-recovery was duplicated by the replay loop. The recovered connection is now published only after initialize, configuration push, and document replay have all completed, and a failed initialize kills the replacement child and keeps the old connection in place. The vtsls and vue_ls recovery paths are also unified into a single implementation so future fixes land in one place.
