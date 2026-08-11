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

    it('nudges Vue diagnostics with a debounced geterr request after didOpen', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendRequest.mockClear()

        try {
            upstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: 'file:///workspace/components/App.vue',
                    languageId: 'vue',
                    version: 1,
                    text: '<template><div>{{ count }}</div></template>\n<script setup lang="ts">const count: string = 1</script>'
                }
            })
            await vi.advanceTimersByTimeAsync(150)

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
            vi.useRealTimers()
        }
    })

    it('returns pull diagnostics from vtsls tsserver requests', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'workspace/executeCommand') {
                const command = (params as { arguments?: unknown[] }).arguments?.[0]
                if (command === 'semanticDiagnosticsSync') {
                    return {
                        body: [
                            {
                                start: { line: 2, offset: 7 },
                                end: { line: 2, offset: 12 },
                                text: "Type 'number' is not assignable to type 'string'.",
                                code: 2322,
                                category: 'error'
                            }
                        ]
                    }
                }
                return { body: [] }
            }
            return { capabilities: {} }
        })
        await upstream.triggerRequest('initialize', initParams)

        const result = await upstream.triggerRequest('textDocument/diagnostic', {
            textDocument: { uri: 'file:///workspace/components/App.vue' }
        })

        expect(result).toEqual({
            kind: 'full',
            items: [
                {
                    range: {
                        start: { line: 1, character: 6 },
                        end: { line: 1, character: 11 }
                    },
                    severity: 1,
                    source: 'ts',
                    message: "Type 'number' is not assignable to type 'string'.",
                    code: 2322
                }
            ]
        })
    })

    it('merges stored vue_ls diagnostics into pull diagnostics for .vue documents', async () => {
        const tsserverItem = {
            range: {
                start: { line: 1, character: 6 },
                end: { line: 1, character: 11 }
            },
            severity: 1,
            source: 'ts',
            message: "Type 'number' is not assignable to type 'string'.",
            code: 2322
        }
        const vueLsDiag = {
            range: {
                start: { line: 3, character: 0 },
                end: { line: 3, character: 4 }
            },
            severity: 2,
            source: 'vue',
            message: 'Vue-specific warning'
        }
        vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
            if (method === 'initialize') return { capabilities: {} }
            if (method === 'workspace/executeCommand') {
                const command = (params as { arguments?: unknown[] }).arguments?.[0]
                if (command === 'semanticDiagnosticsSync') {
                    return {
                        body: [
                            {
                                start: { line: 2, offset: 7 },
                                end: { line: 2, offset: 12 },
                                text: "Type 'number' is not assignable to type 'string'.",
                                code: 2322,
                                category: 'error'
                            }
                        ]
                    }
                }
                return { body: [] }
            }
            return { capabilities: {} }
        })
        await upstream.triggerRequest('initialize', initParams)

        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///workspace/components/App.vue',
            diagnostics: [vueLsDiag]
        })

        const result = (await upstream.triggerRequest('textDocument/diagnostic', {
            textDocument: { uri: 'file:///workspace/components/App.vue' }
        })) as { kind: string; items: unknown[] }

        expect(result.kind).toBe('full')
        expect(result.items).toEqual(expect.arrayContaining([tsserverItem, vueLsDiag]))
        expect(result.items).toHaveLength(2)
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
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///foo.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' }
        })
        vtslsConn.sendNotification.mockClear()
        const params = {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [
                {
                    range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
                    text: '2'
                }
            ]
        }
        upstream.triggerNotification('textDocument/didChange', params)
        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', params)
        expect(vueLsConn.sendNotification).not.toHaveBeenCalledWith('textDocument/didChange', expect.anything())
    })

    it('forwards didChange for .vue file to both servers', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///App.vue', languageId: 'vue', version: 1, text: '<template><span/></template>' }
        })
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()
        const params = {
            textDocument: { uri: 'file:///App.vue', version: 2 },
            contentChanges: [
                {
                    range: { start: { line: 0, character: 11 }, end: { line: 0, character: 15 } },
                    text: 'div/'
                }
            ]
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

    it('does not treat vue_ls publishes as fresh vtsls diagnostics when deciding to nudge', async () => {
        vi.useFakeTimers()
        await upstream.triggerRequest('initialize', initParams)

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
            // Only vue_ls publishes — that must not satisfy the vtsls freshness check,
            // or TypeScript diagnostics go stale after edits.
            vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
                uri: 'file:///workspace/components/App.vue',
                diagnostics: []
            })
            await vi.advanceTimersByTimeAsync(4000)

            const geterrNudges = vtslsConn.sendRequest.mock.calls.filter(
                ([method, params]) =>
                    method === 'workspace/executeCommand' &&
                    Array.isArray((params as { arguments?: unknown[] }).arguments) &&
                    (params as { arguments: unknown[] }).arguments[0] === 'geterr'
            )
            expect(geterrNudges.length).toBeGreaterThan(0)
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

    it('stamps forwarded vtsls diagnostics with the open document version', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///foo.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' }
        })
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 4 },
            contentChanges: [{ text: 'const x: string = 1;' }]
        })
        upstream.sendNotification.mockClear()

        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///foo.ts',
            diagnostics: [
                {
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
                    message: 'Type error'
                }
            ]
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect((publish![1] as { version?: number }).version).toBe(4)
    })

    it('preserves a downstream-provided version when the document is not open', () => {
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [],
            version: 7
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect((publish![1] as { version?: number }).version).toBe(7)
    })

    it('prefers the downstream version over the document store version', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///App.vue', languageId: 'vue', version: 5, text: '<template><div/></template>' }
        })
        upstream.sendNotification.mockClear()

        // vue_ls reports the version it actually diagnosed (an in-flight pre-edit publish)
        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [],
            version: 4
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect((publish![1] as { version?: number }).version).toBe(4)
    })

    it('stamps merged .vue diagnostics with the store version when downstream omits it', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///App.vue', languageId: 'vue', version: 2, text: '<template><div/></template>' }
        })
        upstream.sendNotification.mockClear()

        // vtsls never includes a version in publishDiagnostics
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                    message: 'TS error'
                }
            ]
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect((publish![1] as { version?: number }).version).toBe(2)
    })

    it('omits version when the document is unknown and downstream sent none', () => {
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///never-opened.ts',
            diagnostics: []
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect('version' in (publish![1] as Record<string, unknown>)).toBe(false)
    })

    it('drops stored diagnostics on didClose so a reopen does not blend stale entries', () => {
        const staleVtslsDiag = {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: 'Stale TS error'
        }
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///App.vue', languageId: 'vue', version: 1, text: '<template/>' }
        })
        vtslsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: [staleVtslsDiag]
        })
        upstream.triggerNotification('textDocument/didClose', { textDocument: { uri: 'file:///App.vue' } })
        upstream.sendNotification.mockClear()

        vueLsConn.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///App.vue',
            diagnostics: []
        })

        const publish = upstream.sendNotification.mock.calls.find(([method]) => method === 'textDocument/publishDiagnostics')
        expect(publish).toBeDefined()
        expect((publish![1] as { diagnostics: unknown[] }).diagnostics).toEqual([])
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
