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
