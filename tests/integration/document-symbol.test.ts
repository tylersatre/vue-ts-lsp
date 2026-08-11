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
