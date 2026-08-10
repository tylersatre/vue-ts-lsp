import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TextDocumentSyncKind } from 'vscode-languageserver-protocol'
import type { MessageConnection } from 'vscode-jsonrpc/node'

vi.mock('node:module', () => ({
    createRequire: vi.fn(() =>
        Object.assign(vi.fn(), {
            resolve: () => '/mock/vue-language-server/dist/index.cjs'
        })
    )
}))

import * as logger from '@src/logger.js'
vi.mock('@src/logger.js', () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    setLogLevel: vi.fn(),
    closeFileLogging: vi.fn().mockResolvedValue(undefined)
}))

import { createMockConnection, createDeferred, type MockConnection } from './helpers/harness.js'

const { setupProxy } = await import('@src/proxy.js')

describe('.vue definition retry behavior', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useRealTimers()
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    it('retries .vue definitions that initially resolve to the same file', async () => {
        vi.useFakeTimers()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        const selfResult = [
            {
                uri: 'file:///workspace/App.vue',
                range: {
                    start: { line: 5, character: 6 },
                    end: { line: 5, character: 14 }
                }
            }
        ]
        const externalResult = [
            {
                uri: 'file:///workspace/node_modules/vue/dist/runtime-core.d.ts',
                range: {
                    start: { line: 100, character: 0 },
                    end: { line: 100, character: 8 }
                }
            }
        ]
        vtslsConn.sendRequest.mockResolvedValueOnce(selfResult).mockResolvedValueOnce(externalResult)

        const params = {
            textDocument: { uri: 'file:///workspace/App.vue' },
            position: { line: 0, character: 0 }
        }
        const request = upstream.triggerRequest('textDocument/definition', params)
        await vi.advanceTimersByTimeAsync(1000)

        await expect(request).resolves.toEqual(externalResult)
        expect(vtslsConn.sendRequest).toHaveBeenCalledTimes(2)
        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('retry scheduled uri=file:///workspace/App.vue'))
        vi.useRealTimers()
    })

    it('returns the original .vue definition result when retry is still self-targeted', async () => {
        vi.useFakeTimers()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        const selfResult = [
            {
                uri: 'file:///workspace/App.vue',
                range: {
                    start: { line: 5, character: 6 },
                    end: { line: 5, character: 14 }
                }
            }
        ]
        vtslsConn.sendRequest.mockResolvedValueOnce(selfResult).mockResolvedValueOnce(selfResult)

        const params = {
            textDocument: { uri: 'file:///workspace/App.vue' },
            position: { line: 0, character: 0 }
        }
        const request = upstream.triggerRequest('textDocument/definition', params)
        await vi.advanceTimersByTimeAsync(1000)

        await expect(request).resolves.toEqual(selfResult)
        expect(vtslsConn.sendRequest).toHaveBeenCalledTimes(2)
        vi.useRealTimers()
    })

    it('does not retry non-.vue definitions', async () => {
        vi.useFakeTimers()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        const emptyResult: unknown[] = []
        vtslsConn.sendRequest.mockResolvedValue(emptyResult)

        const params = {
            textDocument: { uri: 'file:///workspace/foo.ts' },
            position: { line: 0, character: 0 }
        }

        await expect(upstream.triggerRequest('textDocument/definition', params)).resolves.toEqual(emptyResult)
        expect(vtslsConn.sendRequest).toHaveBeenCalledTimes(1)
        expect(logger.debug).not.toHaveBeenCalledWith('proxy', expect.stringContaining('retry scheduled'))
        vi.useRealTimers()
    })

    it('falls back to goToSourceDefinition for .vue imports that stay self-targeted', async () => {
        vi.useFakeTimers()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: `<script setup lang="ts">\nimport { computed, ref } from 'vue'\n</script>\n`
            }
        })
        vtslsConn.sendRequest.mockClear()
        vtslsConn.sendNotification.mockClear()

        const selfResult = [
            {
                uri: 'file:///workspace/components/App.vue',
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 35 }
                }
            }
        ]
        const sourceResult = [
            {
                uri: 'file:///workspace/node_modules/%40vue/runtime-core/dist/runtime-core.esm-bundler.js',
                range: {
                    start: { line: 4015, character: 2 },
                    end: { line: 4015, character: 10 }
                }
            }
        ]
        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'textDocument/definition') {
                return selfResult
            }
            if (method === 'workspace/executeCommand') {
                const command = params as { command?: string }
                if (command.command === 'typescript.goToSourceDefinition') {
                    return sourceResult
                }
            }
            return { capabilities: {} }
        })

        const request = upstream.triggerRequest('textDocument/definition', {
            textDocument: { uri: 'file:///workspace/components/App.vue' },
            position: { line: 1, character: 9 }
        })
        await vi.advanceTimersByTimeAsync(1000)

        await expect(request).resolves.toEqual(sourceResult)
        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.goToSourceDefinition',
            arguments: ['file:///workspace/components/App.vue', { line: 1, character: 9 }]
        })
        expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith(
            'textDocument/didOpen',
            expect.objectContaining({
                textDocument: expect.objectContaining({
                    uri: expect.stringContaining('.__vue_ts_lsp__.')
                })
            })
        )
        vi.useRealTimers()
    })

    it('normalizes module-specifier positions before goToSourceDefinition fallback', async () => {
        vi.useFakeTimers()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: `<script setup lang="ts">\nimport { computed, ref } from 'vue'\n</script>\n`
            }
        })
        vtslsConn.sendRequest.mockClear()

        const sourceResult = [
            {
                uri: 'file:///workspace/node_modules/%40vue/reactivity/dist/reactivity.esm-bundler.js',
                range: {
                    start: { line: 1989, character: 436 },
                    end: { line: 1989, character: 439 }
                }
            }
        ]
        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'textDocument/definition') {
                return []
            }
            if (method === 'workspace/executeCommand') {
                const command = params as { command?: string }
                if (command.command === 'typescript.goToSourceDefinition') {
                    return sourceResult
                }
            }
            return { capabilities: {} }
        })

        const request = upstream.triggerRequest('textDocument/definition', {
            textDocument: { uri: 'file:///workspace/components/App.vue' },
            position: { line: 1, character: 29 }
        })
        await vi.advanceTimersByTimeAsync(1000)

        await expect(request).resolves.toEqual(sourceResult)
        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.goToSourceDefinition',
            arguments: ['file:///workspace/components/App.vue', { line: 1, character: 19 }]
        })
        vi.useRealTimers()
    })

    it('falls back to an internal probe document for unresolved .vue import specifiers', async () => {
        vi.useFakeTimers()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: `<script setup lang="ts">\nimport { ref } from 'vue'\n</script>\n`
            }
        })
        vtslsConn.sendRequest.mockClear()
        vtslsConn.sendNotification.mockClear()

        let appDefinitionCalls = 0
        const probeResult = [
            {
                uri: 'file:///workspace/node_modules/%40vue/runtime-core/dist/runtime-core.d.ts',
                range: {
                    start: { line: 10, character: 0 },
                    end: { line: 10, character: 3 }
                }
            }
        ]
        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'textDocument/definition') {
                const request = params as { textDocument: { uri: string } }
                if (request.textDocument.uri === 'file:///workspace/components/App.vue') {
                    appDefinitionCalls += 1
                    return []
                }
                if (request.textDocument.uri.includes('.__vue_ts_lsp__.')) {
                    return probeResult
                }
            }
            return { capabilities: {} }
        })

        const request = upstream.triggerRequest('textDocument/definition', {
            textDocument: { uri: 'file:///workspace/components/App.vue' },
            position: { line: 1, character: 9 }
        })
        await vi.advanceTimersByTimeAsync(1000)

        await expect(request).resolves.toEqual(probeResult)
        expect(appDefinitionCalls).toBe(2)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith(
            'textDocument/didOpen',
            expect.objectContaining({
                textDocument: expect.objectContaining({
                    uri: expect.stringContaining('.__vue_ts_lsp__.'),
                    languageId: 'typescript'
                })
            })
        )
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith(
            'textDocument/didClose',
            expect.objectContaining({
                textDocument: expect.objectContaining({
                    uri: expect.stringContaining('.__vue_ts_lsp__.')
                })
            })
        )
        vi.useRealTimers()
    })
})
describe('script import definition recovery', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useRealTimers()
        delete process.env.VUE_TS_LSP_DEFINITION_MIRROR_ROOT
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    afterEach(() => {
        delete process.env.VUE_TS_LSP_DEFINITION_MIRROR_ROOT
    })

    it('normalizes LocationLink definition responses into plain Locations', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/definition') {
                return [
                    {
                        targetUri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
                        targetSelectionRange: {
                            start: { line: 10, character: 4 },
                            end: { line: 10, character: 12 }
                        },
                        targetRange: {
                            start: { line: 10, character: 0 },
                            end: { line: 20, character: 0 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })

        await expect(
            upstream.triggerRequest('textDocument/definition', {
                textDocument: { uri: 'file:///workspace/src/useFeature.ts' },
                position: { line: 0, character: 0 }
            })
        ).resolves.toEqual([
            {
                uri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
                range: {
                    start: { line: 10, character: 4 },
                    end: { line: 10, character: 12 }
                }
            }
        ])
    })

    it('rewrites external-library definition targets to cache mirrors before returning upstream', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-workspace-'))
        const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-mirrors-'))
        process.env.VUE_TS_LSP_DEFINITION_MIRROR_ROOT = mirrorRoot

        try {
            const sourcePath = path.join(workspaceRoot, 'node_modules', 'vue', 'dist', 'vue.d.ts')
            fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
            fs.writeFileSync(sourcePath, 'export declare const version: string;\n')

            setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
            await upstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(workspaceRoot).href,
                workspaceFolders: [{ uri: pathToFileURL(workspaceRoot).href, name: 'workspace' }],
                capabilities: {}
            })

            vtslsConn.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'textDocument/definition') {
                    return [
                        {
                            uri: pathToFileURL(sourcePath).href,
                            range: {
                                start: { line: 0, character: 21 },
                                end: { line: 0, character: 28 }
                            }
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = await upstream.triggerRequest('textDocument/definition', {
                textDocument: {
                    uri: pathToFileURL(path.join(workspaceRoot, 'src', 'main.ts')).href
                },
                position: { line: 0, character: 0 }
            })
            const expectedMirrorPath = path.join(mirrorRoot, workspaceRoot.replace(/^\/+/, ''), 'node_modules', 'vue', 'dist', 'vue.d.__mirror.ts')

            expect(result).toEqual([
                {
                    uri: pathToFileURL(expectedMirrorPath).href,
                    range: {
                        start: { line: 0, character: 21 },
                        end: { line: 0, character: 28 }
                    }
                }
            ])
            expect(fs.existsSync(expectedMirrorPath)).toBe(true)
            expect(fs.readFileSync(expectedMirrorPath, 'utf8')).toBe('export declare const version: string;\n')
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true })
            fs.rmSync(mirrorRoot, { recursive: true, force: true })
        }
    })

    it('prefers workspace definition targets over external-library mirrors', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/definition') {
                return [
                    {
                        uri: 'file:///workspace/src/useFeature.ts',
                        range: {
                            start: { line: 40, character: 13 },
                            end: { line: 40, character: 28 }
                        }
                    },
                    {
                        uri: 'file:///workspace/node_modules/pinia/dist/pinia.d.ts',
                        range: {
                            start: { line: 650, character: 2 },
                            end: { line: 650, character: 18 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })

        await expect(
            upstream.triggerRequest('textDocument/definition', {
                textDocument: { uri: 'file:///workspace/src/view.ts' },
                position: { line: 5, character: 12 }
            })
        ).resolves.toEqual([
            {
                uri: 'file:///workspace/src/useFeature.ts',
                range: {
                    start: { line: 40, character: 13 },
                    end: { line: 40, character: 28 }
                }
            }
        ])
    })

    it('falls back to goToSourceDefinition for .ts imports that resolve to themselves', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/src/useFeature.ts',
                languageId: 'typescript',
                version: 1,
                text: `import { computed, ref } from 'vue'\n\nexport const state = ref(false)\n`
            }
        })
        vtslsConn.sendRequest.mockClear()

        const selfResult = [
            {
                uri: 'file:///workspace/src/useFeature.ts',
                range: {
                    start: { line: 0, character: 9 },
                    end: { line: 0, character: 17 }
                }
            }
        ]
        const sourceResult = [
            {
                targetUri: 'file:///workspace/node_modules/%40vue/runtime-core/dist/runtime-core.esm-bundler.js',
                targetSelectionRange: {
                    start: { line: 4015, character: 2 },
                    end: { line: 4015, character: 10 }
                },
                targetRange: {
                    start: { line: 4015, character: 0 },
                    end: { line: 4020, character: 0 }
                }
            }
        ]
        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'textDocument/definition') {
                return selfResult
            }
            if (method === 'workspace/executeCommand') {
                const command = params as { command?: string }
                if (command.command === 'typescript.goToSourceDefinition') {
                    return sourceResult
                }
            }
            return { capabilities: {} }
        })

        await expect(
            upstream.triggerRequest('textDocument/definition', {
                textDocument: { uri: 'file:///workspace/src/useFeature.ts' },
                position: { line: 0, character: 9 }
            })
        ).resolves.toEqual([
            {
                uri: 'file:///workspace/node_modules/%40vue/runtime-core/dist/runtime-core.esm-bundler.js',
                range: {
                    start: { line: 4015, character: 2 },
                    end: { line: 4015, character: 10 }
                }
            }
        ])
        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.goToSourceDefinition',
            arguments: ['file:///workspace/src/useFeature.ts', { line: 0, character: 9 }]
        })
    })
})
