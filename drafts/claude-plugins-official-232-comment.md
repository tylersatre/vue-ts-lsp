# DRAFT — comment for anthropics/claude-plugins-official#232 ("Add Vue/Volar LSP plugin")

> Post from your own account. Tone target: helpful and factual, not promotional — name the failure modes people in the thread hit, explain the mechanism, link once.

---

A couple of the failure modes described in this thread have a common root cause, and there's a working approach for it.

The hang @<commenter> describes — the Vue plugin "sends the request to the tsserver in claude code, gets no response, and hangs indefinitely" — is the `tsserver/request` bridge problem: Volar v3's `vue-language-server` delegates all TypeScript queries to a host tsserver via custom `tsserver/request` notifications, and Claude Code's LSP client doesn't implement that protocol, so those requests go unanswered forever. (Related: anthropics/claude-code#38929 asked for exactly this forwarding and was closed without engagement.) It's also why `typescript-lsp` alone has no go-to-definition/references inside `.vue` files — tsserver never sees the Vue SFC virtual code, and the most popular community LSP marketplace (Piebald-AI/claude-code-lsps) pins `@vue/language-server@2` and documents that v3 forwarding is unsupported.

I maintain [vue-ts-lsp](https://github.com/tylersatre/vue-ts-lsp), a small JSON-RPC proxy built specifically for this: it runs vtsls and `vue-language-server` (Volar v3) as children, answers the `tsserver/request` bridge itself by forwarding to vtsls (`typescript.tsserverRequest` via `workspace/executeCommand`), and routes per-method so `.vue` files get both TS intelligence (definition/hover/references through vtsls) and SFC features. Install:

```
npm install -g vue-ts-lsp
claude plugin marketplace add tylersatre/vue-ts-lsp
claude plugin install vue-ts-lsp@vue-ts-lsp
```

Happy to answer questions or take bug reports if anyone here tries it on their project.

---

_Notes for Tyler (not part of the comment):_

- _Fill in the actual commenter @handle for the hang report before posting; check the thread for exact wording._
- _Verify the install commands against the current README before posting._
- _Keep the Piebald mention factual — their marketplace is the popular one and their docs corroborate the v3 limitation; no need to frame it competitively._
