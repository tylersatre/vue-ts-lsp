import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getWorkspaceConfigPath, loadWorkspaceConfig } from '@src/config.js'

const tempDirs: string[] = []

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop()!
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

function createTempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-config-'))
    tempDirs.push(dir)
    return dir
}

describe('loadWorkspaceConfig', () => {
    it('returns defaults when the config file does not exist', () => {
        const workspaceRoot = createTempWorkspace()

        expect(loadWorkspaceConfig(workspaceRoot)).toEqual({
            path: null,
            config: {
                ignoreDirectories: [],
                logLevel: null
            },
            warnings: []
        })
    })

    it('loads ignoreDirectories and logLevel from the project config file', () => {
        const workspaceRoot = createTempWorkspace()
        const configPath = getWorkspaceConfigPath(workspaceRoot)
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                ignoreDirectories: ['vendor', 'public/', './generated/cache'],
                logLevel: 'debug'
            })
        )

        expect(loadWorkspaceConfig(workspaceRoot)).toEqual({
            path: configPath,
            config: {
                ignoreDirectories: ['vendor', 'public', 'generated/cache'],
                logLevel: 'debug'
            },
            warnings: []
        })
    })

    it('ignores invalid fields and reports warnings', () => {
        const workspaceRoot = createTempWorkspace()
        const configPath = getWorkspaceConfigPath(workspaceRoot)
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                ignoreDirectories: ['vendor', 123, '', 'public'],
                logLevel: 'trace'
            })
        )

        expect(loadWorkspaceConfig(workspaceRoot)).toEqual({
            path: configPath,
            config: {
                ignoreDirectories: ['vendor', 'public'],
                logLevel: null
            },
            warnings: ['ignoreDirectories must contain only non-empty strings', 'logLevel must be one of: error, warn, info, debug']
        })
    })

    it('reports invalid JSON and falls back to defaults', () => {
        const workspaceRoot = createTempWorkspace()
        const configPath = getWorkspaceConfigPath(workspaceRoot)
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, '{ invalid json')

        expect(loadWorkspaceConfig(workspaceRoot)).toEqual({
            path: configPath,
            config: {
                ignoreDirectories: [],
                logLevel: null
            },
            warnings: [`failed to parse ${configPath}`]
        })
    })
})
