import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = process.cwd()
const MARKETPLACE_JSON_PATH = path.join(PROJECT_ROOT, '.claude-plugin', 'marketplace.json')
const LSP_JSON_PATH = path.join(PROJECT_ROOT, '.lsp.json')

// Claude Code's LSP auto-recommendation engine only considers marketplace entries with
// INLINE lspServers config — entries pointing at a separate .lsp.json file are skipped
// ("Skipping string path lspServers (not readable from marketplace)"). The inline block
// must therefore exist and must never drift from .lsp.json.
describe('marketplace inline lspServers', () => {
    it('inlines the .lsp.json config in the marketplace plugin entry', () => {
        const marketplace = JSON.parse(fs.readFileSync(MARKETPLACE_JSON_PATH, 'utf8')) as {
            plugins: Array<{ name: string; lspServers?: unknown }>
        }
        const lspConfig = JSON.parse(fs.readFileSync(LSP_JSON_PATH, 'utf8')) as Record<string, unknown>

        const entry = marketplace.plugins.find((plugin) => plugin.name === 'vue-ts-lsp')
        expect(entry).toBeDefined()
        expect(entry!.lspServers).toEqual(lspConfig)
    })
})
