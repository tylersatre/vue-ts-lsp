---
'vue-ts-lsp': patch
---

Two Pinia navigation fixes surfaced by review: go-to-definition through `storeToRefs` now resolves setup-store actions to their `function` declaration instead of the `return { ... }` shorthand (an ordering bug made the declaration branch unreachable), and options-store `state` members declared with the canonical concise arrow body `state: () => ({ ... })` now resolve (the parenthesized object literal was never unwrapped).
