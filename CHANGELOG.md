# Changelog

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
