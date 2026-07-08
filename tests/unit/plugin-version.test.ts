import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = process.cwd()
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json')
const PLUGIN_JSON_PATH = path.join(PROJECT_ROOT, '.claude-plugin', 'plugin.json')
const SYNC_SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'sync-plugin-version.mjs')

describe('plugin manifest version', () => {
    it('matches the package version', () => {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { version: string }
        const plugin = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8')) as { version: string }

        expect(plugin.version).toBe(pkg.version)
    })

    it('is synced by scripts/sync-plugin-version.mjs', () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-version-'))
        try {
            fs.mkdirSync(path.join(workDir, '.claude-plugin'))
            fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: 'vue-ts-lsp', version: '9.9.9' }, null, 4) + '\n')
            fs.writeFileSync(
                path.join(workDir, '.claude-plugin', 'plugin.json'),
                JSON.stringify({ name: 'vue-ts-lsp', version: '0.0.1', description: 'x' }, null, 4) + '\n'
            )

            execFileSync(process.execPath, [SYNC_SCRIPT_PATH], { cwd: workDir })

            const synced = JSON.parse(fs.readFileSync(path.join(workDir, '.claude-plugin', 'plugin.json'), 'utf8')) as {
                version: string
                description: string
            }
            expect(synced.version).toBe('9.9.9')
            expect(synced.description).toBe('x')
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true })
        }
    })

    it('runs as part of the changesets version command', () => {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { scripts: Record<string, string> }
        const releaseWorkflow = fs.readFileSync(path.join(PROJECT_ROOT, '.github', 'workflows', 'release.yml'), 'utf8')

        expect(pkg.scripts['version-packages']).toContain('changeset version')
        expect(pkg.scripts['version-packages']).toContain('sync-plugin-version.mjs')
        expect(releaseWorkflow).toContain('version: npm run version-packages')
    })
})
