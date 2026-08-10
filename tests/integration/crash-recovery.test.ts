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

    it('clears stored vtsls diagnostics on recovery so merges do not blend pre-crash entries', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVtsls = createMockConnection()

        await initProxy(upstream, vtslsConn, vueLsConn, () => newVtsls)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///App.vue', languageId: 'vue', version: 1, text: '<template/>' }
        })
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                    message: 'Pre-crash TS error'
                }
            ]
        })

        vtslsConn.triggerClose()
        await flushRecovery()

        upstream.sendNotification.mockClear()
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: []
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect((publish![1] as { diagnostics: unknown[] }).diagnostics).toEqual([])
    })

    it('clears stored vue_ls diagnostics on recovery so merges do not blend pre-crash entries', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const newVueLs = createMockConnection()

        await initProxy(upstream, vtslsConn, vueLsConn, undefined, () => newVueLs)

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///App.vue', languageId: 'vue', version: 1, text: '<template/>' }
        })
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
                    message: 'Pre-crash Vue error'
                }
            ]
        })

        vueLsConn.triggerClose()
        await flushRecovery()

        upstream.sendNotification.mockClear()
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: []
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect((publish![1] as { diagnostics: unknown[] }).diagnostics).toEqual([])
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
