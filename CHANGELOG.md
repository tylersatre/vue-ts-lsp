# Changelog

## 0.3.0

### Minor Changes

- b8ddec1: Align the proxy with Claude Code 2.1.204's LSP client behavior and harden the document lifecycle:

    - Forwarded diagnostics now carry a `version` (downstream-reported when available, document-store version otherwise), so Claude Code's staleness filter drops pre-edit diagnostics instead of attributing them to the current edit.
    - Self-heal client/server lifecycle mismatches: Claude Code does not replay `didOpen` after restarting the proxy, so a full-text `didChange` for an unopened document now synthesizes a `didOpen`, a repeated `didOpen` is downgraded to a full-document `didChange`, and LSP requests for unopened documents open them from disk before forwarding.
    - Pull diagnostics (`textDocument/diagnostic`) for `.vue` files now include the latest vue_ls diagnostics merged with the tsserver results.
    - Stored diagnostics are dropped per-URI on `didClose` and per-server on crash recovery, so merged `.vue` diagnostics never blend pre-crash or pre-close entries.
    - The Claude Code plugin manifest version now tracks the npm package version automatically at release time.
    - Update @vue/language-server to 3.3.7, vscode-jsonrpc to 9.0.1, vscode-languageserver-protocol to 3.18.2.

## 0.2.1

### Patch Changes

- 4fb56b1: Refresh the published package metadata after the post-update lockfile regeneration.

## 0.2.0

### Minor Changes

- 50d991c: Drop Node 18 support (now requires >=20.19.0) and update dependencies: typescript 6.0, vitest 4.1, @vue/language-server 3.2.6, @types/node 25.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-03-11

### Added

- Initial release: unified Vue + TypeScript LSP proxy for Claude Code
- tsserver/request forwarding between vue-language-server and vtsls
- Crash recovery with document replay
- Diagnostic merging from both servers
