# Contributing to vue-ts-lsp

Thanks for your interest in contributing! Here's how to get started.

## Reporting Bugs

Open an issue using the [bug report template](https://github.com/tylersatre/vue-ts-lsp/issues/new?template=bug_report.yml). Include steps to reproduce, expected vs actual behavior, and any relevant log output.

## Development Setup

**Prerequisites:** Node.js >= 20.19.0 (see `package.json`), npm

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
3. For code changes, run `npm run format:check`, `npm test`, and `npm run typecheck` — all must pass. For documentation-only changes, check formatting on the changed files (for example, `npx prettier --check AGENTS.md CONTRIBUTING.md`), links, and referenced commands or source facts.
4. Open a pull request describing what you changed and why

Report which checks ran and whether smoke tests were skipped. CI runs repository formatting, typechecks, stdout safety checks, and tests with smoke fixture dependencies and coverage thresholds for every pull request.

## AI-Assisted Contributions

[AGENTS.md](AGENTS.md) is the shared instruction source for coding agents, including Codex using GPT-6 Astra. Keep repository guidance there; [CLAUDE.md](CLAUDE.md) imports it for Claude Code. These instructions guide work on this repository; they do not select the coding agent's model or change the proxy's supported client.

## Architecture

The proxy sits between Claude Code and two child language servers (vtsls + vue-language-server). See [AGENTS.md](AGENTS.md) for architectural details.

## Critical Constraint: stdout Is Sacred

`process.stdout` is the JSON-RPC transport. **Never write to stdout** (no `console.log`). All logging must go to stderr via the logger module.

## Code Style

- TypeScript strict mode
- ESM modules
- Format with Prettier (`npm run format`)
- Keep changes focused — avoid unrelated refactors in the same PR
