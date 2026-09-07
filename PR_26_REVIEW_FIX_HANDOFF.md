# PR #26 Review Fix Handoff

## Purpose

Fix the confirmed defects found during the read-only review of [PR #26](https://github.com/tylersatre/vue-ts-lsp/pull/26), then validate the repaired aggregate before recommending merge.

Review baseline:

- Comparison: `main...HEAD`
- Base: `6132cd27fb81bdd0dee34b8cec5507b8690980e3`
- Reviewed head: `e03b956318edf6ca8d07f9c2c6770b12b530b05c`
- Branch: `review-fixes`
- Merge recommendation at review time: **request changes**

Before making changes, confirm that the branch still points at the reviewed head or inspect any newer commits and reconcile this handoff with them.

## Worktree constraints

The review left the tracked worktree clean. These pre-existing untracked paths belong to the user and must remain untouched:

- `.claude/agents/`
- `drafts/`

Do not post comments, open reviews, push, commit, or modify external state unless the user separately asks. Preserve the stdout transport invariant: production logging must never write to stdout.

## Confirmed findings

### REC-001 — P1 — Recovery initialization can remain pending forever

Primary code: `src/proxy-recovery.ts:153-156`

`recoverServer()` awaits the replacement connection's raw `initialize` request without a timeout and without racing it against that connection closing. In `vscode-jsonrpc` 9.0.1, a connection close changes connection state and fires `onClose`, but does not reject entries in `responsePromises`; pending requests are rejected only by `dispose()`.

Confirmed behavior: after `sendRequest('initialize', {})` successfully writes, closing the reader leaves the returned promise pending. A direct reproduction remained pending after 100 ms.

Impact:

- The server-specific recovery promise can remain pending indefinitely.
- `sendDownstreamRequest()` calls `waitForActiveRecovery()` outside its downstream timeout race, so subsequent requests can also hang indefinitely.
- Vue recovery may wait forever on a stuck vtsls recovery.
- A replacement that closes immediately after replying can potentially be published after its close event has already fired, leaving no recovery listener to observe that close.

Required outcome:

- Replacement initialization must finish, fail, or time out in bounded time.
- Closing the candidate before initialization/replay completes must reject that recovery attempt.
- Failed candidates must be killed/disposed and flow through the existing bounded retry/re-arm behavior.
- A closed candidate must never become the published current connection.
- Waiting foreground requests must not be able to block forever on recovery.

Regression coverage must include:

1. candidate closes after accepting `initialize` but before replying;
2. candidate stays open but never replies;
3. candidate replies and then closes before publication/listener installation;
4. successful initialization/replay still publishes exactly once.

### REC-002 — P2 — Vue can initialize before the scheduled vtsls retry

Primary code: `src/proxy-recovery.ts:81-87` and `src/proxy-recovery.ts:194-199`

When both downstream servers are recovering and the first vtsls replacement rejects initialization:

1. vtsls schedules its next attempt with `setTimeout()` and rejects the active recovery promise;
2. Vue's `beforeSpawn` catches that rejection and immediately continues;
3. the retry timer has not yet made a new vtsls recovery active, so `ctx.currentVtsls` is still the dead old connection;
4. Vue initializes and sends its mandatory initialization-time `tsserver/request` notifications to that dead connection, receiving null/error responses;
5. a later successful vtsls retry does not reinitialize the already-published Vue server.

This violates the project's mandatory initialization order and can leave Vue TypeScript features degraded until another Vue recovery or a proxy reload. The existing test named `still recovers vue_ls when the awaited vtsls recovery fails` pins the problematic immediate continuation but does not model the scheduled retry or bridge traffic.

Required outcome:

- Vue must not start initialization until vtsls is confirmed initialized and current.
- A failed vtsls attempt with a pending bounded retry must keep Vue waiting for the retry chain, without creating an unbounded wait.
- The permanent vtsls give-up path must have explicit, tested behavior rather than initializing Vue against a dead bridge.

Regression coverage must drive simultaneous recoveries, fail vtsls attempt one, and prove that Vue spawn/initialize and its `tsserver/request` traffic occur only after a successful vtsls retry is published.

### DIA-001 — P2 — Forced recovery can retain stale diagnostics

Primary code:

- `src/proxy-recovery.ts:134-145`
- `src/proxy-handlers.ts:48-66`
- `src/proxy-diagnostics.ts:52-56`

The forced timeout-recovery path clears that server's diagnostics, waits `ctx.delayMs` (one second by default), and only then kills the suspect current child. Its existing diagnostic handler remains active during the delay and has no connection-generation or active-recovery guard. A late vtsls `publishDiagnostics` can therefore repopulate the just-cleared store.

Because vtsls does not provide diagnostic versions, the late result is stamped with the current document-store version. For Vue files it can remain merged with Vue diagnostics until the replacement vtsls publishes; for script files it can be forwarded immediately as if it were current.

Required outcome:

- Diagnostics from the superseded connection must not be accepted after forced recovery begins.
- Clearing must happen after the old connection is quiesced, or handlers must reject publishes from stale connection generations.
- Normal crash recovery and diagnostic merge semantics must remain intact.

Regression coverage must publish diagnostics from the old connection during the force-kill delay and prove they are neither forwarded as current nor retained for later merges.

### REC-003 — P2 — An intentional forced close can consume the failure budget twice

Primary code: `src/proxy-recovery.ts:176-201` and `src/proxy-recovery.ts:215-226`

The recovered child's close wrapper ignores a self-inflicted close only while a recovery promise is active. A realistic asynchronous ordering can defeat that check:

1. forced recovery sends SIGTERM to the old child;
2. replacement initialization fails before the old child's `onClose` arrives;
3. the failed replacement increments consecutive failures and the recovery promise is cleared;
4. the delayed intentional `onClose` now sees no active recovery, increments the counter again, and starts another recovery.

The existing forced-kill test invokes `onClose` synchronously inside the kill callback, so it does not exercise this ordering.

Required outcome:

- Each real recovery failure consumes the consecutive-failure budget at most once.
- The connection intentionally killed for a timeout restart must remain marked as intentional until its close is observed, even if the replacement attempt finishes first.
- Spontaneous post-publication crashes must continue to count.

Regression coverage must delay the killed connection's close until after replacement initialization rejects, then assert that only the replacement failure is counted and only the intended retry chain runs.

### LOG-001 — P2 — A second exit path can bypass the promised log flush

Primary code:

- `src/proxy.ts:148-176`
- `src/logger.ts:34-43`

During the normal `shutdown -> exit -> upstream close` sequence, the exit notification calls `flushLogsAndExit()`. `closeFileLogging()` immediately sets the module-level `fileStream` to null, then waits for the original stream's `end` callback. If upstream close fires before that callback, `shutdownOnSignal()` calls `flushLogsAndExit()` again. The second `closeFileLogging()` sees null, resolves immediately, and calls `process.exit(0)` before the first stream has finished.

Required outcome:

- Log shutdown must be idempotent/single-flight.
- All non-force exit paths must await the same in-progress flush before calling `process.exit()`.
- Existing second-signal force-quit behavior may remain intentionally immediate, but that exception must be explicit and tested.

Regression coverage must use a deferred stream-end/close promise, trigger `shutdown -> exit -> upstream close`, and prove that `process.exit()` is not called before the original flush resolves.

### CACHE-001 — P2 — Equivalent file URIs bypass live-document/cache coherence

Primary code:

- `src/proxy-workspace.ts:68-74`
- `src/proxy-workspace.ts:289-318`
- `src/proxy-workspace.ts:333-360`

Internal stores and caches use raw URI strings, while workspace scans synthesize URIs with `pathToFileURL()`. Equivalent file URI spellings therefore become different keys, for example:

- `file://localhost/tmp/importer.ts`
- `file:///tmp/importer.ts`

Confirmed reproduction:

1. scan a workspace where `importer.ts` imports `target.ts`, caching the canonical importer URI/text;
2. deliver an unsaved lifecycle edit for the importer through the `file://localhost/...` URI and remove the import;
3. invalidation deletes only the alias key and clears the importer graph;
4. the rebuilt scan uses the canonical URI, misses the alias-keyed live document, and reuses cached or on-disk stale text;
5. importer/reference/dependent-diagnostic discovery still reports the removed import.

Merely deleting a normalized cache key is insufficient for unsaved changes: canonical workspace scans must also see the equivalent live `DocumentStore` entry.

Required outcome:

- All filesystem-backed internal lookups that must share live content should use one consistent normalized identity, or an explicit alias mapping.
- Downstream protocol messages may retain the client's original URI where required, but cache/store coherence must not depend on URI spelling.
- Unsaved edits through an equivalent URI must immediately affect importer/reference/dependent-diagnostic scans.

Regression coverage must use equivalent local file URIs and prove the rebuilt scan observes the unsaved in-memory edit rather than stale cached or disk text.

## Implementation guidance

Keep the repair bounded to these confirmed defects and their regression coverage. In particular:

- Do not replace the feature-specific fallback ladders with a generic pipeline.
- Preserve the mandatory vtsls-before-Vue initialization contract.
- Preserve the current document replay rule: all documents to vtsls, only Vue documents to Vue LS.
- Preserve the bounded retry/stability policy while making its event accounting deterministic.
- Keep all logging on stderr through the logger module; stdout remains exclusively JSON-RPC.
- Prefer connection identity/generation and single-flight state that can be tested deterministically over timing assumptions.

A sensible dependency order is:

1. REC-001, REC-002, and REC-003 together, because they share recovery state and ordering;
2. DIA-001 while recovery connection identity is explicit;
3. LOG-001;
4. CACHE-001.

Add regression tests before or alongside each fix. Re-read the aggregate diff afterward for interactions between the fixes.

## Validation requirements

Run at minimum:

```bash
npm run typecheck
npm run format:check
npm run build
npm run test:coverage
VUE_TS_LSP_RUN_DIAGNOSTIC_SMOKE=1 npx vitest run tests/smoke/proxy.smoke.test.ts
git diff --check
git status --short --branch
```

Review-time baseline:

- Typecheck: passed
- Format check: passed
- Build: passed
- Full tests: 530 passed, 8 opt-in diagnostic smoke tests skipped by the default command
- Coverage: 86.12% statements, 76.4% branches, 96.5% functions, 86.08% lines
- Real-child smoke with opt-in diagnostic baselines: 25/25 passed
- GitHub CI at reviewed SHA: Node 20, 22, and 24 jobs passed

Do not describe skipped or blocked validation as passing. At handoff, list exactly which tests ran, their counts, and any remaining unobserved behavior.

## Definition of done

- All six findings have regression tests that fail against the reviewed implementation and pass with the repair.
- Recovery cannot hang indefinitely, violate initialization order, double-count an intentional close, or accept stale-generation diagnostics.
- Exit logging is single-flight and preserves buffered logs on normal shutdown.
- Equivalent local file URIs share live document/cache identity for workspace scans.
- Full validation above passes.
- Only intended tracked files are changed; `.claude/agents/` and `drafts/` remain untouched.
- The final report maps each finding ID to the fix, tests, and exact validation evidence.
