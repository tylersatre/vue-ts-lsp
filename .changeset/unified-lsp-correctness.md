---
'vue-ts-lsp': patch
---

Fix unified Vue and TypeScript navigation and lifecycle gaps:

- Return protocol-compliant call hierarchy ranges and retain incoming-call fallbacks when the language server returns null.
- Keep reference fallbacks focused on the requested identifier instead of its enclosing declaration.
- Resolve TypeScript source files from JavaScript import extensions and honor inherited workspace path aliases.
- Prevent known stale diagnostic snapshots from contaminating newer pushes and pulls.
- Prepare the TypeScript bridge before Vue initialization, retry synchronous child-spawn failures within the existing limit, and stop child recovery when the proxy shuts down.
