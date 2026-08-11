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
                    log: 'off'
                })
            })
        )
    })
})
