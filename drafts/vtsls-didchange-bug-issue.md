# DRAFT — GitHub issue for yioneko/vtsls (file from your own account; do not post as-is without checking current vtsls main)

**Title:** Full-document `didChange` (no `range`) computes the replacement range from the NEW document's line count, corrupting the tsserver update

## Summary

When a client sends `textDocument/didChange` with a rangeless full-document content change (as any client using full-document sync does — Claude Code's LSP client always does), vtsls computes the replacement range from the **new** document's line count instead of the old one, because the shim mutates the document before computing the range. The corrupted incremental update it then hands to tsserver can crash it.

## Where

`packages/service/src/shims/workspace.ts`, `$changeTextDocument`:

1. `TextDocument.update(...)` is called first, mutating the stored document to the NEW text.
2. The no-`range` branch then computes `range: new types.Range(0, 0, doc.lineCount, 0)` — but `doc.lineCount` is now the **new** document's line count.
3. Secondary bug in the same branch: `rangeLength: c.text.length` uses the new text's length rather than the old document's length.

If the new text has fewer lines than the old, the replacement range doesn't span the old document, so the update applied inside tsserver corrupts its view of the file; with the right shape of edit this crashes tsserver.

## Reproduction

Any full-document replacement that reduces the line count. Real-world repro that reliably crashed tsserver for us: a ~393-line TypeScript file receiving a full-text `didChange` (we can share the exact fixture; it is checked into our test suite).

Sequence:

1. `didOpen` a multi-line `.ts` file.
2. Send `didChange` with `contentChanges: [{ text: "<entire new content>" }]` (no `range`), where the new content has a different line count.
3. Observe the range vtsls forwards: it is `(0,0)..(newLineCount,0)` instead of `(0,0)..(oldLineCount,0)`.

## Suggested fix

Compute the replacement range (and `rangeLength`) from the **pre-update** document — i.e. capture `doc.lineCount`/`doc.getText().length` before calling `TextDocument.update(...)`, or reorder so the range is derived first.

## Context

We maintain a JSON-RPC proxy (vue-ts-lsp) that fronts vtsls for Claude Code, whose LSP client only ever sends full-text `didChange`. We currently work around this by injecting the correct range computed from our own pre-change copy of the document before forwarding (see `patchFullDocReplacements` in https://github.com/tylersatre/vue-ts-lsp — src/proxy-utils.ts), which fully avoids the crash. Happy to open a PR with the reordering fix if that's welcome.

---

_Notes for Tyler (not part of the issue): verify the `$changeTextDocument` code on current vtsls main before filing — the review verified it on main as of 2026-08-10. The 392-line crash repro lives in tests/integration/proxy.test.ts ("didChange full-document replacement patching" describe). vtsls is near-dormant (last release 2025-12-24), so the closing PR offer materially raises merge odds._
