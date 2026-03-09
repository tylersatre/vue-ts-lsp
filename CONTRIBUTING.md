# Contributing to vue-ts-lsp

Thanks for your interest in contributing! Here's how to get started.

## Reporting Bugs

Open an issue using the [bug report template](https://github.com/tylersatre/vue-ts-lsp/issues/new?template=bug_report.yml). Include steps to reproduce, expected vs actual behavior, and any relevant log output.

## Development Setup

**Prerequisites:** Node.js >= 18, npm

```bash
git clone https://github.com/tylersatre/vue-ts-lsp.git
cd vue-ts-lsp
npm install
npm run build
npm run format:check
npm test
npm run typecheck
```

## Submitting Changes

1. Branch from `main`
2. Make your changes
3. Run `npm run format:check`, `npm test`, and `npm run typecheck` — all must pass
4. Open a pull request describing what you changed and why

## Architecture

The proxy sits between Claude Code and two child language servers (vtsls + vue-language-server). See [CLAUDE.md](CLAUDE.md) for architectural details.

## Critical Constraint: stdout Is Sacred

`process.stdout` is the JSON-RPC transport. **Never write to stdout** (no `console.log`). All logging must go to stderr via the logger module.

## Code Style

- TypeScript strict mode
- ESM modules
- Format with Prettier (`npm run format`)
- Keep changes focused — avoid unrelated refactors in the same PR
