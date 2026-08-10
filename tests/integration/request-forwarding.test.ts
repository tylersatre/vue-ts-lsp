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

    it('forwards textDocument/implementation for .ts file to vtsls end to end', async () => {
        const params = {
            textDocument: { uri: 'file:///foo.ts' },
            position: { line: 2, character: 7 }
        }
        vtslsConn.sendRequest.mockResolvedValue([{ uri: 'file:///impl.ts', range: {} }])

        const result = await upstream.triggerRequest('textDocument/implementation', params)

        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/implementation', params)
        expect(vueLsConn.sendRequest).not.toHaveBeenCalledWith('textDocument/implementation', expect.anything())
        expect(result).toEqual([{ uri: 'file:///impl.ts', range: {} }])
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
