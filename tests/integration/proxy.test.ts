import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TextDocumentSyncKind } from 'vscode-languageserver-protocol'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'

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
    setLogLevel: vi.fn()
}))

const { setupProxy } = await import('@src/proxy.js')

type MockConnection = {
    sendRequest: ReturnType<typeof vi.fn>
    sendNotification: ReturnType<typeof vi.fn>
    onRequest: ReturnType<typeof vi.fn>
    onNotification: ReturnType<typeof vi.fn>
    onClose: ReturnType<typeof vi.fn>
    listen: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    triggerRequest: (method: string, params?: unknown) => Promise<unknown>
    triggerNotification: (method: string, params?: unknown) => void
    triggerClose: () => void
}

function createDeferred<T>(): {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
} {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve
        reject = innerReject
    })
    return { promise, resolve, reject }
}

function createMockConnection(): MockConnection {
    const requestHandlers = new Map<string, (params: unknown) => unknown>()
    const notificationHandlers = new Map<string, (params: unknown) => void>()
    const closeHandlers: Array<() => void> = []

    return {
        sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
        sendNotification: vi.fn(),
        onRequest: vi.fn((method: string, handler: (params: unknown) => unknown) => {
            requestHandlers.set(method, handler)
        }),
        onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
            notificationHandlers.set(method, handler)
        }),
        onClose: vi.fn((handler: () => void) => {
            closeHandlers.push(handler)
            return { dispose: () => {} }
        }),
        listen: vi.fn(),
        dispose: vi.fn(),
        triggerRequest: async (method: string, params?: unknown) => requestHandlers.get(method)?.(params),
        triggerNotification: (method: string, params?: unknown) => notificationHandlers.get(method)?.(params),
        triggerClose: () => {
            for (const handler of closeHandlers) handler()
        }
    }
}

describe('setupProxy', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection
    const callOrder: string[] = []

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(() => {
        callOrder.length = 0
        delete process.env.VUE_TS_LSP_DEFINITION_MIRROR_ROOT
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            callOrder.push(`vtsls:${method}`)
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            callOrder.push(`vueLs:${method}`)
            return { capabilities: {} }
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
    })

    afterEach(() => {
        delete process.env.VUE_TS_LSP_DEFINITION_MIRROR_ROOT
    })

    it('registers an initialize request handler on the upstream connection', () => {
        expect(upstream.onRequest).toHaveBeenCalledWith('initialize', expect.any(Function))
    })

    it('registers an initialized notification handler on the upstream connection', () => {
        expect(upstream.onNotification).toHaveBeenCalledWith('initialized', expect.any(Function))
    })

    it('calls listen() on both child connections', () => {
        expect(vtslsConn.listen).toHaveBeenCalled()
        expect(vueLsConn.listen).toHaveBeenCalled()
    })

    it('initializes vtsls before vue_ls', async () => {
        await upstream.triggerRequest('initialize', initParams)

        const vtslsIdx = callOrder.indexOf('vtsls:initialize')
        const vueLsIdx = callOrder.indexOf('vueLs:initialize')
        expect(vtslsIdx).toBeGreaterThanOrEqual(0)
        expect(vueLsIdx).toBeGreaterThan(vtslsIdx)
    })

    it('sends vtsls initialize with correct rootUri and workspaceFolders', async () => {
        await upstream.triggerRequest('initialize', initParams)

        const [method, params] = vtslsConn.sendRequest.mock.calls[0] as [string, Record<string, unknown>]
        expect(method).toBe('initialize')
        expect(params['rootUri']).toBe('file:///workspace')
        expect(params['workspaceFolders']).toEqual(initParams.workspaceFolders)
    })

    it('sends vtsls initialize with @vue/typescript-plugin globalPlugin', async () => {
        await upstream.triggerRequest('initialize', initParams)

        const [, params] = vtslsConn.sendRequest.mock.calls[0] as [string, Record<string, unknown>]
        const settings = (params['initializationOptions'] as Record<string, unknown>)['settings'] as Record<string, unknown>
        const vtsls = settings['vtsls'] as Record<string, unknown>
        expect(vtsls['autoUseWorkspaceTsdk']).toBe(true)

        const tsserver = vtsls['tsserver'] as Record<string, unknown>
        const plugins = tsserver['globalPlugins'] as Array<Record<string, unknown>>
        expect(plugins).toHaveLength(1)
        expect(plugins[0]['name']).toBe('@vue/typescript-plugin')
        expect(plugins[0]['location']).toBe('/mock/vue-language-server/dist')
        expect(plugins[0]['languages']).toEqual(['vue'])
    })

    it('sends vue_ls initialize with correct rootUri and workspaceFolders', async () => {
        await upstream.triggerRequest('initialize', initParams)

        const [method, params] = vueLsConn.sendRequest.mock.calls[0] as [string, Record<string, unknown>]
        expect(method).toBe('initialize')
        expect(params['rootUri']).toBe('file:///workspace')
        expect(params['workspaceFolders']).toEqual(initParams.workspaceFolders)
    })

    it('sends vue_ls initialize with hybridMode: true', async () => {
        await upstream.triggerRequest('initialize', initParams)

        const [, params] = vueLsConn.sendRequest.mock.calls[0] as [string, Record<string, unknown>]
        const initOptions = params['initializationOptions'] as Record<string, unknown>
        const vue = initOptions['vue'] as Record<string, unknown>
        expect(vue['hybridMode']).toBe(true)
    })

    it('returns merged capabilities to Claude Code', async () => {
        const result = (await upstream.triggerRequest('initialize', initParams)) as Record<string, unknown>
        const caps = result['capabilities'] as Record<string, unknown>
        expect(caps['textDocumentSync']).toBe(TextDocumentSyncKind.Incremental)
        expect(caps['definitionProvider']).toBe(true)
        expect(caps['implementationProvider']).toBe(true)
        expect(caps['hoverProvider']).toBe(true)
        expect(caps['documentSymbolProvider']).toBe(true)
        expect(caps['referencesProvider']).toBe(true)
        expect(caps['workspaceSymbolProvider']).toBe(true)
        expect(caps['callHierarchyProvider']).toBe(true)
    })

    it('forwards initialized notification to both child servers', () => {
        upstream.triggerNotification('initialized', {})

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('initialized', {})
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('initialized', {})
    })

    it('registers tsserver/request handler on vue_ls after initialization', async () => {
        await upstream.triggerRequest('initialize', initParams)

        expect(vueLsConn.onNotification).toHaveBeenCalledWith('tsserver/request', expect.any(Function))
    })
})

describe('tsserver/request forwarding', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(() => {
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
    })

    it('forwards flat tsserver/request payloads to vtsls as workspace/executeCommand', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'workspace/executeCommand') return { body: { result: 'data' } }
            return { capabilities: {} }
        })

        await upstream.triggerRequest('initialize', initParams)
        vueLsConn.triggerNotification('tsserver/request', [42, 'getDefinition', { file: 'test.vue' }])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.tsserverRequest',
            arguments: ['getDefinition', { file: 'test.vue' }]
        })
    })

    it('keeps compatibility with nested tsserver/request payloads', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'workspace/executeCommand') return { body: { result: 'data' } }
            return { capabilities: {} }
        })

        await upstream.triggerRequest('initialize', initParams)
        vueLsConn.triggerNotification('tsserver/request', [[42, 'getDefinition', { file: 'test.vue' }]])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.tsserverRequest',
            arguments: ['getDefinition', { file: 'test.vue' }]
        })
    })

    it('sends tsserver/response with body in the flat shape on success', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'workspace/executeCommand') return { body: { result: 'data' } }
            return { capabilities: {} }
        })

        await upstream.triggerRequest('initialize', initParams)
        vueLsConn.triggerNotification('tsserver/request', [42, 'getDefinition', { file: 'test.vue' }])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('tsserver/response', [42, { result: 'data' }])
    })

    it('sends tsserver/response with null body on vtsls error', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'workspace/executeCommand') throw new Error('executeCommand failed')
            return { capabilities: {} }
        })

        await upstream.triggerRequest('initialize', initParams)
        vueLsConn.triggerNotification('tsserver/request', [99, 'quickInfo', {}])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('tsserver/response', [99, null])
    })

    it('sends tsserver/response with null body when response is null', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'workspace/executeCommand') return null
            return { capabilities: {} }
        })

        await upstream.triggerRequest('initialize', initParams)
        vueLsConn.triggerNotification('tsserver/request', [55, 'completions', {}])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('tsserver/response', [55, null])
    })

    it('sends tsserver/response with null body when response has no body', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'workspace/executeCommand') return {}
            return { capabilities: {} }
        })

        await upstream.triggerRequest('initialize', initParams)
        vueLsConn.triggerNotification('tsserver/request', [7, '_vue:getComponentMeta', { fileName: 'App.vue' }])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('tsserver/response', [7, null])
    })

    it('responds with null for malformed tsserver/request payloads when an id is present', async () => {
        await upstream.triggerRequest('initialize', initParams)

        vueLsConn.triggerNotification('tsserver/request', [42, { bad: true }, {}])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vtslsConn.sendRequest).not.toHaveBeenCalledWith('workspace/executeCommand', expect.anything())
        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('invalid payload'))
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('tsserver/response', [42, null])
    })

    it('warns and drops tsserver/request payloads that do not include a recoverable id', async () => {
        await upstream.triggerRequest('initialize', initParams)

        vueLsConn.triggerNotification('tsserver/request', { bad: true })
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vtslsConn.sendRequest).not.toHaveBeenCalledWith('workspace/executeCommand', expect.anything())
        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('invalid payload'))
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('tsserver/response', expect.anything())
    })

    it('swallows disposed vue_ls connection errors when sending tsserver/response', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'workspace/executeCommand') return { body: { ok: true } }
            return { capabilities: {} }
        })
        vueLsConn.sendNotification.mockImplementation(() => {
            throw new Error('Connection is disposed.')
        })

        await upstream.triggerRequest('initialize', initParams)
        vueLsConn.triggerNotification('tsserver/request', [88, 'quickInfo', {}])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('tsserver/response #88 dropped'))
    })
})

describe('document synchronization forwarding', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection
    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(() => {
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
    })

    it('forwards didOpen for .ts file to vtsls only', () => {
        const params = {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: 'const x = 1;'
            }
        }
        upstream.triggerNotification('textDocument/didOpen', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('forwards didOpen for .js file to vtsls only', () => {
        const params = {
            textDocument: {
                uri: 'file:///foo.js',
                languageId: 'javascript',
                version: 1,
                text: ''
            }
        }
        upstream.triggerNotification('textDocument/didOpen', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('forwards didOpen for .tsx file to vtsls only', () => {
        const params = {
            textDocument: {
                uri: 'file:///App.tsx',
                languageId: 'typescriptreact',
                version: 1,
                text: ''
            }
        }
        upstream.triggerNotification('textDocument/didOpen', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('forwards didOpen for .jsx file to vtsls only', () => {
        const params = {
            textDocument: {
                uri: 'file:///App.jsx',
                languageId: 'javascriptreact',
                version: 1,
                text: ''
            }
        }
        upstream.triggerNotification('textDocument/didOpen', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('forwards didOpen for .vue file to both servers', () => {
        const params = {
            textDocument: {
                uri: 'file:///App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template/>'
            }
        }
        upstream.triggerNotification('textDocument/didOpen', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', params)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', params)
    })

    it('primes Vue project info on didOpen for .vue files after a short delay', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">const count = 1</script>'
            }
        })
        await vi.advanceTimersByTimeAsync(250)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.tsserverRequest',
            arguments: [
                '_vue:projectInfo',
                {
                    file: '/workspace/components/App.vue',
                    needFileNameList: false
                },
                {
                    isAsync: true,
                    lowPriority: true
                }
            ]
        })
        vi.useRealTimers()
    })

    it('forwards didChange for .ts file to vtsls only', () => {
        const params = {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: 'const x = 2;' }]
        }
        upstream.triggerNotification('textDocument/didChange', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didChange', expect.anything())
    })

    it('forwards didChange for .vue file to both servers', () => {
        const params = {
            textDocument: { uri: 'file:///App.vue', version: 2 },
            contentChanges: [{ text: '<template><div/></template>' }]
        }
        upstream.triggerNotification('textDocument/didChange', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', params)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', params)
    })

    it('nudges Vue diagnostics with a debounced geterr request after didChange', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template><div>{{ count }}</div></template>\n<script setup lang="ts">const count = 1</script>'
            }
        })
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/components/App.vue', version: 2 },
            contentChanges: [{ text: '<template><div>{{ count +  }}</div></template>' }]
        })
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/components/App.vue', version: 3 },
            contentChanges: [{ text: '<template><div>{{ count + 1 }}</div></template>' }]
        })
        await vi.advanceTimersByTimeAsync(150)

        expect(vtslsConn.sendRequest).toHaveBeenCalledTimes(1)
        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.tsserverRequest',
            arguments: [
                'geterr',
                {
                    delay: 0,
                    files: ['/workspace/components/App.vue']
                },
                {
                    isAsync: true,
                    lowPriority: true
                }
            ]
        })

        vi.useRealTimers()
    })

    it('nudges script diagnostics with a debounced geterr request after didChange', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/stores/estimates.ts',
                languageId: 'typescript',
                version: 1,
                text: 'export const count = 1\n'
            }
        })
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: {
                uri: 'file:///workspace/stores/estimates.ts',
                version: 2
            },
            contentChanges: [{ text: 'export const count: string = 1\n' }]
        })
        await vi.advanceTimersByTimeAsync(100)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.tsserverRequest',
            arguments: [
                'geterr',
                {
                    delay: 0,
                    files: ['/workspace/stores/estimates.ts']
                },
                {
                    isAsync: true,
                    lowPriority: true
                }
            ]
        })

        vi.useRealTimers()
    })

    it('includes open script and Vue files in script diagnostics nudges for cross-file propagation', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/stores/estimates.ts',
                languageId: 'typescript',
                version: 1,
                text: 'export const count = 1\n'
            }
        })
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/LoanAmount.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">\nconst amount = count\n</script>\n'
            }
        })
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/stores/totals.ts',
                languageId: 'typescript',
                version: 1,
                text: 'export const total = count\n'
            }
        })
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/PropertyDetails.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">\nconst value = count\n</script>\n'
            }
        })
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: {
                uri: 'file:///workspace/stores/estimates.ts',
                version: 2
            },
            contentChanges: [{ text: 'export const count: string = 1\n' }]
        })
        await vi.advanceTimersByTimeAsync(100)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.tsserverRequest',
            arguments: [
                'geterr',
                {
                    delay: 0,
                    files: [
                        '/workspace/stores/estimates.ts',
                        '/workspace/components/LoanAmount.vue',
                        '/workspace/stores/totals.ts',
                        '/workspace/components/PropertyDetails.vue'
                    ]
                },
                {
                    isAsync: true,
                    lowPriority: true
                }
            ]
        })

        vi.useRealTimers()
    })

    it('nudges dependent caller files after script edits using changed-symbol references', async () => {
        vi.useFakeTimers()
        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/references') {
                return [
                    {
                        uri: 'file:///workspace/pinia/estimates.ts',
                        range: {
                            start: { line: 12, character: 4 },
                            end: { line: 12, character: 33 }
                        }
                    },
                    {
                        uri: 'file:///workspace/components/fees/LenderFeeTester.vue',
                        range: {
                            start: { line: 24, character: 10 },
                            end: { line: 24, character: 39 }
                        }
                    }
                ]
            }
            if (method === 'workspace/executeCommand') return { body: null }
            return { capabilities: {} }
        })
        await upstream.triggerRequest('initialize', initParams)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/helpers/fees.ts',
                languageId: 'typescript',
                version: 1,
                text: 'export function modifySingleFeeUsingConditions(loanAmount: number) {\n  return loanAmount\n}\n'
            }
        })
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/helpers/fees.ts', version: 2 },
            contentChanges: [
                {
                    text: 'export function modifySingleFeeUsingConditions(loanAmount: boolean) {\n  return loanAmount\n}\n'
                }
            ]
        })

        await vi.runAllTimersAsync()
        await Promise.resolve()

        expect(vtslsConn.sendRequest.mock.calls.filter(([method]) => method === 'textDocument/references')).toEqual([
            [
                'textDocument/references',
                {
                    textDocument: { uri: 'file:///workspace/helpers/fees.ts' },
                    position: { line: 0, character: 16 },
                    context: { includeDeclaration: false }
                }
            ]
        ])

        expect(vtslsConn.sendRequest.mock.calls.filter(([method]) => method === 'workspace/executeCommand')).toEqual([
            [
                'workspace/executeCommand',
                {
                    command: 'typescript.tsserverRequest',
                    arguments: [
                        'geterr',
                        {
                            delay: 0,
                            files: ['/workspace/helpers/fees.ts']
                        },
                        {
                            isAsync: true,
                            lowPriority: true
                        }
                    ]
                }
            ],
            [
                'workspace/executeCommand',
                {
                    command: 'typescript.tsserverRequest',
                    arguments: [
                        'geterr',
                        {
                            delay: 0,
                            files: ['/workspace/helpers/fees.ts', '/workspace/pinia/estimates.ts', '/workspace/components/fees/LenderFeeTester.vue']
                        },
                        {
                            isAsync: true,
                            lowPriority: true
                        }
                    ]
                }
            ]
        ])

        vi.useRealTimers()
    })

    it('uses module importers before broad identifier scans for exported helper functions', async () => {
        vi.useFakeTimers()
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-importer-fallback-fees-'))
        const workspaceUri = pathToFileURL(tempWorkspace).href
        const helperPath = path.join(tempWorkspace, 'helpers', 'fees.ts')
        const importerPath = path.join(tempWorkspace, 'pinia', 'estimates.ts')
        const noisePath = path.join(tempWorkspace, 'components', 'siteadmin', 'ImportBranches.vue')
        fs.mkdirSync(path.dirname(helperPath), { recursive: true })
        fs.mkdirSync(path.dirname(importerPath), { recursive: true })
        fs.mkdirSync(path.dirname(noisePath), { recursive: true })
        fs.writeFileSync(helperPath, 'export function modifySingleFeeUsingConditions(loanAmount: number) {\n  return loanAmount\n}\n')
        fs.writeFileSync(
            importerPath,
            "import { modifySingleFeeUsingConditions } from '../helpers/fees'\n\nexport const preview = modifySingleFeeUsingConditions(42)\n"
        )
        fs.writeFileSync(
            noisePath,
            '<script setup lang="ts">\nconst modifySingleFeeUsingConditions = (value: string) => value\nmodifySingleFeeUsingConditions(\'noise\')\n</script>\n'
        )

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/references') {
                    return []
                }
                if (method === 'workspace/executeCommand') return { body: null }
                return { capabilities: {} }
            })

            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)
            await localUpstream.triggerRequest('initialize', {
                rootUri: workspaceUri,
                workspaceFolders: [{ uri: workspaceUri, name: 'workspace' }],
                capabilities: {}
            })

            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(helperPath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(helperPath, 'utf8')
                }
            })
            localVtsls.sendRequest.mockClear()

            localUpstream.triggerNotification('textDocument/didChange', {
                textDocument: { uri: pathToFileURL(helperPath).href, version: 2 },
                contentChanges: [
                    {
                        text: 'export function modifySingleFeeUsingConditions(loanAmount: boolean) {\n  return loanAmount\n}\n'
                    }
                ]
            })

            await vi.runAllTimersAsync()
            await Promise.resolve()

            expect(localVtsls.sendRequest.mock.calls.filter(([method]) => method === 'workspace/executeCommand')).toEqual([
                [
                    'workspace/executeCommand',
                    {
                        command: 'typescript.tsserverRequest',
                        arguments: [
                            'geterr',
                            {
                                delay: 0,
                                files: [helperPath]
                            },
                            {
                                isAsync: true,
                                lowPriority: true
                            }
                        ]
                    }
                ],
                [
                    'workspace/executeCommand',
                    {
                        command: 'typescript.tsserverRequest',
                        arguments: [
                            'geterr',
                            {
                                delay: 0,
                                files: [helperPath, importerPath]
                            },
                            {
                                isAsync: true,
                                lowPriority: true
                            }
                        ]
                    }
                ]
            ])
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
            vi.useRealTimers()
        }
    })

    it('uses module importers before broad identifier scans for store action diagnostics', async () => {
        vi.useFakeTimers()
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-importer-fallback-ui-'))
        const workspaceUri = pathToFileURL(tempWorkspace).href
        const storePath = path.join(tempWorkspace, 'pinia', 'ui.ts')
        const importerPath = path.join(tempWorkspace, 'components', 'ProgressBar.vue')
        const noisePath = path.join(tempWorkspace, 'components', 'siteadmin', 'ImportBranches.vue')
        const assetPath = path.join(tempWorkspace, 'tests-playwright', 'playwright-report', 'trace', 'assets', 'codeMirrorModule.js')
        fs.mkdirSync(path.dirname(storePath), { recursive: true })
        fs.mkdirSync(path.dirname(importerPath), { recursive: true })
        fs.mkdirSync(path.dirname(noisePath), { recursive: true })
        fs.mkdirSync(path.dirname(assetPath), { recursive: true })
        fs.writeFileSync(
            storePath,
            "export const useUiStore = () => {\n  const goToTab = function (slug: 'details' | 'payment' | 'estimate') {\n    return slug\n  }\n\n  return {\n    goToTab,\n  }\n}\n"
        )
        fs.writeFileSync(
            importerPath,
            '<template>\n  <button @click="uiStore.goToTab(\'estimate\')">Estimate</button>\n</template>\n\n<script setup lang="ts">\nimport { useUiStore } from \'../pinia/ui\'\nconst uiStore = useUiStore()\n</script>\n'
        )
        fs.writeFileSync(noisePath, '<script setup lang="ts">\nconst goToTab = (value: string) => value\ngoToTab(\'archive\')\n</script>\n')
        fs.writeFileSync(assetPath, "export function goToTab(value) { return value }\ngoToTab('noise')\n")

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/references') {
                    return []
                }
                if (method === 'workspace/executeCommand') return { body: null }
                return { capabilities: {} }
            })

            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)
            await localUpstream.triggerRequest('initialize', {
                rootUri: workspaceUri,
                workspaceFolders: [{ uri: workspaceUri, name: 'workspace' }],
                capabilities: {}
            })

            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(storePath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(storePath, 'utf8')
                }
            })
            localVtsls.sendRequest.mockClear()

            localUpstream.triggerNotification('textDocument/didChange', {
                textDocument: { uri: pathToFileURL(storePath).href, version: 2 },
                contentChanges: [
                    {
                        text: "export const useUiStore = () => {\n  const goToTab = function (slug: 'details' | 'payment') {\n    return slug\n  }\n\n  return {\n    goToTab,\n  }\n}\n"
                    }
                ]
            })

            await vi.runAllTimersAsync()
            await Promise.resolve()

            expect(localVtsls.sendRequest.mock.calls.filter(([method]) => method === 'workspace/executeCommand')).toEqual([
                [
                    'workspace/executeCommand',
                    {
                        command: 'typescript.tsserverRequest',
                        arguments: [
                            'geterr',
                            {
                                delay: 0,
                                files: [storePath]
                            },
                            {
                                isAsync: true,
                                lowPriority: true
                            }
                        ]
                    }
                ],
                [
                    'workspace/executeCommand',
                    {
                        command: 'typescript.tsserverRequest',
                        arguments: [
                            'geterr',
                            {
                                delay: 0,
                                files: [storePath, importerPath]
                            },
                            {
                                isAsync: true,
                                lowPriority: true
                            }
                        ]
                    }
                ]
            ])
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
            vi.useRealTimers()
        }
    })

    it('applies ignoreDirectories from .claude/vue-ts-lsp.json to workspace fallback scans', async () => {
        vi.useFakeTimers()
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-ignore-dirs-'))
        const workspaceUri = pathToFileURL(tempWorkspace).href
        const storePath = path.join(tempWorkspace, 'pinia', 'ui.ts')
        const componentPath = path.join(tempWorkspace, 'components', 'ProgressBar.vue')
        const publicPath = path.join(tempWorkspace, 'public', 'app.js')
        const vendorPath = path.join(tempWorkspace, 'vendor', 'bundle.js')
        const configPath = path.join(tempWorkspace, '.claude', 'vue-ts-lsp.json')
        fs.mkdirSync(path.dirname(storePath), { recursive: true })
        fs.mkdirSync(path.dirname(componentPath), { recursive: true })
        fs.mkdirSync(path.dirname(publicPath), { recursive: true })
        fs.mkdirSync(path.dirname(vendorPath), { recursive: true })
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                ignoreDirectories: ['public', 'vendor']
            })
        )
        fs.writeFileSync(storePath, 'export function currentTab(tab: number) {\n  return tab\n}\n')
        fs.writeFileSync(componentPath, '<script setup lang="ts">\nconst value = currentTab(1)\n</script>\n')
        fs.writeFileSync(publicPath, 'export const value = currentTab(2)\n')
        fs.writeFileSync(vendorPath, 'export const value = currentTab(3)\n')

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/references') {
                    return []
                }
                if (method === 'workspace/executeCommand') return { body: null }
                return { capabilities: {} }
            })

            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)
            await localUpstream.triggerRequest('initialize', {
                rootUri: workspaceUri,
                workspaceFolders: [{ uri: workspaceUri, name: 'workspace' }],
                capabilities: {}
            })

            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(storePath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(storePath, 'utf8')
                }
            })
            localVtsls.sendRequest.mockClear()

            localUpstream.triggerNotification('textDocument/didChange', {
                textDocument: { uri: pathToFileURL(storePath).href, version: 2 },
                contentChanges: [
                    {
                        text: 'export function currentTab(tab: boolean) {\n  return tab\n}\n'
                    }
                ]
            })

            await vi.runAllTimersAsync()
            await Promise.resolve()

            expect(localVtsls.sendRequest.mock.calls.filter(([method]) => method === 'workspace/executeCommand')).toEqual([
                [
                    'workspace/executeCommand',
                    {
                        command: 'typescript.tsserverRequest',
                        arguments: [
                            'geterr',
                            {
                                delay: 0,
                                files: [storePath]
                            },
                            {
                                isAsync: true,
                                lowPriority: true
                            }
                        ]
                    }
                ],
                [
                    'workspace/executeCommand',
                    {
                        command: 'typescript.tsserverRequest',
                        arguments: [
                            'geterr',
                            {
                                delay: 0,
                                files: [storePath, componentPath]
                            },
                            {
                                isAsync: true,
                                lowPriority: true
                            }
                        ]
                    }
                ]
            ])
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
            vi.useRealTimers()
        }
    })

    it('applies config-file logLevel when no CLI override is provided', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-config-log-level-'))
        const configPath = path.join(tempWorkspace, '.claude', 'vue-ts-lsp.json')
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, JSON.stringify({ logLevel: 'debug' }))

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)
            vi.mocked(logger.setLogLevel).mockClear()

            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })

            expect(vi.mocked(logger.setLogLevel)).toHaveBeenCalledWith('debug')
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('does not let config-file logLevel override an explicit CLI log level', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-cli-log-level-'))
        const configPath = path.join(tempWorkspace, '.claude', 'vue-ts-lsp.json')
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, JSON.stringify({ logLevel: 'debug' }))

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection, {
                cliLogLevel: 'warn'
            })
            vi.mocked(logger.setLogLevel).mockClear()

            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })

            expect(vi.mocked(logger.setLogLevel)).not.toHaveBeenCalled()
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('skips dependent caller nudges when changed-symbol references stay within the edited file', async () => {
        vi.useFakeTimers()
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/references') {
                return [
                    {
                        uri: 'file:///workspace/helpers/fees.ts',
                        range: {
                            start: { line: 0, character: 16 },
                            end: { line: 0, character: 45 }
                        }
                    }
                ]
            }
            if (method === 'workspace/executeCommand') return { body: null }
            return { capabilities: {} }
        })
        await upstream.triggerRequest('initialize', initParams)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/helpers/fees.ts',
                languageId: 'typescript',
                version: 1,
                text: 'export function modifySingleFeeUsingConditions(loanAmount: number) {\n  return loanAmount\n}\n'
            }
        })
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/helpers/fees.ts', version: 2 },
            contentChanges: [
                {
                    text: 'export function modifySingleFeeUsingConditions(loanAmount: boolean) {\n  return loanAmount\n}\n'
                }
            ]
        })

        await vi.runAllTimersAsync()
        await Promise.resolve()

        expect(vtslsConn.sendRequest.mock.calls.filter(([method]) => method === 'workspace/executeCommand')).toEqual([
            [
                'workspace/executeCommand',
                {
                    command: 'typescript.tsserverRequest',
                    arguments: [
                        'geterr',
                        {
                            delay: 0,
                            files: ['/workspace/helpers/fees.ts']
                        },
                        {
                            isAsync: true,
                            lowPriority: true
                        }
                    ]
                }
            ]
        ])

        vi.useRealTimers()
    })

    it('waits for active foreground Vue requests before sending a diagnostics nudge', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)

        const pendingHover = createDeferred<unknown>()
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') return pendingHover.promise
            if (method === 'workspace/executeCommand') return { body: null }
            return { capabilities: {} }
        })

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template><div>{{ count }}</div></template>\n<script setup lang="ts">const count = 1</script>'
            }
        })
        vtslsConn.sendRequest.mockClear()

        const hoverRequest = upstream.triggerRequest('textDocument/hover', {
            textDocument: { uri: 'file:///workspace/components/App.vue' },
            position: { line: 0, character: 18 }
        })
        await Promise.resolve()

        try {
            upstream.triggerNotification('textDocument/didChange', {
                textDocument: {
                    uri: 'file:///workspace/components/App.vue',
                    version: 2
                },
                contentChanges: [{ text: '<template><div>{{ count + 1 }}</div></template>' }]
            })
            await vi.advanceTimersByTimeAsync(150)

            expect(vtslsConn.sendRequest.mock.calls.filter(([method]) => method === 'workspace/executeCommand')).toHaveLength(0)

            pendingHover.resolve({ contents: 'hover info' })
            await hoverRequest
            await vi.advanceTimersByTimeAsync(100)

            expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
                command: 'typescript.tsserverRequest',
                arguments: [
                    'geterr',
                    {
                        delay: 0,
                        files: ['/workspace/components/App.vue']
                    },
                    {
                        isAsync: true,
                        lowPriority: true
                    }
                ]
            })
        } finally {
            pendingHover.resolve({ contents: 'hover info' })
            await hoverRequest.catch(() => undefined)
            vi.useRealTimers()
        }
    })

    it('skips a Vue diagnostics nudge when fresh vtsls diagnostics already arrived after didChange', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template><div>{{ count }}</div></template>\n<script setup lang="ts">const count = 1</script>'
            }
        })
        vtslsConn.sendRequest.mockClear()

        try {
            upstream.triggerNotification('textDocument/didChange', {
                textDocument: {
                    uri: 'file:///workspace/components/App.vue',
                    version: 2
                },
                contentChanges: [{ text: '<template><div>{{ count + 1 }}</div></template>' }]
            })

            await vi.advanceTimersByTimeAsync(100)
            vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
                uri: 'file:///workspace/components/App.vue',
                diagnostics: []
            })
            await vi.advanceTimersByTimeAsync(100)

            expect(vtslsConn.sendRequest.mock.calls.filter(([method]) => method === 'workspace/executeCommand')).toHaveLength(0)
            expect(logger.debug).toHaveBeenCalledWith(
                'proxy',
                expect.stringContaining('textDocument/didChange file:///workspace/components/App.vue diagnostics nudge skipped reason=fresh-vtsls-diagnostics')
            )
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not restart vtsls when a background diagnostics nudge times out', async () => {
        vi.useFakeTimers()
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()
        const pending = createDeferred<unknown>()

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'workspace/executeCommand') return pending.promise
            return { capabilities: {} }
        })
        newVtsls.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            return { capabilities: {} }
        })

        const killVtsls = vi.fn(() => {
            vtslsConn.triggerClose()
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: () => newVtsls as unknown as MessageConnection,
            killVtsls,
            delayMs: 0,
            requestTimeoutMs: 25
        })
        await upstream.triggerRequest('initialize', initParams)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template><div>{{ count }}</div></template>\n<script setup lang="ts">const count = 1</script>'
            }
        })

        try {
            upstream.triggerNotification('textDocument/didChange', {
                textDocument: {
                    uri: 'file:///workspace/components/App.vue',
                    version: 2
                },
                contentChanges: [{ text: '<template><div>{{ count + 1 }}</div></template>' }]
            })

            await vi.advanceTimersByTimeAsync(500)
            await Promise.resolve()

            expect(killVtsls).not.toHaveBeenCalled()
            expect(logger.warn).toHaveBeenCalledWith(
                'proxy',
                expect.stringContaining(
                    'textDocument/didChange file:///workspace/components/App.vue vue diagnostics nudge command=geterr ERROR: vtsls workspace/executeCommand timed out after 25ms'
                )
            )
        } finally {
            pending.resolve({ body: null })
            vi.useRealTimers()
        }
    })

    it('forwards didClose for .ts file to vtsls only', () => {
        const params = { textDocument: { uri: 'file:///foo.ts' } }
        upstream.triggerNotification('textDocument/didClose', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didClose', expect.anything())
    })

    it('forwards didClose for .vue file to both servers', () => {
        const params = { textDocument: { uri: 'file:///App.vue' } }
        upstream.triggerNotification('textDocument/didClose', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', params)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', params)
    })

    it('forwards didSave for .ts file to vtsls only', () => {
        const params = { textDocument: { uri: 'file:///foo.ts' } }
        upstream.triggerNotification('textDocument/didSave', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didSave', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didSave', expect.anything())
    })

    it('forwards didSave for .vue file to both servers', () => {
        const params = { textDocument: { uri: 'file:///App.vue' } }
        upstream.triggerNotification('textDocument/didSave', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didSave', params)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didSave', params)
    })

    it('forwards publishDiagnostics from vtsls to upstream immediately', () => {
        const params = {
            uri: 'file:///foo.ts',
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 5 }
                    },
                    message: 'Error'
                }
            ]
        }
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', params)

        expect(upstream.sendNotification).toHaveBeenCalledWith('textDocument/publishDiagnostics', params)
        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('publishDiagnostics vtsls uri=file:///foo.ts count=1'))
    })

    it('forwards publishDiagnostics from vue_ls to upstream immediately', () => {
        const params = {
            uri: 'file:///App.vue',
            diagnostics: [
                {
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 1, character: 8 }
                    },
                    message: 'Vue error'
                }
            ]
        }
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', params)

        expect(upstream.sendNotification).toHaveBeenCalledWith('textDocument/publishDiagnostics', params)
    })

    it('forwards empty diagnostics array from vtsls immediately', () => {
        const params = { uri: 'file:///foo.ts', diagnostics: [] }
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', params)

        expect(upstream.sendNotification).toHaveBeenCalledWith('textDocument/publishDiagnostics', params)
    })

    it('forwards empty diagnostics array from vue_ls immediately', () => {
        const params = { uri: 'file:///App.vue', diagnostics: [] }
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', params)

        expect(upstream.sendNotification).toHaveBeenCalledWith('textDocument/publishDiagnostics', params)
    })

    it('forwards rapid diagnostics updates for the same URI upstream in order', () => {
        const staleParams = {
            uri: 'file:///foo.ts',
            diagnostics: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 5 }
                    },
                    message: 'Stale'
                }
            ]
        }
        const clearedParams = { uri: 'file:///foo.ts', diagnostics: [] }
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', staleParams)
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', clearedParams)

        expect(upstream.sendNotification).toHaveBeenNthCalledWith(1, 'textDocument/publishDiagnostics', staleParams)
        expect(upstream.sendNotification).toHaveBeenNthCalledWith(2, 'textDocument/publishDiagnostics', clearedParams)
    })

    it('merges diagnostics from both servers for .vue files immediately on the latest publish', () => {
        const vtslsDiag = {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 }
            },
            message: 'TS error'
        }
        const vueLsDiag = {
            range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 8 }
            },
            message: 'Vue error'
        }
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [vtslsDiag]
        })
        upstream.sendNotification.mockClear()

        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [vueLsDiag]
        })

        expect(upstream.sendNotification).toHaveBeenCalledWith('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: expect.arrayContaining([vtslsDiag, vueLsDiag])
        })
        const call = upstream.sendNotification.mock.calls[0] as [string, { uri: string; diagnostics: unknown[] }]
        expect(call[1].diagnostics).toHaveLength(2)
        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('publishDiagnostics vue_ls uri=file:///App.vue count=1 merged=2'))
    })

    it('deduplicates identical diagnostics from both servers for .vue files', () => {
        const diag = {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 }
            },
            message: 'Duplicate'
        }
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [diag]
        })
        upstream.sendNotification.mockClear()

        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [diag]
        })

        const call = upstream.sendNotification.mock.calls[0] as [string, { uri: string; diagnostics: unknown[] }]
        expect(call[1].diagnostics).toHaveLength(1)
    })

    it('clearing one server diagnostics re-merges for .vue files', () => {
        const vtslsDiag = {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 }
            },
            message: 'TS error'
        }
        const vueLsDiag = {
            range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 8 }
            },
            message: 'Vue error'
        }
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [vtslsDiag]
        })
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [vueLsDiag]
        })
        upstream.sendNotification.mockClear()

        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: []
        })

        const call = upstream.sendNotification.mock.calls[0] as [string, { uri: string; diagnostics: unknown[] }]
        expect(call[1].diagnostics).toEqual([vueLsDiag])
    })

    it('store is populated on didOpen', () => {
        const store = setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        const params = {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: 'const x = 1;'
            }
        }
        upstream.triggerNotification('textDocument/didOpen', params)
        expect(store.get('file:///foo.ts')).toEqual({
            content: 'const x = 1;',
            version: 1,
            languageId: 'typescript'
        })
    })

    it('store is updated on didChange', () => {
        const store = setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: 'const x = 1;'
            }
        })
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: 'const x = 2;' }]
        })
        expect(store.get('file:///foo.ts')).toEqual({
            content: 'const x = 2;',
            version: 2,
            languageId: 'typescript'
        })
    })

    it('store removes entry on didClose', () => {
        const store = setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: ''
            }
        })
        upstream.triggerNotification('textDocument/didClose', {
            textDocument: { uri: 'file:///foo.ts' }
        })
        expect(store.get('file:///foo.ts')).toBeUndefined()
    })
})

describe('LSP request forwarding', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(() => {
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
    })

    it('registers request handlers for all declared capability methods', () => {
        const registeredMethods = (upstream.onRequest.mock.calls as [string, unknown][]).map(([method]) => method)
        for (const method of [
            'textDocument/definition',
            'textDocument/implementation',
            'textDocument/hover',
            'textDocument/references',
            'textDocument/documentSymbol',
            'workspace/symbol',
            'textDocument/prepareCallHierarchy',
            'callHierarchy/incomingCalls',
            'callHierarchy/outgoingCalls'
        ]) {
            expect(registeredMethods).toContain(method)
        }
    })

    it('forwards textDocument/definition for .ts file to vtsls', async () => {
        const params = {
            textDocument: { uri: 'file:///foo.ts' },
            position: { line: 0, character: 5 }
        }
        vtslsConn.sendRequest.mockResolvedValue({
            uri: 'file:///bar.ts',
            range: {}
        })

        const result = await upstream.triggerRequest('textDocument/definition', params)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/definition', params)
        expect(result).toEqual({ uri: 'file:///bar.ts', range: {} })
    })

    it('forwards textDocument/hover for .vue file to vtsls', async () => {
        const params = {
            textDocument: { uri: 'file:///App.vue' },
            position: { line: 1, character: 3 }
        }
        vtslsConn.sendRequest.mockResolvedValue({ contents: 'hover info' })

        const result = await upstream.triggerRequest('textDocument/hover', params)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/hover', params)
        expect(result).toEqual({ contents: 'hover info' })
    })

    it('retries Vue hover when the initial response is still loading', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)

        const params = {
            textDocument: { uri: 'file:///workspace/components/App.vue' },
            position: { line: 0, character: 18 }
        }
        vtslsConn.sendRequest.mockImplementation(async (method: string, requestParams?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') {
                const calls = vtslsConn.sendRequest.mock.calls.filter(([name]) => name === 'textDocument/hover').length
                if (calls === 1) {
                    return {
                        contents: {
                            kind: 'markdown',
                            value: '(loading...) `const count: number`'
                        }
                    }
                }
                return {
                    contents: {
                        kind: 'markdown',
                        value: '`const count: number`'
                    },
                    requestParams
                }
            }
            return { capabilities: {} }
        })

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template><div>{{ count }}</div></template>\n<script setup lang="ts">const count = 1</script>'
            }
        })

        try {
            const resultPromise = upstream.triggerRequest('textDocument/hover', params)
            await vi.advanceTimersByTimeAsync(500)
            const result = await resultPromise

            expect(vtslsConn.sendRequest.mock.calls.filter(([method]) => method === 'textDocument/hover')).toHaveLength(2)
            expect(result).toEqual({
                contents: {
                    kind: 'markdown',
                    value: '`const count: number`'
                },
                requestParams: params
            })
            expect(logger.debug).toHaveBeenCalledWith(
                'proxy',
                expect.stringContaining('textDocument/hover loading retry uri=file:///workspace/components/App.vue')
            )
        } finally {
            vi.useRealTimers()
        }
    })

    it('falls back to vue_ls when template hover degrades to any', async () => {
        await upstream.triggerRequest('initialize', initParams)
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/ItemDetails.vue',
                languageId: 'vue',
                version: 1,
                text: `<template>\n  <ScenarioRow v-for="entry in props.items" :key="entry.identifier" />\n</template>\n\n<script setup lang="ts">\ninterface ItemDetailsProps {\n  items: Array<{ identifier: string }>\n}\nconst props = defineProps<ItemDetailsProps>()\n</script>\n`
            }
        })

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') {
                return {
                    contents: {
                        language: 'typescript',
                        value: 'const entry: any'
                    }
                }
            }
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') {
                return {
                    contents: {
                        language: 'typescript',
                        value: 'const entry: { identifier: string }'
                    }
                }
            }
            return { capabilities: {} }
        })

        const result = await upstream.triggerRequest('textDocument/hover', {
            textDocument: { uri: 'file:///workspace/components/ItemDetails.vue' },
            position: { line: 1, character: 31 }
        })

        const vueHoverCalls = vueLsConn.sendRequest.mock.calls.filter(([method]) => method === 'textDocument/hover')
        expect(vueHoverCalls).toHaveLength(1)
        expect(vueHoverCalls[0]?.[1]).toMatchObject({
            textDocument: { uri: 'file:///workspace/components/ItemDetails.vue' },
            position: { line: 1, character: 37 }
        })
        expect(result).toEqual({
            contents: {
                language: 'typescript',
                value: 'const entry: { identifier: string }'
            }
        })
    })

    it('falls back to vue_ls when macro hover times out in a large Vue file', async () => {
        const upstreamWithTimeout = createMockConnection()
        const vtslsWithTimeout = createMockConnection()
        const vueLsWithTimeout = createMockConnection()
        const pendingHover = createDeferred<unknown>()

        setupProxy(
            upstreamWithTimeout as unknown as MessageConnection,
            vtslsWithTimeout as unknown as MessageConnection,
            vueLsWithTimeout as unknown as MessageConnection,
            {
                requestTimeoutMs: 25
            }
        )
        await upstreamWithTimeout.triggerRequest('initialize', initParams)

        upstreamWithTimeout.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/ItemDetails.vue',
                languageId: 'vue',
                version: 1,
                text: `<script setup lang="ts">\nimport { storeToRefs } from 'pinia'\ninterface ItemDetailsProps {\n  itemIndex: number\n}\nconst props = defineProps<ItemDetailsProps>()\nconst scenariosStore = useScenariosStore()\nconst { lineItemCount } = storeToRefs(scenariosStore)\n</script>\n`
            }
        })

        vtslsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') return pendingHover.promise
            return { capabilities: {} }
        })
        vueLsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') {
                return {
                    contents: {
                        language: 'typescript',
                        value: 'const props: ItemDetailsProps'
                    }
                }
            }
            return { capabilities: {} }
        })

        try {
            const result = await upstreamWithTimeout.triggerRequest('textDocument/hover', {
                textDocument: { uri: 'file:///workspace/components/ItemDetails.vue' },
                position: { line: 5, character: 8 }
            })

            expect(result).toEqual({
                contents: {
                    language: 'typescript',
                    value: 'const props: ItemDetailsProps'
                }
            })
            expect(vueLsWithTimeout.sendRequest).toHaveBeenCalledWith('textDocument/hover', {
                textDocument: { uri: 'file:///workspace/components/ItemDetails.vue' },
                position: { line: 5, character: 8 }
            })
        } finally {
            pendingHover.resolve(null)
        }
    })

    it('falls back to vue_ls when ordinary Vue script hover times out', async () => {
        const upstreamWithTimeout = createMockConnection()
        const vtslsWithTimeout = createMockConnection()
        const vueLsWithTimeout = createMockConnection()
        const pendingHover = createDeferred<unknown>()

        setupProxy(
            upstreamWithTimeout as unknown as MessageConnection,
            vtslsWithTimeout as unknown as MessageConnection,
            vueLsWithTimeout as unknown as MessageConnection,
            {
                requestTimeoutMs: 25
            }
        )
        await upstreamWithTimeout.triggerRequest('initialize', initParams)

        upstreamWithTimeout.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">\nconst count = 1\n</script>\n'
            }
        })

        vtslsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') return pendingHover.promise
            return { capabilities: {} }
        })
        vueLsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') {
                return {
                    contents: {
                        language: 'typescript',
                        value: 'const count: 1'
                    }
                }
            }
            return { capabilities: {} }
        })

        try {
            const result = await upstreamWithTimeout.triggerRequest('textDocument/hover', {
                textDocument: { uri: 'file:///workspace/components/App.vue' },
                position: { line: 1, character: 6 }
            })

            expect(result).toEqual({
                contents: {
                    language: 'typescript',
                    value: 'const count: 1'
                }
            })
            expect(vueLsWithTimeout.sendRequest).toHaveBeenCalledWith('textDocument/hover', {
                textDocument: { uri: 'file:///workspace/components/App.vue' },
                position: { line: 1, character: 6 }
            })
        } finally {
            pendingHover.resolve(null)
        }
    })

    it('falls back to tsserver quickinfo when Vue script hover times out and vue_ls is empty', async () => {
        vi.useFakeTimers()
        const upstreamWithTimeout = createMockConnection()
        const vtslsWithTimeout = createMockConnection()
        const vueLsWithTimeout = createMockConnection()
        const recoveredVtsls = createMockConnection()
        const pendingHover = createDeferred<unknown>()
        const killVtsls = vi.fn(() => {
            vtslsWithTimeout.triggerClose()
        })

        vtslsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') return pendingHover.promise
            return { capabilities: {} }
        })
        vueLsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') return null
            return { capabilities: {} }
        })
        recoveredVtsls.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'workspace/executeCommand') {
                const command = params as { command?: string; arguments?: unknown[] }
                if (command.command === 'typescript.tsserverRequest') {
                    return {
                        body: {
                            kind: 'const',
                            kindModifiers: '',
                            start: { line: 3, offset: 7 },
                            end: { line: 3, offset: 13 },
                            displayString: 'const isRefi: ComputedRef<boolean>',
                            documentation: 'Exposed for template use.',
                            tags: []
                        }
                    }
                }
            }
            return { capabilities: {} }
        })

        setupProxy(
            upstreamWithTimeout as unknown as MessageConnection,
            vtslsWithTimeout as unknown as MessageConnection,
            vueLsWithTimeout as unknown as MessageConnection,
            {
                spawnVtsls: () => recoveredVtsls as unknown as MessageConnection,
                killVtsls,
                delayMs: 0,
                requestTimeoutMs: 25
            }
        )
        await upstreamWithTimeout.triggerRequest('initialize', initParams)

        upstreamWithTimeout.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">\nconst estimatesStore = useEstimatesStore()\nconst isRefi = computed(() => estimatesStore.isRefi)\n</script>\n'
            }
        })

        try {
            const request = upstreamWithTimeout.triggerRequest('textDocument/hover', {
                textDocument: { uri: 'file:///workspace/components/App.vue' },
                position: { line: 2, character: 6 }
            })

            await vi.runAllTimersAsync()
            await Promise.resolve()

            await expect(request).resolves.toEqual({
                contents: {
                    kind: 'markdown',
                    value: '```ts\nconst isRefi: ComputedRef<boolean>\n```\n\nExposed for template use.'
                }
            })
            expect(killVtsls).toHaveBeenCalledOnce()
            expect(recoveredVtsls.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
                command: 'typescript.tsserverRequest',
                arguments: [
                    '_vue:quickinfo',
                    {
                        file: '/workspace/components/App.vue',
                        line: 3,
                        offset: 7
                    },
                    {
                        executionTarget: 0
                    }
                ]
            })
        } finally {
            pendingHover.resolve(null)
            vi.useRealTimers()
        }
    })

    it('falls back to tsserver quickinfo when Vue script hover stays stuck on any', async () => {
        await upstream.triggerRequest('initialize', initParams)
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">\nconst currentLoan = useCurrentLoan()\n</script>\n'
            }
        })

        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') {
                const hoverCalls = vtslsConn.sendRequest.mock.calls.filter(([name]) => name === 'textDocument/hover').length
                return hoverCalls === 1
                    ? {
                          contents: {
                              kind: 'markdown',
                              value: '(loading...) `const currentLoan: any`'
                          }
                      }
                    : {
                          contents: {
                              language: 'typescript',
                              value: 'const currentLoan: any'
                          }
                      }
            }
            if (method === 'workspace/executeCommand') {
                const command = params as { command?: string; arguments?: unknown[] }
                if (command.command === 'typescript.tsserverRequest') {
                    return {
                        body: {
                            displayString: 'const currentLoan: Ref<{ amount: number }>',
                            documentation: 'Resolved after Vue warm-up.',
                            tags: []
                        }
                    }
                }
            }
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') return null
            return { capabilities: {} }
        })

        const result = await upstream.triggerRequest('textDocument/hover', {
            textDocument: { uri: 'file:///workspace/components/App.vue' },
            position: { line: 1, character: 8 }
        })

        expect(result).toEqual({
            contents: {
                kind: 'markdown',
                value: '```ts\nconst currentLoan: Ref<{ amount: number }>\n```\n\nResolved after Vue warm-up.'
            }
        })
        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
            command: 'typescript.tsserverRequest',
            arguments: [
                '_vue:quickinfo',
                {
                    file: '/workspace/components/App.vue',
                    line: 2,
                    offset: 9
                },
                {
                    executionTarget: 0
                }
            ]
        })
    })

    it('falls back to vue_ls when Vue definition times out in script setup', async () => {
        const upstreamWithTimeout = createMockConnection()
        const vtslsWithTimeout = createMockConnection()
        const vueLsWithTimeout = createMockConnection()
        const pendingDefinition = createDeferred<unknown>()

        setupProxy(
            upstreamWithTimeout as unknown as MessageConnection,
            vtslsWithTimeout as unknown as MessageConnection,
            vueLsWithTimeout as unknown as MessageConnection,
            {
                requestTimeoutMs: 25
            }
        )
        await upstreamWithTimeout.triggerRequest('initialize', initParams)

        upstreamWithTimeout.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">\nconst count = 1\nconst alias = count\n</script>\n'
            }
        })

        vtslsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/definition') return pendingDefinition.promise
            return { capabilities: {} }
        })
        vueLsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/definition') {
                return [
                    {
                        uri: 'file:///workspace/components/App.vue',
                        range: {
                            start: { line: 1, character: 6 },
                            end: { line: 1, character: 11 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })

        try {
            const result = await upstreamWithTimeout.triggerRequest('textDocument/definition', {
                textDocument: { uri: 'file:///workspace/components/App.vue' },
                position: { line: 2, character: 14 }
            })

            expect(result).toEqual([
                {
                    uri: 'file:///workspace/components/App.vue',
                    range: {
                        start: { line: 1, character: 6 },
                        end: { line: 1, character: 11 }
                    }
                }
            ])
            expect(vueLsWithTimeout.sendRequest).toHaveBeenCalledWith('textDocument/definition', {
                textDocument: { uri: 'file:///workspace/components/App.vue' },
                position: { line: 2, character: 14 }
            })
        } finally {
            pendingDefinition.resolve(null)
        }
    })

    it('falls back to goToSourceDefinition after a Vue import definition timeout', async () => {
        vi.useFakeTimers()
        const upstreamWithTimeout = createMockConnection()
        const vtslsWithTimeout = createMockConnection()
        const vueLsWithTimeout = createMockConnection()
        const recoveredVtsls = createMockConnection()
        const pendingDefinition = createDeferred<unknown>()
        const killVtsls = vi.fn(() => {
            vtslsWithTimeout.triggerClose()
        })

        const sourceResult = [
            {
                uri: 'file:///workspace/src/stores/estimates.ts',
                range: {
                    start: { line: 4, character: 13 },
                    end: { line: 4, character: 30 }
                }
            }
        ]

        vtslsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/definition') return pendingDefinition.promise
            return { capabilities: {} }
        })
        vueLsWithTimeout.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/definition') return []
            return { capabilities: {} }
        })
        recoveredVtsls.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/definition') return []
            if (method === 'workspace/executeCommand') {
                const command = params as { command?: string }
                if (command.command === 'typescript.goToSourceDefinition') {
                    return sourceResult
                }
            }
            return { capabilities: {} }
        })

        setupProxy(
            upstreamWithTimeout as unknown as MessageConnection,
            vtslsWithTimeout as unknown as MessageConnection,
            vueLsWithTimeout as unknown as MessageConnection,
            {
                spawnVtsls: () => recoveredVtsls as unknown as MessageConnection,
                killVtsls,
                delayMs: 0,
                requestTimeoutMs: 25
            }
        )
        await upstreamWithTimeout.triggerRequest('initialize', initParams)

        upstreamWithTimeout.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/App.vue',
                languageId: 'vue',
                version: 1,
                text: '<script setup lang="ts">\nimport { useEstimatesStore } from \'Store/estimates\'\nconst estimatesStore = useEstimatesStore()\n</script>\n'
            }
        })

        try {
            const request = upstreamWithTimeout.triggerRequest('textDocument/definition', {
                textDocument: { uri: 'file:///workspace/components/App.vue' },
                position: { line: 1, character: 29 }
            })

            await vi.runAllTimersAsync()
            await Promise.resolve()

            await expect(request).resolves.toEqual(sourceResult)
            expect(killVtsls).toHaveBeenCalledOnce()
            expect(recoveredVtsls.sendRequest).toHaveBeenCalledWith('workspace/executeCommand', {
                command: 'typescript.goToSourceDefinition',
                arguments: ['file:///workspace/components/App.vue', { line: 1, character: 9 }]
            })
        } finally {
            pendingDefinition.resolve(null)
            vi.useRealTimers()
        }
    })

    it('falls back to vue_ls when a template storeToRefs definition resolves empty in vtsls', async () => {
        await upstream.triggerRequest('initialize', initParams)
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/components/ItemDetails.vue',
                languageId: 'vue',
                version: 1,
                text: `<template>\n  <span>{{ count }}</span>\n</template>\n\n<script setup lang="ts">\nimport { storeToRefs } from 'pinia'\nconst store = useCounterStore()\nconst { count } = storeToRefs(store)\n</script>\n`
            }
        })

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/definition') return []
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/definition') {
                return [
                    {
                        uri: 'file:///workspace/components/ItemDetails.vue',
                        range: {
                            start: { line: 6, character: 8 },
                            end: { line: 6, character: 13 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })

        const result = await upstream.triggerRequest('textDocument/definition', {
            textDocument: { uri: 'file:///workspace/components/ItemDetails.vue' },
            position: { line: 1, character: 12 }
        })

        expect(result).toEqual([
            {
                uri: 'file:///workspace/components/ItemDetails.vue',
                range: {
                    start: { line: 6, character: 8 },
                    end: { line: 6, character: 13 }
                }
            }
        ])
        expect(vueLsConn.sendRequest.mock.calls.filter(([method]) => method === 'textDocument/definition')).toContainEqual([
            'textDocument/definition',
            {
                textDocument: { uri: 'file:///workspace/components/ItemDetails.vue' },
                position: { line: 1, character: 11 }
            }
        ])
    })

    it('falls back to the Pinia store source for script storeToRefs bindings', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-store-refs-'))
        const storePath = path.join(tempWorkspace, 'stores', 'estimates.ts')
        const componentPath = path.join(tempWorkspace, 'components', 'PropertyDetails.vue')
        fs.mkdirSync(path.dirname(storePath), { recursive: true })
        fs.mkdirSync(path.dirname(componentPath), { recursive: true })
        fs.writeFileSync(
            storePath,
            `import { computed, ref } from 'vue'\nimport { defineStore } from 'pinia'\n\nexport const useEstimatesStore = defineStore('estimates', () => {\n  const currentLoan = ref({ amount: 1 })\n  const isRefi = computed(() => false)\n\n  return {\n    currentLoan,\n    isRefi,\n  }\n})\n`
        )
        fs.writeFileSync(
            componentPath,
            `<script setup lang="ts">\nimport { storeToRefs } from 'pinia'\nimport { useEstimatesStore } from '../stores/estimates'\n\nconst estimatesStore = useEstimatesStore()\nconst { currentLoan } = storeToRefs(estimatesStore)\n</script>\n`
        )

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)

            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })
            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(componentPath).href,
                    languageId: 'vue',
                    version: 1,
                    text: fs.readFileSync(componentPath, 'utf8')
                }
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/definition') return []
                if (method === 'workspace/executeCommand') return { body: null }
                return { capabilities: {} }
            })

            const result = await localUpstream.triggerRequest('textDocument/definition', {
                textDocument: { uri: pathToFileURL(componentPath).href },
                position: { line: 5, character: 8 }
            })

            expect(result).toEqual([
                {
                    uri: pathToFileURL(storePath).href,
                    range: {
                        start: { line: 4, character: 8 },
                        end: { line: 4, character: 19 }
                    }
                }
            ])
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('forwards workspace/symbol to vtsls', async () => {
        const params = { query: 'MyClass' }
        vtslsConn.sendRequest.mockResolvedValue([{ name: 'MyClass' }])

        const result = await upstream.triggerRequest('workspace/symbol', params)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/symbol', params)
        expect(result).toEqual([{ name: 'MyClass' }])
    })

    it('synthesizes an empty workspace/symbol query from the latest positional request context', async () => {
        await upstream.triggerRequest('initialize', initParams)
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/src/useFeature.ts',
                languageId: 'typescript',
                version: 1,
                text: 'export const useSelectionStore = () => true;\nconst value = useSelectionStore();\n'
            }
        })

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/hover') return { contents: 'hover info' }
            if (method === 'workspace/symbol') return [{ name: 'useSelectionStore' }]
            return { capabilities: {} }
        })

        await upstream.triggerRequest('textDocument/hover', {
            textDocument: { uri: 'file:///workspace/src/useFeature.ts' },
            position: { line: 1, character: 16 }
        })

        const result = await upstream.triggerRequest('workspace/symbol', {
            query: ''
        })

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('workspace/symbol', {
            query: 'useSelectionStore'
        })
        expect(result).toEqual([{ name: 'useSelectionStore' }])
    })

    it('falls back to a local workspace symbol scan when vtsls times out', async () => {
        vi.useFakeTimers()
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-workspace-symbols-'))
        const helperPath = path.join(tempWorkspace, 'helpers', 'fees.ts')
        fs.mkdirSync(path.dirname(helperPath), { recursive: true })
        fs.writeFileSync(
            helperPath,
            `export function amountFormatter(amount: number) {\n  return amount.toFixed(2)\n}\n\nexport const amountLabel = 'Amount'\n`
        )

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            const pendingSymbols = createDeferred<unknown>()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection, {
                requestTimeoutMs: 25
            })

            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'workspace/symbol') return pendingSymbols.promise
                return { capabilities: {} }
            })

            const request = localUpstream.triggerRequest('workspace/symbol', {
                query: 'amount'
            })
            await vi.runAllTimersAsync()
            await Promise.resolve()

            await expect(request).resolves.toEqual([
                {
                    name: 'amountLabel',
                    kind: 13,
                    location: {
                        uri: pathToFileURL(helperPath).href,
                        range: {
                            start: { line: 4, character: 13 },
                            end: { line: 4, character: 24 }
                        }
                    },
                    containerName: ''
                },
                {
                    name: 'amountFormatter',
                    kind: 12,
                    location: {
                        uri: pathToFileURL(helperPath).href,
                        range: {
                            start: { line: 0, character: 16 },
                            end: { line: 0, character: 31 }
                        }
                    },
                    containerName: ''
                }
            ])
        } finally {
            vi.useRealTimers()
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('fills in cross-file references for exported type aliases when vtsls only returns same-file hits', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-refs-'))
        const typesPath = path.join(tempWorkspace, 'definitions', 'types.ts')
        const consumerPath = path.join(tempWorkspace, 'stores', 'estimates.ts')
        fs.mkdirSync(path.dirname(typesPath), { recursive: true })
        fs.mkdirSync(path.dirname(consumerPath), { recursive: true })
        fs.writeFileSync(
            typesPath,
            `export type Brand<T, B extends string> = T & { __brand: B }\nexport type LineItemId = Brand<string, 'LineItemId'>\nexport interface LineItemPayload {\n  identifier: LineItemId\n}\n`
        )
        fs.writeFileSync(
            consumerPath,
            `import type { LineItemId } from '../definitions/types'\n\nexport function trackItem(identifier: LineItemId) {\n  return identifier\n}\n`
        )

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)

            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })
            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(typesPath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(typesPath, 'utf8')
                }
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/references') {
                    return [
                        {
                            uri: pathToFileURL(typesPath).href,
                            range: {
                                start: { line: 1, character: 12 },
                                end: { line: 1, character: 36 }
                            }
                        },
                        {
                            uri: pathToFileURL(typesPath).href,
                            range: {
                                start: { line: 3, character: 14 },
                                end: { line: 3, character: 38 }
                            }
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = (await localUpstream.triggerRequest('textDocument/references', {
                textDocument: { uri: pathToFileURL(typesPath).href },
                position: { line: 1, character: 20 },
                context: { includeDeclaration: true }
            })) as Array<{ uri: string }>

            expect(result.map((entry) => entry.uri)).toContain(pathToFileURL(consumerPath).href)
            expect(result).toHaveLength(4)
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('finds Vue component consumers when references start from the component file itself', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-component-refs-'))
        const componentPath = path.join(tempWorkspace, 'components', 'FeesCard.vue')
        const consumerPath = path.join(tempWorkspace, 'components', 'LoanFees.vue')
        fs.mkdirSync(path.dirname(componentPath), { recursive: true })
        fs.writeFileSync(componentPath, '<template>\n  <section>Fees</section>\n</template>\n')
        fs.writeFileSync(
            consumerPath,
            `<template>\n  <FeesCard />\n</template>\n\n<script setup lang="ts">\nimport FeesCard from './FeesCard.vue'\n</script>\n`
        )

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)

            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })
            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(componentPath).href,
                    languageId: 'vue',
                    version: 1,
                    text: fs.readFileSync(componentPath, 'utf8')
                }
            })
            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(consumerPath).href,
                    languageId: 'vue',
                    version: 1,
                    text: fs.readFileSync(consumerPath, 'utf8')
                }
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/references') return []
                return { capabilities: {} }
            })

            const result = (await localUpstream.triggerRequest('textDocument/references', {
                textDocument: { uri: pathToFileURL(componentPath).href },
                position: { line: 0, character: 0 },
                context: { includeDeclaration: false }
            })) as Array<{
                uri: string
                range: { start: { line: number; character: number } }
            }>

            expect([...result].sort((left, right) => left.range.start.line - right.range.start.line)).toEqual([
                {
                    uri: pathToFileURL(consumerPath).href,
                    range: {
                        start: { line: 1, character: 3 },
                        end: { line: 1, character: 11 }
                    }
                },
                {
                    uri: pathToFileURL(consumerPath).href,
                    range: {
                        start: { line: 5, character: 7 },
                        end: { line: 5, character: 15 }
                    }
                }
            ])
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('propagates downstream error back to upstream', async () => {
        const params = {
            textDocument: { uri: 'file:///foo.ts' },
            position: { line: 0, character: 0 }
        }
        vtslsConn.sendRequest.mockRejectedValue(new Error('server crashed'))

        await expect(upstream.triggerRequest('textDocument/definition', params)).rejects.toThrow('server crashed')
    })

    it('logs error when downstream request fails', async () => {
        const params = {
            textDocument: { uri: 'file:///foo.ts' },
            position: { line: 0, character: 0 }
        }
        vtslsConn.sendRequest.mockRejectedValue(new Error('server crashed'))

        await upstream.triggerRequest('textDocument/definition', params).catch(() => {})

        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('server crashed'))
    })

    it('uses current connection ref after crash recovery', async () => {
        const newVtsls = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: () => newVtsls as unknown as MessageConnection,
            delayMs: 0
        })

        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.triggerClose()
        await new Promise<void>((r) => setTimeout(r, 0))
        await Promise.resolve()

        const params = {
            textDocument: { uri: 'file:///foo.ts' },
            position: { line: 0, character: 0 }
        }
        newVtsls.sendRequest.mockResolvedValue({ uri: 'file:///result.ts' })

        await upstream.triggerRequest('textDocument/definition', params)

        expect(newVtsls.sendRequest).toHaveBeenCalledWith('textDocument/definition', params)
    })
})

describe('graceful shutdown', () => {
    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    it('sends shutdown request to both servers on LSP shutdown', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.sendRequest.mockResolvedValue(null)
        vueLsConn.sendRequest.mockResolvedValue(null)

        await upstream.triggerRequest('shutdown')

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('shutdown')
        expect(vueLsConn.sendRequest).toHaveBeenCalledWith('shutdown')
    })

    it('returns null from the shutdown request', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.sendRequest.mockResolvedValue(null)
        vueLsConn.sendRequest.mockResolvedValue(null)

        const result = await upstream.triggerRequest('shutdown')
        expect(result).toBeNull()
    })

    it('kills child servers with SIGTERM when shutdown times out', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const killVtsls = vi.fn()
        const killVueLs = vi.fn()

        vtslsConn.sendRequest.mockImplementation((method: string) => (method === 'shutdown' ? new Promise(() => {}) : Promise.resolve({ capabilities: {} })))
        vueLsConn.sendRequest.mockImplementation((method: string) => (method === 'shutdown' ? new Promise(() => {}) : Promise.resolve({ capabilities: {} })))

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            killVtsls,
            killVueLs,
            shutdownTimeoutMs: 0
        })
        await upstream.triggerRequest('initialize', initParams)

        await upstream.triggerRequest('shutdown')

        expect(killVtsls).toHaveBeenCalled()
        expect(killVueLs).toHaveBeenCalled()
    })

    it('sends exit notification to both servers and calls process.exit(0)', () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)

        upstream.triggerNotification('exit')

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('exit')
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('exit')
        expect(exitSpy).toHaveBeenCalledWith(0)

        exitSpy.mockRestore()
    })

    it('handles SIGINT by initiating shutdown sequence', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const processOnSpy = vi.spyOn(process, 'on')
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const sigintCalls = (processOnSpy.mock.calls as [string, () => void][]).filter(([event]) => event === 'SIGINT')
        expect(sigintCalls.length).toBeGreaterThan(0)
        const sigintHandler = sigintCalls[sigintCalls.length - 1]![1]

        sigintHandler()
        await new Promise<void>((r) => setTimeout(r, 0))

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('shutdown')
        expect(vueLsConn.sendRequest).toHaveBeenCalledWith('shutdown')
        expect(exitSpy).toHaveBeenCalledWith(0)

        processOnSpy.mockRestore()
        exitSpy.mockRestore()
    })

    it('handles SIGTERM by initiating shutdown sequence', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const processOnSpy = vi.spyOn(process, 'on')
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const sigtermCalls = (processOnSpy.mock.calls as [string, () => void][]).filter(([event]) => event === 'SIGTERM')
        expect(sigtermCalls.length).toBeGreaterThan(0)
        const sigtermHandler = sigtermCalls[sigtermCalls.length - 1]![1]

        sigtermHandler()
        await new Promise<void>((r) => setTimeout(r, 0))

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('shutdown')
        expect(vueLsConn.sendRequest).toHaveBeenCalledWith('shutdown')
        expect(exitSpy).toHaveBeenCalledWith(0)

        processOnSpy.mockRestore()
        exitSpy.mockRestore()
    })
})

describe('crash recovery', () => {
    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    async function flushRecovery() {
        await new Promise<void>((r) => setTimeout(r, 0))
        await Promise.resolve()
    }

    async function initProxy(
        upstream: MockConnection,
        vtslsConn: MockConnection,
        vueLsConn: MockConnection,
        spawnVtsls?: () => MockConnection,
        spawnVueLs?: () => MockConnection
    ) {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: spawnVtsls ? () => spawnVtsls() as unknown as MessageConnection : undefined,
            spawnVueLs: spawnVueLs ? () => spawnVueLs() as unknown as MessageConnection : undefined,
            delayMs: 0
        })
        await upstream.triggerRequest('initialize', initParams)
    }

    it('restarts vtsls after crash and calls listen on new connection', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()
        const spawnVtsls = vi.fn().mockReturnValue(newVtsls)

        await initProxy(upstream, vtslsConn, vueLsConn, () => spawnVtsls())

        vtslsConn.triggerClose()
        await flushRecovery()

        expect(spawnVtsls).toHaveBeenCalledOnce()
        expect(newVtsls.listen).toHaveBeenCalled()
    })

    it('re-initializes vtsls with original params after restart', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()

        await initProxy(upstream, vtslsConn, vueLsConn, () => newVtsls)

        vtslsConn.triggerClose()
        await flushRecovery()

        const initCall = (newVtsls.sendRequest.mock.calls as [string, unknown][]).find(([method]) => method === 'initialize')
        expect(initCall).toBeDefined()
        expect(initCall![1]).toMatchObject({ rootUri: 'file:///workspace' })
    })

    it('replays all open documents to restarted vtsls', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()

        await initProxy(upstream, vtslsConn, vueLsConn, () => newVtsls)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: 'hello'
            }
        })
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template/>'
            }
        })

        vtslsConn.triggerClose()
        await flushRecovery()

        const didOpenCalls = (newVtsls.sendNotification.mock.calls as [string, unknown][]).filter(([method]) => method === 'textDocument/didOpen')
        const uris = didOpenCalls.map(([, p]) => (p as { textDocument: { uri: string } }).textDocument.uri)
        expect(uris).toContain('file:///foo.ts')
        expect(uris).toContain('file:///App.vue')
    })

    it('restarts vue_ls after crash and re-establishes tsserver/request handler', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVueLs = createMockConnection()
        const spawnVueLs = vi.fn().mockReturnValue(newVueLs)

        await initProxy(upstream, vtslsConn, vueLsConn, undefined, () => spawnVueLs())

        vueLsConn.triggerClose()
        await flushRecovery()

        expect(spawnVueLs).toHaveBeenCalledOnce()
        expect(newVueLs.sendRequest).toHaveBeenCalledWith('initialize', expect.anything())
        expect(newVueLs.onNotification).toHaveBeenCalledWith('tsserver/request', expect.any(Function))
    })

    it('replays only .vue documents to restarted vue_ls', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVueLs = createMockConnection()

        await initProxy(upstream, vtslsConn, vueLsConn, undefined, () => newVueLs)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: 'ts content'
            }
        })
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///App.vue',
                languageId: 'vue',
                version: 1,
                text: '<template/>'
            }
        })

        vueLsConn.triggerClose()
        await flushRecovery()

        const didOpenCalls = (newVueLs.sendNotification.mock.calls as [string, unknown][]).filter(([method]) => method === 'textDocument/didOpen')
        expect(didOpenCalls).toHaveLength(1)
        expect((didOpenCalls[0]![1] as { textDocument: { uri: string } }).textDocument.uri).toBe('file:///App.vue')
    })

    it('stops restarting vtsls after retry cap is reached', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()

        const createdConns: MockConnection[] = []
        const spawnVtsls = vi.fn(() => {
            const conn = createMockConnection()
            createdConns.push(conn)
            return conn as unknown as MessageConnection
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls,
            delayMs: 0,
            maxRestarts: 3
        })
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.triggerClose()
        await flushRecovery()
        createdConns[0]!.triggerClose()
        await flushRecovery()
        createdConns[1]!.triggerClose()
        await flushRecovery()

        createdConns[2]!.triggerClose()
        await flushRecovery()

        expect(spawnVtsls).toHaveBeenCalledTimes(3)
    })

    it('sends window/showMessage error when retry cap is exceeded', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()

        const createdConns: MockConnection[] = []
        const spawnVtsls = vi.fn(() => {
            const conn = createMockConnection()
            createdConns.push(conn)
            return conn as unknown as MessageConnection
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls,
            delayMs: 0,
            maxRestarts: 3
        })
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.triggerClose()
        await flushRecovery()
        createdConns[0]!.triggerClose()
        await flushRecovery()
        createdConns[1]!.triggerClose()
        await flushRecovery()
        createdConns[2]!.triggerClose()
        await flushRecovery()

        expect(upstream.sendNotification).toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({
                type: 1,
                message: expect.stringContaining('vtsls')
            })
        )
    })

    it('restarts vtsls and retries a timed out request once', async () => {
        vi.useFakeTimers()
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()
        const pending = createDeferred<unknown>()

        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') return pending.promise
            return { capabilities: {}, method, params }
        })
        newVtsls.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'textDocument/hover') {
                return { contents: 'recovered hover', method, params }
            }
            return { capabilities: {}, method, params }
        })

        const killVtsls = vi.fn(() => {
            vtslsConn.triggerClose()
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: () => newVtsls as unknown as MessageConnection,
            killVtsls,
            delayMs: 0,
            requestTimeoutMs: 25
        })
        await upstream.triggerRequest('initialize', initParams)

        const requestPromise = upstream.triggerRequest('textDocument/hover', {
            textDocument: { uri: 'file:///workspace/src/app.ts' },
            position: { line: 0, character: 0 }
        })

        await vi.runAllTimersAsync()
        await Promise.resolve()

        const result = await requestPromise
        expect(killVtsls).toHaveBeenCalledOnce()
        expect(newVtsls.sendRequest).toHaveBeenCalledWith('textDocument/hover', {
            textDocument: { uri: 'file:///workspace/src/app.ts' },
            position: { line: 0, character: 0 }
        })
        expect(result).toEqual(
            expect.objectContaining({
                contents: 'recovered hover'
            })
        )
        vi.useRealTimers()
    })

    it('sends tsserver/response null and recovers when a bridged request times out', async () => {
        vi.useFakeTimers()
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()
        const pending = createDeferred<unknown>()

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'workspace/executeCommand') return pending.promise
            return { capabilities: {} }
        })
        newVtsls.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'workspace/executeCommand') return { body: null }
            return { capabilities: {} }
        })

        const killVtsls = vi.fn(() => {
            vtslsConn.triggerClose()
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: () => newVtsls as unknown as MessageConnection,
            killVtsls,
            delayMs: 0,
            requestTimeoutMs: 25
        })
        await upstream.triggerRequest('initialize', initParams)

        vueLsConn.triggerNotification('tsserver/request', [77, 'getDefinition', { file: 'App.vue' }])
        await vi.runAllTimersAsync()
        await Promise.resolve()

        expect(killVtsls).toHaveBeenCalledOnce()
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('tsserver/response', [77, null])
        vi.useRealTimers()
    })

    it('ignores stale close events from previously replaced vtsls connections', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()
        const newerVtsls = createMockConnection()
        const spawnVtsls = vi
            .fn()
            .mockReturnValueOnce(newVtsls as unknown as MessageConnection)
            .mockReturnValueOnce(newerVtsls as unknown as MessageConnection)

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls,
            delayMs: 0
        })
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.triggerClose()
        await flushRecovery()

        expect(spawnVtsls).toHaveBeenCalledTimes(1)

        vtslsConn.triggerClose()
        await flushRecovery()

        expect(spawnVtsls).toHaveBeenCalledTimes(1)
    })
})

describe('workspace/configuration handling', () => {
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
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    it('responds to workspace/configuration from vtsls with plugin settings', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const result = await vtslsConn.triggerRequest('workspace/configuration', {
            items: [{ section: '' }]
        })

        expect(result).toEqual([
            expect.objectContaining({
                vtsls: expect.objectContaining({
                    tsserver: expect.objectContaining({
                        globalPlugins: expect.arrayContaining([expect.objectContaining({ name: '@vue/typescript-plugin' })])
                    })
                })
            })
        ])
    })

    it('responds to workspace/configuration with empty section returning full settings', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const result = await vtslsConn.triggerRequest('workspace/configuration', {
            items: [{}]
        })

        const arr = result as Array<Record<string, unknown>>
        expect(arr).toHaveLength(1)
        expect(arr[0]).toHaveProperty('vtsls')
    })

    it('responds to workspace/configuration from vue_ls with vue settings', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const result = await vueLsConn.triggerRequest('workspace/configuration', {
            items: [{ section: '' }]
        })

        expect(result).toEqual([
            expect.objectContaining({
                vue: expect.objectContaining({ hybridMode: true })
            })
        ])
    })

    it('resolves dot-path sections for workspace/configuration', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const result = await vtslsConn.triggerRequest('workspace/configuration', {
            items: [{ section: 'vtsls.tsserver.globalPlugins' }]
        })

        const arr = result as Array<unknown>
        expect(arr).toHaveLength(1)
        expect(arr[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: '@vue/typescript-plugin' })]))
    })

    it('returns null for unknown section paths', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const result = await vtslsConn.triggerRequest('workspace/configuration', {
            items: [{ section: 'nonexistent.path' }]
        })

        expect(result).toEqual([null])
    })

    it('logs workspace/configuration requests at debug level', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        await vtslsConn.triggerRequest('workspace/configuration', {
            items: [{ section: '' }]
        })

        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('workspace/configuration from vtsls'))
    })

    it('injects workspace.configuration capability into vtsls init params', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const [, params] = vtslsConn.sendRequest.mock.calls[0] as [string, Record<string, unknown>]
        const caps = params['capabilities'] as Record<string, unknown>
        const workspace = caps['workspace'] as Record<string, unknown>
        expect(workspace['configuration']).toBe(true)
    })

    it('injects workspace.configuration capability into vue_ls init params', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const [, params] = vueLsConn.sendRequest.mock.calls[0] as [string, Record<string, unknown>]
        const caps = params['capabilities'] as Record<string, unknown>
        const workspace = caps['workspace'] as Record<string, unknown>
        expect(workspace['configuration']).toBe(true)
    })

    it('sends workspace/didChangeConfiguration to both servers after initialized', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()

        upstream.triggerNotification('initialized', {})

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith(
            'workspace/didChangeConfiguration',
            expect.objectContaining({
                settings: expect.objectContaining({
                    vtsls: expect.anything()
                })
            })
        )
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith(
            'workspace/didChangeConfiguration',
            expect.objectContaining({
                settings: expect.objectContaining({
                    vue: expect.objectContaining({ hybridMode: true })
                })
            })
        )
    })

    it('re-registers workspace/configuration handler after vtsls crash recovery', async () => {
        const newVtsls = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: () => newVtsls as unknown as MessageConnection,
            delayMs: 0
        })
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.triggerClose()
        await new Promise<void>((r) => setTimeout(r, 0))
        await Promise.resolve()

        const result = await newVtsls.triggerRequest('workspace/configuration', {
            items: [{ section: '' }]
        })

        expect(result).toEqual([
            expect.objectContaining({
                vtsls: expect.objectContaining({
                    tsserver: expect.anything()
                })
            })
        ])
    })

    it('sends workspace/didChangeConfiguration to vtsls after crash recovery', async () => {
        const newVtsls = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: () => newVtsls as unknown as MessageConnection,
            delayMs: 0
        })
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.triggerClose()
        await new Promise<void>((r) => setTimeout(r, 0))
        await Promise.resolve()

        expect(newVtsls.sendNotification).toHaveBeenCalledWith(
            'workspace/didChangeConfiguration',
            expect.objectContaining({
                settings: expect.objectContaining({
                    vtsls: expect.anything()
                })
            })
        )
    })

    it('sends workspace/didChangeConfiguration to vue_ls after crash recovery', async () => {
        const newVueLs = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVueLs: () => newVueLs as unknown as MessageConnection,
            delayMs: 0
        })
        await upstream.triggerRequest('initialize', initParams)

        vueLsConn.triggerClose()
        await new Promise<void>((r) => setTimeout(r, 0))
        await Promise.resolve()

        expect(newVueLs.sendNotification).toHaveBeenCalledWith(
            'workspace/didChangeConfiguration',
            expect.objectContaining({
                settings: expect.objectContaining({
                    vue: expect.objectContaining({ hybridMode: true })
                })
            })
        )
    })

    it('includes typescript settings in vtsls workspace/configuration response', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        const result = await vtslsConn.triggerRequest('workspace/configuration', {
            items: [{ section: 'typescript' }]
        })

        const arr = result as Array<Record<string, unknown>>
        expect(arr).toHaveLength(1)
        expect(arr[0]).toEqual(
            expect.objectContaining({
                tsserver: expect.objectContaining({
                    maxTsServerMemory: 8192,
                    log: 'verbose'
                })
            })
        )
    })
})

describe('response payload logging', () => {
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
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    it('logs structured response summaries for forwarded requests at debug level', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vi.mocked(logger.debug).mockClear()

        vtslsConn.sendRequest.mockResolvedValue({ contents: 'info' })
        const params = {
            textDocument: { uri: 'file:///App.vue' },
            position: { line: 1, character: 3 }
        }
        await upstream.triggerRequest('textDocument/hover', params)

        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('textDocument/hover ← vtsls OK'))
        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('uri=file:///App.vue result=1'))
    })

    it('logs empty definition results explicitly', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vi.mocked(logger.debug).mockClear()

        vtslsConn.sendRequest.mockResolvedValue(null)
        const params = {
            textDocument: { uri: 'file:///foo.ts' },
            position: { line: 0, character: 0 }
        }
        await upstream.triggerRequest('textDocument/definition', params)

        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('definitions=0 classification=empty'))
    })

    it('truncates large request payloads in logs', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vi.mocked(logger.debug).mockClear()

        vtslsConn.sendRequest.mockResolvedValue({ contents: 'ok' })
        const params = {
            textDocument: { uri: 'file:///foo.ts' },
            position: { line: 0, character: 0 },
            context: { data: 'x'.repeat(600) }
        }
        await upstream.triggerRequest('textDocument/hover', params)

        const requestCall = vi.mocked(logger.debug).mock.calls.find(([, msg]) => typeof msg === 'string' && msg.includes('payload='))
        expect(requestCall).toBeDefined()
        const logMsg = requestCall![1] as string
        expect(logMsg).toContain('payload=')
        expect(logMsg).toContain('…')
    })
})

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

describe('.vue call hierarchy fallbacks', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(async () => {
        vi.clearAllMocks()
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
    })

    it('builds incoming call hierarchy entries from references when vtsls returns none for .vue', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'callHierarchy/incomingCalls') return []
            if (method === 'textDocument/references') {
                return [
                    {
                        uri: 'file:///workspace/App.vue',
                        range: {
                            start: { line: 2, character: 16 },
                            end: { line: 2, character: 21 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/documentSymbol') {
                return [
                    {
                        name: 'template',
                        kind: 2,
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 3, character: 0 }
                        },
                        selectionRange: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 8 }
                        },
                        children: [
                            {
                                name: 'button.action-button',
                                kind: 8,
                                range: {
                                    start: { line: 1, character: 2 },
                                    end: { line: 2, character: 30 }
                                },
                                selectionRange: {
                                    start: { line: 1, character: 3 },
                                    end: { line: 1, character: 9 }
                                }
                            }
                        ]
                    }
                ]
            }
            return { capabilities: {} }
        })

        const result = (await upstream.triggerRequest('callHierarchy/incomingCalls', {
            item: {
                uri: 'file:///workspace/App.vue',
                name: 'click',
                kind: 12,
                range: {
                    start: { line: 6, character: 0 },
                    end: { line: 8, character: 1 }
                },
                selectionRange: {
                    start: { line: 6, character: 6 },
                    end: { line: 6, character: 11 }
                }
            }
        })) as Array<{ from: { name: string }; fromSpans: unknown[] }>

        expect(result).toHaveLength(1)
        expect(result[0]?.from.name).toBe('button.action-button')
        expect(result[0]?.fromSpans).toHaveLength(1)
    })

    it('builds incoming call hierarchy entries for TS store methods called from Vue templates', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-callers-'))
        const storePath = path.join(tempWorkspace, 'pinia', 'estimates.ts')
        const componentPath = path.join(tempWorkspace, 'components', 'ItemDetails.vue')
        fs.mkdirSync(path.dirname(storePath), { recursive: true })
        fs.mkdirSync(path.dirname(componentPath), { recursive: true })
        fs.writeFileSync(storePath, `export const useScenariosStore = () => ({\n  runScenarioPreview() {\n    return 1\n  },\n})\n`)
        fs.writeFileSync(
            componentPath,
            `<template>\n  <button @click="scenariosStore.runScenarioPreview()">Preview Scenario</button>\n</template>\n\n<script setup lang="ts">\nconst scenariosStore = useScenariosStore()\n</script>\n`
        )

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)
            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })

            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(componentPath).href,
                    languageId: 'vue',
                    version: 1,
                    text: fs.readFileSync(componentPath, 'utf8')
                }
            })
            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(storePath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(storePath, 'utf8')
                }
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'callHierarchy/incomingCalls') return []
                if (method === 'textDocument/references') return []
                return { capabilities: {} }
            })
            localVueLs.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/documentSymbol') {
                    return [
                        {
                            name: 'template',
                            kind: 2,
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 2, character: 11 }
                            },
                            selectionRange: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 8 }
                            },
                            children: [
                                {
                                    name: 'button',
                                    kind: 8,
                                    range: {
                                        start: { line: 1, character: 2 },
                                        end: { line: 1, character: 68 }
                                    },
                                    selectionRange: {
                                        start: { line: 1, character: 3 },
                                        end: { line: 1, character: 9 }
                                    }
                                }
                            ]
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = (await localUpstream.triggerRequest('callHierarchy/incomingCalls', {
                item: {
                    uri: pathToFileURL(storePath).href,
                    name: 'runScenarioPreview',
                    kind: 6,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 3, character: 3 }
                    },
                    selectionRange: {
                        start: { line: 1, character: 2 },
                        end: { line: 1, character: 21 }
                    },
                    detail: '',
                    data: { id: 1 }
                }
            })) as Array<{ from: { name: string } }>

            expect(result).toHaveLength(1)
            expect(result[0]?.from.name).toBe('button')
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('builds incoming call hierarchy entries for function-valued store actions used in Vue templates', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-go-to-tab-'))
        const storePath = path.join(tempWorkspace, 'pinia', 'ui.ts')
        const componentPath = path.join(tempWorkspace, 'components', 'TabbedNav.vue')
        fs.mkdirSync(path.dirname(storePath), { recursive: true })
        fs.mkdirSync(path.dirname(componentPath), { recursive: true })
        fs.writeFileSync(
            storePath,
            `export const useUiStore = () => {\n  const goToTab = function (slug: string) {\n    return slug\n  }\n\n  return {\n    goToTab,\n  }\n}\n`
        )
        fs.writeFileSync(
            componentPath,
            `<template>\n  <button @click="uiStore.goToTab('title')">Title</button>\n</template>\n\n<script setup lang="ts">\nconst uiStore = useUiStore()\n</script>\n`
        )

        try {
            const localUpstream = createMockConnection()
            const localVtsls = createMockConnection()
            const localVueLs = createMockConnection()
            setupProxy(localUpstream as unknown as MessageConnection, localVtsls as unknown as MessageConnection, localVueLs as unknown as MessageConnection)
            await localUpstream.triggerRequest('initialize', {
                rootUri: pathToFileURL(tempWorkspace).href,
                workspaceFolders: [{ uri: pathToFileURL(tempWorkspace).href, name: 'workspace' }],
                capabilities: {}
            })

            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(componentPath).href,
                    languageId: 'vue',
                    version: 1,
                    text: fs.readFileSync(componentPath, 'utf8')
                }
            })
            localUpstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: pathToFileURL(storePath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(storePath, 'utf8')
                }
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'callHierarchy/incomingCalls') {
                    return [
                        {
                            from: {
                                uri: pathToFileURL(storePath).href,
                                name: 'useUiStore',
                                kind: 12,
                                range: {
                                    start: { line: 0, character: 0 },
                                    end: { line: 7, character: 1 }
                                },
                                selectionRange: {
                                    start: { line: 0, character: 13 },
                                    end: { line: 0, character: 23 }
                                }
                            },
                            fromSpans: [
                                {
                                    start: { line: 5, character: 4 },
                                    end: { line: 5, character: 11 }
                                }
                            ]
                        }
                    ]
                }
                if (method === 'textDocument/references') {
                    return [
                        {
                            uri: pathToFileURL(storePath).href,
                            range: {
                                start: { line: 5, character: 4 },
                                end: { line: 5, character: 11 }
                            }
                        }
                    ]
                }
                return { capabilities: {} }
            })
            localVueLs.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/documentSymbol') {
                    return [
                        {
                            name: 'template',
                            kind: 2,
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 2, character: 11 }
                            },
                            selectionRange: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 8 }
                            },
                            children: [
                                {
                                    name: 'button',
                                    kind: 8,
                                    range: {
                                        start: { line: 1, character: 2 },
                                        end: { line: 1, character: 48 }
                                    },
                                    selectionRange: {
                                        start: { line: 1, character: 3 },
                                        end: { line: 1, character: 9 }
                                    }
                                }
                            ]
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = (await localUpstream.triggerRequest('callHierarchy/incomingCalls', {
                item: {
                    uri: pathToFileURL(storePath).href,
                    name: 'goToTab',
                    kind: 12,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 3, character: 3 }
                    },
                    selectionRange: {
                        start: { line: 1, character: 8 },
                        end: { line: 1, character: 15 }
                    },
                    detail: ''
                }
            })) as Array<{ from: { name: string } }>

            expect(result).toHaveLength(2)
            expect(result.map((entry) => entry.from.name)).toEqual(['useUiStore', 'button'])
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('merges synthesized Vue template callers into non-empty incoming call hierarchy results', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'callHierarchy/incomingCalls') {
                return [
                    {
                        from: {
                            uri: 'file:///workspace/src/helpers/recompute.ts',
                            name: 'recompute',
                            kind: 12,
                            range: {
                                start: { line: 4, character: 0 },
                                end: { line: 6, character: 1 }
                            },
                            selectionRange: {
                                start: { line: 4, character: 9 },
                                end: { line: 4, character: 18 }
                            }
                        },
                        fromSpans: [
                            {
                                start: { line: 5, character: 2 },
                                end: { line: 5, character: 27 }
                            }
                        ]
                    }
                ]
            }
            if (method === 'textDocument/references') {
                return [
                    {
                        uri: 'file:///workspace/components/App.vue',
                        range: {
                            start: { line: 1, character: 18 },
                            end: { line: 1, character: 43 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/documentSymbol') {
                return [
                    {
                        name: 'template',
                        kind: 2,
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 2, character: 11 }
                        },
                        selectionRange: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 8 }
                        },
                        children: [
                            {
                                name: 'button',
                                kind: 8,
                                range: {
                                    start: { line: 1, character: 2 },
                                    end: { line: 1, character: 58 }
                                },
                                selectionRange: {
                                    start: { line: 1, character: 3 },
                                    end: { line: 1, character: 9 }
                                }
                            }
                        ]
                    }
                ]
            }
            return { capabilities: {} }
        })

        const result = (await upstream.triggerRequest('callHierarchy/incomingCalls', {
            item: {
                uri: 'file:///workspace/src/stores/property.ts',
                name: 'checkIfPropertyIsComplete',
                kind: 12,
                range: {
                    start: { line: 40, character: 0 },
                    end: { line: 48, character: 1 }
                },
                selectionRange: {
                    start: { line: 40, character: 9 },
                    end: { line: 40, character: 34 }
                },
                detail: ''
            }
        })) as Array<{ from: { name: string } }>

        expect(result).toHaveLength(2)
        expect(result.map((entry) => entry.from.name)).toEqual(['recompute', 'button'])
        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/references', {
            textDocument: { uri: 'file:///workspace/src/stores/property.ts' },
            position: { line: 40, character: 9 },
            context: { includeDeclaration: false }
        })
    })

    it('builds outgoing call hierarchy entries from Vue script calls when vtsls returns none', async () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/App.vue',
                languageId: 'vue',
                version: 1,
                text: `<script setup lang="ts">
const emit = defineEmits<{ (e: 'click', event: MouseEvent): void }>()
const click = (e: MouseEvent) => {
  emit('click', e)
}
</script>
`
            }
        })

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'callHierarchy/outgoingCalls') return []
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/documentSymbol') {
                return [
                    {
                        name: 'script setup',
                        kind: 2,
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 5, character: 0 }
                        },
                        selectionRange: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 12 }
                        },
                        children: [
                            {
                                name: 'emit',
                                kind: 13,
                                range: {
                                    start: { line: 1, character: 6 },
                                    end: { line: 1, character: 10 }
                                },
                                selectionRange: {
                                    start: { line: 1, character: 6 },
                                    end: { line: 1, character: 10 }
                                }
                            },
                            {
                                name: 'click',
                                kind: 13,
                                range: {
                                    start: { line: 2, character: 6 },
                                    end: { line: 4, character: 1 }
                                },
                                selectionRange: {
                                    start: { line: 2, character: 6 },
                                    end: { line: 2, character: 11 }
                                }
                            }
                        ]
                    }
                ]
            }
            return { capabilities: {} }
        })

        const result = (await upstream.triggerRequest('callHierarchy/outgoingCalls', {
            item: {
                uri: 'file:///workspace/App.vue',
                name: 'click',
                kind: 12,
                range: {
                    start: { line: 2, character: 14 },
                    end: { line: 4, character: 1 }
                },
                selectionRange: {
                    start: { line: 2, character: 6 },
                    end: { line: 2, character: 11 }
                }
            }
        })) as Array<{ to: { name: string }; fromSpans: unknown[] }>

        expect(result).toHaveLength(1)
        expect(result[0]?.to.name).toBe('emit')
        expect(result[0]?.fromSpans).toHaveLength(1)
    })

    it('recovers prepareCallHierarchy for destructured composable returns via definition remapping', async () => {
        let targetOpened = false
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-prepare-'))
        const targetPath = path.join(tempWorkspace, 'helpers', 'estimate', 'useSummaryBuilder.ts')
        const targetUri = pathToFileURL(targetPath).href
        const targetText = `export function useSummaryBuilder() {\n  function buildSummary() {\n    return 1\n  }\n\n  return {\n    buildSummary,\n  }\n}\n`
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.writeFileSync(targetPath, targetText)

        try {
            upstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: 'file:///workspace/components/ScenarioOverview.vue',
                    languageId: 'vue',
                    version: 1,
                    text: `<script setup lang="ts">
import { useSummaryBuilder } from '../utils/summary/useSummaryBuilder'
const { buildSummary } = useSummaryBuilder()
</script>
`
                }
            })
            vtslsConn.sendNotification.mockImplementation((method: string, params?: unknown) => {
                const typedParams = params as { textDocument?: { uri?: string } }
                if (method === 'textDocument/didOpen' && typedParams?.textDocument?.uri === targetUri) {
                    targetOpened = true
                }
                if (method === 'textDocument/didClose' && typedParams?.textDocument?.uri === targetUri) {
                    targetOpened = false
                }
            })

            vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
                if (method === 'textDocument/prepareCallHierarchy') {
                    const typedParams = params as { textDocument?: { uri?: string } }
                    if (typedParams.textDocument?.uri === 'file:///workspace/components/ScenarioOverview.vue') {
                        return []
                    }
                    if (!targetOpened) {
                        return []
                    }
                    return [
                        {
                            uri: targetUri,
                            name: 'buildSummary',
                            kind: 12,
                            range: {
                                start: { line: 1, character: 2 },
                                end: { line: 3, character: 3 }
                            },
                            selectionRange: {
                                start: { line: 1, character: 11 },
                                end: { line: 1, character: 30 }
                            },
                            data: { id: 7 }
                        }
                    ]
                }
                if (method === 'textDocument/definition') {
                    return [
                        {
                            uri: targetUri,
                            range: {
                                start: { line: 5, character: 4 },
                                end: { line: 5, character: 23 }
                            }
                        }
                    ]
                }
                if (method === 'textDocument/documentSymbol') {
                    return [
                        {
                            name: 'useSummaryBuilder',
                            kind: 12,
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 8, character: 1 }
                            },
                            selectionRange: {
                                start: { line: 0, character: 16 },
                                end: { line: 0, character: 33 }
                            }
                        },
                        {
                            name: 'buildSummary',
                            kind: 12,
                            range: {
                                start: { line: 1, character: 2 },
                                end: { line: 3, character: 3 }
                            },
                            selectionRange: {
                                start: { line: 1, character: 11 },
                                end: { line: 1, character: 30 }
                            }
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = await upstream.triggerRequest('textDocument/prepareCallHierarchy', {
                textDocument: {
                    uri: 'file:///workspace/components/ScenarioOverview.vue'
                },
                position: { line: 2, character: 8 }
            })

            expect(result).toEqual([
                {
                    uri: targetUri,
                    name: 'buildSummary',
                    kind: 12,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 3, character: 3 }
                    },
                    selectionRange: {
                        start: { line: 1, character: 11 },
                        end: { line: 1, character: 30 }
                    },
                    data: { id: 7 }
                }
            ])
            expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/definition', {
                textDocument: {
                    uri: 'file:///workspace/components/ScenarioOverview.vue'
                },
                position: { line: 2, character: 8 }
            })
            expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/prepareCallHierarchy', {
                textDocument: { uri: targetUri },
                position: { line: 1, character: 11 }
            })
            expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
                textDocument: {
                    uri: targetUri,
                    languageId: 'typescript',
                    version: 1,
                    text: targetText
                }
            })
            expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', {
                textDocument: { uri: targetUri }
            })
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })
})

describe('server capability logging', () => {
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
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    it('logs vtsls capabilities after initialization', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize')
                return {
                    capabilities: { definitionProvider: true, hoverProvider: true }
                }
            return { capabilities: {} }
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        expect(logger.info).toHaveBeenCalledWith('proxy', expect.stringContaining('vtsls capabilities'))
        expect(logger.info).toHaveBeenCalledWith('proxy', expect.stringContaining('"definitionProvider":true'))
    })

    it('logs vue_ls capabilities after initialization', async () => {
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'initialize') return { capabilities: { completionProvider: true } }
            return { capabilities: {} }
        })

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)

        expect(logger.info).toHaveBeenCalledWith('proxy', expect.stringContaining('vue_ls capabilities'))
        expect(logger.info).toHaveBeenCalledWith('proxy', expect.stringContaining('"completionProvider":true'))
    })
})

describe('documentSymbol routing for .vue files', () => {
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
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    it('forwards documentSymbol for .vue file to vue_ls', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()
        vueLsConn.sendRequest.mockClear()

        vueLsConn.sendRequest.mockResolvedValue([{ name: 'template', kind: 1 }])
        const params = { textDocument: { uri: 'file:///App.vue' } }
        const result = await upstream.triggerRequest('textDocument/documentSymbol', params)

        expect(vueLsConn.sendRequest).toHaveBeenCalledWith('textDocument/documentSymbol', params)
        expect(vtslsConn.sendRequest).not.toHaveBeenCalledWith('textDocument/documentSymbol', expect.anything())
        expect(result).toEqual([{ name: 'template', kind: 1 }])
    })

    it('forwards documentSymbol for .ts file to vtsls', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()
        vueLsConn.sendRequest.mockClear()

        vtslsConn.sendRequest.mockResolvedValue([{ name: 'MyClass', kind: 5 }])
        const params = { textDocument: { uri: 'file:///foo.ts' } }
        const result = await upstream.triggerRequest('textDocument/documentSymbol', params)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/documentSymbol', params)
        expect(vueLsConn.sendRequest).not.toHaveBeenCalledWith('textDocument/documentSymbol', expect.anything())
        expect(result).toEqual([{ name: 'MyClass', kind: 5 }])
    })

    it('normalizes misclassified TypeScript document symbols away from Variable', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/app/js/domain/types.ts',
                languageId: 'typescript',
                version: 1,
                text: `export type Brand<T, B extends string> = T & { readonly __brand: B }\nexport interface VisibilityMap {\n  [key: string]: boolean\n}\n`
            }
        })

        vtslsConn.sendRequest.mockResolvedValue([
            {
                name: 'Brand',
                kind: 13,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 66 }
                },
                selectionRange: {
                    start: { line: 0, character: 12 },
                    end: { line: 0, character: 17 }
                }
            },
            {
                name: 'VisibilityMap',
                kind: 13,
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 3, character: 1 }
                },
                selectionRange: {
                    start: { line: 1, character: 17 },
                    end: { line: 1, character: 31 }
                }
            }
        ])

        const result = await upstream.triggerRequest('textDocument/documentSymbol', {
            textDocument: { uri: 'file:///workspace/app/js/domain/types.ts' }
        })

        expect(result).toEqual([
            {
                name: 'Brand',
                kind: 26,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 66 }
                },
                selectionRange: {
                    start: { line: 0, character: 12 },
                    end: { line: 0, character: 17 }
                }
            },
            {
                name: 'VisibilityMap',
                kind: 11,
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 3, character: 1 }
                },
                selectionRange: {
                    start: { line: 1, character: 17 },
                    end: { line: 1, character: 31 }
                }
            }
        ])
    })

    it('warns when vue_ls returns no document symbols for a .vue file', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vi.mocked(logger.warn).mockClear()

        vueLsConn.sendRequest.mockResolvedValue([])
        await upstream.triggerRequest('textDocument/documentSymbol', {
            textDocument: { uri: 'file:///App.vue' }
        })

        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('via vue_ls returned no symbols'))
    })
})

describe('tsserver/request logging', () => {
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
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    it('logs tsserver/request command and id at debug level', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vi.mocked(logger.debug).mockClear()

        vtslsConn.sendRequest.mockResolvedValue({ body: { result: 'data' } })
        vueLsConn.triggerNotification('tsserver/request', [[42, 'getDefinition', { file: 'test.vue' }]])
        await new Promise<void>((r) => setTimeout(r, 0))

        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('tsserver/request #42 getDefinition'))
    })

    it('logs tsserver/response body summary at debug level', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vi.mocked(logger.debug).mockClear()

        vtslsConn.sendRequest.mockResolvedValue({ body: { result: 'data' } })
        vueLsConn.triggerNotification('tsserver/request', [[42, 'getDefinition', { file: 'test.vue' }]])
        await new Promise<void>((r) => setTimeout(r, 0))

        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('tsserver/response #42'))
    })

    it('logs tsserver/request errors at warn level', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vi.mocked(logger.warn).mockClear()

        vtslsConn.sendRequest.mockRejectedValue(new Error('vtsls crashed'))
        vueLsConn.triggerNotification('tsserver/request', [[99, 'getQuickInfo', { file: 'foo.vue' }]])
        await new Promise<void>((r) => setTimeout(r, 0))

        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('ERROR'))
    })
})

describe('window/logMessage forwarding', () => {
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
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
    })

    it('forwards window/logMessage from vtsls to upstream', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        upstream.sendNotification.mockClear()
        vi.mocked(logger.debug).mockClear()

        vtslsConn.triggerNotification('window/logMessage', {
            type: 3,
            message: 'some info'
        })

        expect(upstream.sendNotification).toHaveBeenCalledWith('window/logMessage', {
            type: 3,
            message: '[vtsls] some info'
        })
        expect(logger.debug).toHaveBeenCalledWith('vtsls', 'some info')
    })

    it('forwards window/logMessage from vue_ls to upstream', async () => {
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        upstream.sendNotification.mockClear()
        vi.mocked(logger.debug).mockClear()

        vueLsConn.triggerNotification('window/logMessage', {
            type: 3,
            message: 'vue info'
        })

        expect(upstream.sendNotification).toHaveBeenCalledWith('window/logMessage', {
            type: 3,
            message: '[vue_ls] vue info'
        })
        expect(logger.debug).toHaveBeenCalledWith('vue_ls', 'vue info')
    })

    it('re-registers window/logMessage handler after vtsls crash recovery', async () => {
        const newVtsls = createMockConnection()
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection, {
            spawnVtsls: () => newVtsls as unknown as MessageConnection,
            delayMs: 0
        })
        await upstream.triggerRequest('initialize', initParams)

        vtslsConn.triggerClose()
        await new Promise<void>((r) => setTimeout(r, 0))
        await Promise.resolve()

        upstream.sendNotification.mockClear()
        vi.mocked(logger.debug).mockClear()

        newVtsls.triggerNotification('window/logMessage', {
            type: 3,
            message: 'after crash'
        })

        expect(upstream.sendNotification).toHaveBeenCalledWith('window/logMessage', {
            type: 3,
            message: '[vtsls] after crash'
        })
        expect(logger.debug).toHaveBeenCalledWith('vtsls', 'after crash')
    })
})

const VUE_FIXTURE = `<template>
  <div class="container">
    <button @click="handleClick" v-if="isVisible">
      {{ label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  label: string
  initialCount?: number
}>()

const emit = defineEmits<{
  (e: 'click', count: number): void
}>()

const count = ref(props.initialCount ?? 0)
const isVisible = computed(() => count.value >= 0)

function handleClick() {
  count.value++
  emit('click', count.value)
}
</script>

<style scoped>
.container {
  padding: 1rem;
}
</style>`

const TS_FIXTURE = `import { ref, computed } from 'vue'
import type { Ref } from 'vue'

export interface AppState {
  count: number
  label: string
}

export function createState(initial: number): AppState {
  return { count: initial, label: 'default' }
}

function helper(value: number): number {
  return value * 2
}`

describe('didChange full-document replacement patching', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(async () => {
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()
        vi.mocked(logger.debug).mockClear()
    })

    it('patches full-doc replacement with a range based on original content before forwarding to vtsls', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()

        const newContent = TS_FIXTURE + '\nexport const extra = true;'
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        const call = vtslsConn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
        expect(call).toBeDefined()
        const params = call![1] as {
            contentChanges: Array<{ range?: unknown; text: string }>
        }
        expect(params.contentChanges[0].range).toBeDefined()

        const range = params.contentChanges[0].range as {
            start: { line: number; character: number }
            end: { line: number; character: number }
        }
        expect(range.start).toEqual({ line: 0, character: 0 })

        const originalLines = TS_FIXTURE.split('\n')
        expect(range.end).toEqual({
            line: originalLines.length - 1,
            character: originalLines[originalLines.length - 1]!.length
        })
    })

    it('passes incremental changes through unchanged', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()

        const incrementalParams = {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 6 }
                    },
                    text: 'import'
                }
            ]
        }
        upstream.triggerNotification('textDocument/didChange', incrementalParams)

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', incrementalParams)
    })

    it('patches full-doc replacement for .vue files and forwards to both servers', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///App.vue',
                languageId: 'vue',
                version: 1,
                text: VUE_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()

        const newContent = VUE_FIXTURE.replace('padding: 1rem;', 'padding: 1rem;\n  margin: 0;')
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///App.vue', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        const oldLines = VUE_FIXTURE.split('\n')
        const expectedEnd = {
            line: oldLines.length - 1,
            character: oldLines[oldLines.length - 1]!.length
        }

        for (const conn of [vtslsConn, vueLsConn]) {
            const call = conn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
            expect(call).toBeDefined()
            const params = call![1] as { contentChanges: Array<{ range?: unknown }> }
            const range = params.contentChanges[0].range as {
                start: { line: number; character: number }
                end: { line: number; character: number }
            }
            expect(range.start).toEqual({ line: 0, character: 0 })
            expect(range.end).toEqual(expectedEnd)
        }
    })

    it('keeps DocumentStore content in sync after patching forwarded changes', () => {
        const freshUp = createMockConnection()
        const freshVtsls = createMockConnection()
        const freshVueLs = createMockConnection()
        const store = setupProxy(
            freshUp as unknown as MessageConnection,
            freshVtsls as unknown as MessageConnection,
            freshVueLs as unknown as MessageConnection
        )

        freshUp.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        const newContent = TS_FIXTURE + '\n// added'
        freshUp.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        expect(store.get('file:///foo.ts')?.content).toBe(newContent)
    })

    it('logs when patching a full-doc replacement', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vi.mocked(logger.debug).mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: TS_FIXTURE + '\n' }]
        })

        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('patched full-doc replacement'))
    })

    it('forwards unknown-URI didChange notifications without patching', () => {
        const params = {
            textDocument: { uri: 'file:///unknown.ts', version: 1 },
            contentChanges: [{ text: 'const x = 1;' }]
        }
        expect(() => {
            upstream.triggerNotification('textDocument/didChange', params)
        }).not.toThrow()

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', params)
    })

    it('uses the original content bounds when a file shrinks', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()

        const shortContent = 'export const x = 1;'
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: shortContent }]
        })

        const call = vtslsConn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
        const params = call![1] as { contentChanges: Array<{ range?: unknown }> }
        const range = params.contentChanges[0].range as {
            start: { line: number; character: number }
            end: { line: number; character: number }
        }

        const originalLines = TS_FIXTURE.split('\n')
        expect(range.end).toEqual({
            line: originalLines.length - 1,
            character: originalLines[originalLines.length - 1]!.length
        })
    })

    it('uses original bounds for the 392-line crash repro', () => {
        const originalLines = Array.from({ length: 391 }, (_, i) => `// line ${i + 1}`)
        originalLines.push('}')
        const originalContent = originalLines.join('\n') + '\n'

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///misc.ts',
                languageId: 'typescript',
                version: 1,
                text: originalContent
            }
        })
        vtslsConn.sendNotification.mockClear()

        const newContent = originalContent + 'const badVar = true;\n'
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///misc.ts', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        const call = vtslsConn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
        const params = call![1] as { contentChanges: Array<{ range?: unknown }> }
        const range = params.contentChanges[0].range as {
            start: { line: number; character: number }
            end: { line: number; character: number }
        }

        expect(range.end).toEqual({ line: 392, character: 0 })
        expect(range.end.line).not.toBe(393)
    })
})
