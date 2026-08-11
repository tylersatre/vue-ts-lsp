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
        expect(caps['diagnosticProvider']).toEqual({
            interFileDependencies: true,
            workspaceDiagnostics: false
        })
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
