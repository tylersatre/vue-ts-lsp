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

    it('sends exit notification to both servers and calls process.exit(0)', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)

        upstream.triggerNotification('exit')

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('exit')
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('exit')

        // exit is deferred one microtask behind the log flush
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(exitSpy).toHaveBeenCalledWith(0)

        exitSpy.mockRestore()
    })

    it('flushes file logging before exiting on the exit notification', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
        vi.mocked(logger.closeFileLogging).mockClear()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)

        upstream.triggerNotification('exit')
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(logger.closeFileLogging).toHaveBeenCalled()
        expect(exitSpy).toHaveBeenCalledWith(0)

        exitSpy.mockRestore()
    })

    it('does not re-run child shutdown when the upstream closes after the LSP shutdown request', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockResolvedValue(null)
        vueLsConn.sendRequest.mockResolvedValue(null)

        await upstream.triggerRequest('shutdown')
        const shutdownCalls = () => vtslsConn.sendRequest.mock.calls.filter(([method]) => method === 'shutdown').length
        expect(shutdownCalls()).toBe(1)

        upstream.triggerClose()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(shutdownCalls()).toBe(1)
        expect(exitSpy).toHaveBeenCalledWith(0)

        exitSpy.mockRestore()
    })

    it('shuts down both children, flushes logs, and exits when the upstream connection closes', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
        vi.mocked(logger.closeFileLogging).mockClear()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockResolvedValue(null)
        vueLsConn.sendRequest.mockResolvedValue(null)

        // Claude Code dying without the shutdown/exit handshake (SIGKILL, OOM, crash)
        // surfaces here as the upstream connection closing.
        upstream.triggerClose()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('shutdown')
        expect(vueLsConn.sendRequest).toHaveBeenCalledWith('shutdown')
        expect(logger.closeFileLogging).toHaveBeenCalled()
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
describe('notification write failure resilience', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    beforeEach(() => {
        vi.mocked(logger.warn).mockClear()
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
    })

    it('logs instead of leaking an unhandled rejection when a didChange write to vtsls fails', async () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///foo.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' }
        })
        vtslsConn.sendNotification.mockImplementation(() => Promise.reject(new Error('write EPIPE')))

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: 'const x = 2;' }]
        })
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('write EPIPE'))
    })

    it('logs instead of leaking an unhandled rejection when the tsserver/response write fails', async () => {
        await upstream.triggerRequest('initialize', {
            rootUri: 'file:///workspace',
            workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
            capabilities: {}
        })
        vtslsConn.sendRequest.mockResolvedValue({ body: { ok: true } })
        vueLsConn.sendNotification.mockImplementation(() => Promise.reject(new Error('write EPIPE')))

        vueLsConn.triggerNotification('tsserver/request', [7, 'quickinfo', { file: '/workspace/foo.ts' }])
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('tsserver/response'))
    })

    it('logs instead of leaking an unhandled rejection when forwarding publishDiagnostics upstream fails', async () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///foo.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' }
        })
        upstream.sendNotification.mockImplementation(() => Promise.reject(new Error('write EPIPE')))

        vtslsConn.triggerNotification('textDocument/publishDiagnostics', { uri: 'file:///foo.ts', diagnostics: [] })
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('write EPIPE'))
    })
})
