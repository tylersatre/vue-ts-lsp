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

describe('.lsp.json extension map coherence with the routing code', () => {
    it('classifies every advertised extension the same way the proxy does', async () => {
        const { isVueUri, isScriptLikeUri, languageIdForUri } = await import('@src/proxy-utils.js')
        const lspConfig = JSON.parse(fs.readFileSync(LSP_JSON_PATH, 'utf8')) as {
            'vue-ts-lsp': { extensionToLanguage: Record<string, string> }
        }
        const extensionToLanguage = lspConfig['vue-ts-lsp'].extensionToLanguage

        for (const [extension, languageId] of Object.entries(extensionToLanguage)) {
            const uri = `file:///workspace/sample${extension}`
            // Every advertised extension must be handled by the proxy's routing…
            expect(isVueUri(uri) || isScriptLikeUri(uri), `${extension} must be routable`).toBe(true)
            // …and both sides must agree on the language id.
            expect(languageIdForUri(uri), `${extension} language id`).toBe(languageId)
        }

        expect(extensionToLanguage['.vue']).toBe('vue')
        // The code also accepts .mts/.cts/.mjs/.cjs beyond what .lsp.json advertises —
        // a known superset, checked here so the relationship never silently inverts.
        for (const extra of ['.mts', '.cts', '.mjs', '.cjs']) {
            expect(isScriptLikeUri(`file:///workspace/sample${extra}`), `${extra} superset`).toBe(true)
        }
    })
})
