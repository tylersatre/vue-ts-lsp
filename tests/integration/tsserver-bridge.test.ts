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
