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

describe('document lifecycle self-healing', () => {
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

    it('converts a full-text didChange for an unopened .ts document into didOpen', () => {
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/orphan.ts', version: 7 },
            contentChanges: [{ text: 'const healed = true;' }]
        })

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/orphan.ts',
                languageId: 'typescript',
                version: 7,
                text: 'const healed = true;'
            }
        })
        expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didChange', expect.anything())
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('converts a full-text didChange for an unopened .vue document into didOpen on both servers', () => {
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/Orphan.vue', version: 3 },
            contentChanges: [{ text: '<template><div/></template>' }]
        })

        const expected = {
            textDocument: {
                uri: 'file:///workspace/Orphan.vue',
                languageId: 'vue',
                version: 3,
                text: '<template><div/></template>'
            }
        }
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', expected)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', expected)
        expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didChange', expect.anything())
    })

    it('tracks the healed document so later didChanges apply normally', () => {
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/orphan.ts', version: 7 },
            contentChanges: [{ text: 'const healed = true;' }]
        })
        vtslsConn.sendNotification.mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/orphan.ts', version: 8 },
            contentChanges: [{ text: 'const healed = false;' }]
        })

        const didChangeCall = vtslsConn.sendNotification.mock.calls.find(([method]) => method === 'textDocument/didChange')
        expect(didChangeCall).toBeDefined()
        const forwarded = didChangeCall![1] as { contentChanges: Array<{ range?: unknown; text: string }> }
        expect(forwarded.contentChanges[0]!.text).toBe('const healed = false;')
        expect(forwarded.contentChanges[0]!.range).toEqual({
            start: { line: 0, character: 0 },
            end: { line: 0, character: 20 }
        })
    })

    it('leaves ranged didChanges for unopened documents untouched', () => {
        const params = {
            textDocument: { uri: 'file:///workspace/orphan.ts', version: 2 },
            contentChanges: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    text: 'x'
                }
            ]
        }
        upstream.triggerNotification('textDocument/didChange', params)

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', params)
        expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('forwards didOpen for an already-open document as a ranged full-document didChange', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///workspace/App.vue', languageId: 'vue', version: 1, text: 'old content' }
        })
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///workspace/App.vue', languageId: 'vue', version: 1, text: 'new content' }
        })

        // The synthesized didChange re-uses the incoming didOpen version so child-server
        // numbering realigns with the client's counter from here on.
        const expectedChange = {
            textDocument: { uri: 'file:///workspace/App.vue', version: 1 },
            contentChanges: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } },
                    text: 'new content'
                }
            ]
        }
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', expectedChange)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', expectedChange)
        expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('opens an on-disk document before forwarding a request for it', async () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-'))
        const filePath = path.join(workDir, 'orphan.ts')
        fs.writeFileSync(filePath, 'export const fromDisk = 1;')
        const uri = pathToFileURL(filePath).href
        try {
            vtslsConn.sendRequest.mockResolvedValue({ contents: 'hover' })

            await upstream.triggerRequest('textDocument/hover', {
                textDocument: { uri },
                position: { line: 0, character: 14 }
            })

            expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
                textDocument: {
                    uri,
                    languageId: 'typescript',
                    version: 1,
                    text: 'export const fromDisk = 1;'
                }
            })
            const openIndex = vtslsConn.sendNotification.mock.calls.findIndex(([method]) => method === 'textDocument/didOpen')
            const hoverIndex = vtslsConn.sendRequest.mock.calls.findIndex(([method]) => method === 'textDocument/hover')
            expect(openIndex).toBeGreaterThanOrEqual(0)
            expect(hoverIndex).toBeGreaterThanOrEqual(0)
            expect(vtslsConn.sendNotification.mock.invocationCallOrder[openIndex]!).toBeLessThan(vtslsConn.sendRequest.mock.invocationCallOrder[hoverIndex]!)
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true })
        }
    })

    it('does not synthesize didOpen for requests on files missing from disk', async () => {
        await upstream.triggerRequest('textDocument/hover', {
            textDocument: { uri: 'file:///definitely/not/on/disk.ts' },
            position: { line: 0, character: 0 }
        })

        expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
    })

    it('does not synthesize didOpen for files over the 10MB self-heal cap', async () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-cap-'))
        const filePath = path.join(workDir, 'huge.ts')
        fs.writeFileSync(filePath, Buffer.alloc(10_000_001, 0x20))
        try {
            await upstream.triggerRequest('textDocument/hover', {
                textDocument: { uri: pathToFileURL(filePath).href },
                position: { line: 0, character: 0 }
            })

            expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true })
        }
    })

    it('does not synthesize didOpen when the URI points at a directory', async () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-dir-'))
        const dirPath = path.join(workDir, 'not-a-file.ts')
        fs.mkdirSync(dirPath)
        try {
            await upstream.triggerRequest('textDocument/hover', {
                textDocument: { uri: pathToFileURL(dirPath).href },
                position: { line: 0, character: 0 }
            })

            expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything())
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true })
        }
    })

    it('opens an on-disk document before serving a pull-diagnostics request for it', async () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-pull-'))
        const filePath = path.join(workDir, 'orphan.ts')
        fs.writeFileSync(filePath, 'export const fromDisk = 1;')
        const uri = pathToFileURL(filePath).href
        try {
            vtslsConn.sendRequest.mockResolvedValue({ body: [] })

            await upstream.triggerRequest('textDocument/diagnostic', {
                textDocument: { uri }
            })

            expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
                textDocument: {
                    uri,
                    languageId: 'typescript',
                    version: 1,
                    text: 'export const fromDisk = 1;'
                }
            })
            const openIndex = vtslsConn.sendNotification.mock.calls.findIndex(([method]) => method === 'textDocument/didOpen')
            const diagIndex = vtslsConn.sendRequest.mock.calls.findIndex(([method]) => method === 'workspace/executeCommand')
            expect(openIndex).toBeGreaterThanOrEqual(0)
            expect(diagIndex).toBeGreaterThanOrEqual(0)
            expect(vtslsConn.sendNotification.mock.invocationCallOrder[openIndex]!).toBeLessThan(vtslsConn.sendRequest.mock.invocationCallOrder[diagIndex]!)
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true })
        }
    })
})
describe('client LRU eviction cycle (didClose then re-didOpen)', () => {
    // Claude Code >= 2.1.208 evicts documents past a 50-open-doc LRU cap: the evicted
    // doc gets a didClose, and a fresh didOpen when touched again. Formerly dead code
    // against 2.1.204, now a real client-driven path.
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection
    let documentStore: import('@src/documents.js').DocumentStore

    const vueUri = 'file:///workspace/Evicted.vue'
    const tsUri = 'file:///workspace/evicted.ts'

    beforeEach(() => {
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()
        documentStore = setupProxy(
            upstream as unknown as MessageConnection,
            vtslsConn as unknown as MessageConnection,
            vueLsConn as unknown as MessageConnection
        )
    })

    function diagnostic(message: string): { range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string } {
        return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message }
    }

    it('forwards didClose for a .vue doc to both servers and cleans up stores', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: vueUri, languageId: 'vue', version: 1, text: '<template><div/></template>' }
        })
        expect(documentStore.get(vueUri)).toBeDefined()

        const closeParams = { textDocument: { uri: vueUri } }
        upstream.triggerNotification('textDocument/didClose', closeParams)

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', closeParams)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', closeParams)
        expect(documentStore.get(vueUri)).toBeUndefined()
    })

    it('forwards didClose for a .ts doc to vtsls only', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: tsUri, languageId: 'typescript', version: 1, text: 'const x = 1;' }
        })
        const closeParams = { textDocument: { uri: tsUri } }
        upstream.triggerNotification('textDocument/didClose', closeParams)

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', closeParams)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didClose', expect.anything())
        expect(documentStore.get(tsUri)).toBeUndefined()
    })

    it('treats a re-didOpen after eviction as a fresh open, not the repeated-didOpen self-heal', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: vueUri, languageId: 'vue', version: 1, text: '<template><div/></template>' }
        })
        upstream.triggerNotification('textDocument/didClose', { textDocument: { uri: vueUri } })
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()

        const reopenParams = {
            textDocument: { uri: vueUri, languageId: 'vue', version: 1, text: '<template><span/></template>' }
        }
        upstream.triggerNotification('textDocument/didOpen', reopenParams)

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', reopenParams)
        expect(vueLsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', reopenParams)
        expect(vtslsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didChange', expect.anything())
        expect(documentStore.get(vueUri)?.content).toBe('<template><span/></template>')
    })

    it('does not blend pre-eviction diagnostics into the merged view after re-open', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: vueUri, languageId: 'vue', version: 1, text: '<template><div/></template>' }
        })
        // Both servers publish before eviction; merged view contains both entries.
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', { uri: vueUri, diagnostics: [diagnostic('stale vue_ls error')] })
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', { uri: vueUri, diagnostics: [diagnostic('vtsls error')] })

        upstream.triggerNotification('textDocument/didClose', { textDocument: { uri: vueUri } })
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: vueUri, languageId: 'vue', version: 1, text: '<template><div/></template>' }
        })
        upstream.sendNotification.mockClear()

        vtslsConn.triggerNotification('textDocument/publishDiagnostics', { uri: vueUri, diagnostics: [diagnostic('fresh vtsls error')] })

        const forwarded = upstream.sendNotification.mock.calls.filter(([method]) => method === 'textDocument/publishDiagnostics')
        expect(forwarded).toHaveLength(1)
        const payload = forwarded[0]![1] as { diagnostics: Array<{ message: string }> }
        expect(payload.diagnostics.map((d) => d.message)).toEqual(['fresh vtsls error'])
    })

    it('resumes version stamping from the fresh open after the cycle', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: vueUri, languageId: 'vue', version: 7, text: '<template><div/></template>' }
        })
        upstream.triggerNotification('textDocument/didClose', { textDocument: { uri: vueUri } })
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: vueUri, languageId: 'vue', version: 9, text: '<template><div/></template>' }
        })
        upstream.sendNotification.mockClear()

        vtslsConn.triggerNotification('textDocument/publishDiagnostics', { uri: vueUri, diagnostics: [] })

        const forwarded = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(forwarded).toBeDefined()
        expect((forwarded![1] as { version?: number }).version).toBe(9)
    })
})
