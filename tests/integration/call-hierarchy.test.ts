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

describe('.vue call hierarchy fallbacks', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(async () => {
        vi.clearAllMocks()
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
    })

    it('builds incoming call hierarchy entries from references when vtsls returns none for .vue', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'callHierarchy/incomingCalls') return []
            if (method === 'textDocument/references') {
                return [
                    {
                        uri: 'file:///workspace/App.vue',
                        range: {
                            start: { line: 2, character: 16 },
                            end: { line: 2, character: 21 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/documentSymbol') {
                return [
                    {
                        name: 'template',
                        kind: 2,
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 3, character: 0 }
                        },
                        selectionRange: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 8 }
                        },
                        children: [
                            {
                                name: 'button.action-button',
                                kind: 8,
                                range: {
                                    start: { line: 1, character: 2 },
                                    end: { line: 2, character: 30 }
                                },
                                selectionRange: {
                                    start: { line: 1, character: 3 },
                                    end: { line: 1, character: 9 }
                                }
                            }
                        ]
                    }
                ]
            }
            return { capabilities: {} }
        })

        const result = (await upstream.triggerRequest('callHierarchy/incomingCalls', {
            item: {
                uri: 'file:///workspace/App.vue',
                name: 'click',
                kind: 12,
                range: {
                    start: { line: 6, character: 0 },
                    end: { line: 8, character: 1 }
                },
                selectionRange: {
                    start: { line: 6, character: 6 },
                    end: { line: 6, character: 11 }
                }
            }
        })) as Array<{ from: { name: string }; fromSpans: unknown[] }>

        expect(result).toHaveLength(1)
        expect(result[0]?.from.name).toBe('button.action-button')
        expect(result[0]?.fromSpans).toHaveLength(1)
    })

    it('builds incoming call hierarchy entries for TS store methods called from Vue templates', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-callers-'))
        const storePath = path.join(tempWorkspace, 'pinia', 'estimates.ts')
        const componentPath = path.join(tempWorkspace, 'components', 'ItemDetails.vue')
        fs.mkdirSync(path.dirname(storePath), { recursive: true })
        fs.mkdirSync(path.dirname(componentPath), { recursive: true })
        fs.writeFileSync(storePath, `export const useScenariosStore = () => ({\n  runScenarioPreview() {\n    return 1\n  },\n})\n`)
        fs.writeFileSync(
            componentPath,
            `<template>\n  <button @click="scenariosStore.runScenarioPreview()">Preview Scenario</button>\n</template>\n\n<script setup lang="ts">\nconst scenariosStore = useScenariosStore()\n</script>\n`
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
                    uri: pathToFileURL(storePath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(storePath, 'utf8')
                }
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'callHierarchy/incomingCalls') return []
                if (method === 'textDocument/references') return []
                return { capabilities: {} }
            })
            localVueLs.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/documentSymbol') {
                    return [
                        {
                            name: 'template',
                            kind: 2,
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 2, character: 11 }
                            },
                            selectionRange: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 8 }
                            },
                            children: [
                                {
                                    name: 'button',
                                    kind: 8,
                                    range: {
                                        start: { line: 1, character: 2 },
                                        end: { line: 1, character: 68 }
                                    },
                                    selectionRange: {
                                        start: { line: 1, character: 3 },
                                        end: { line: 1, character: 9 }
                                    }
                                }
                            ]
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = (await localUpstream.triggerRequest('callHierarchy/incomingCalls', {
                item: {
                    uri: pathToFileURL(storePath).href,
                    name: 'runScenarioPreview',
                    kind: 6,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 3, character: 3 }
                    },
                    selectionRange: {
                        start: { line: 1, character: 2 },
                        end: { line: 1, character: 21 }
                    },
                    detail: '',
                    data: { id: 1 }
                }
            })) as Array<{ from: { name: string } }>

            expect(result).toHaveLength(1)
            expect(result[0]?.from.name).toBe('button')
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('builds incoming call hierarchy entries for function-valued store actions used in Vue templates', async () => {
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-go-to-tab-'))
        const storePath = path.join(tempWorkspace, 'pinia', 'ui.ts')
        const componentPath = path.join(tempWorkspace, 'components', 'TabbedNav.vue')
        fs.mkdirSync(path.dirname(storePath), { recursive: true })
        fs.mkdirSync(path.dirname(componentPath), { recursive: true })
        fs.writeFileSync(
            storePath,
            `export const useUiStore = () => {\n  const goToTab = function (slug: string) {\n    return slug\n  }\n\n  return {\n    goToTab,\n  }\n}\n`
        )
        fs.writeFileSync(
            componentPath,
            `<template>\n  <button @click="uiStore.goToTab('title')">Title</button>\n</template>\n\n<script setup lang="ts">\nconst uiStore = useUiStore()\n</script>\n`
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
                    uri: pathToFileURL(storePath).href,
                    languageId: 'typescript',
                    version: 1,
                    text: fs.readFileSync(storePath, 'utf8')
                }
            })

            localVtsls.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'callHierarchy/incomingCalls') {
                    return [
                        {
                            from: {
                                uri: pathToFileURL(storePath).href,
                                name: 'useUiStore',
                                kind: 12,
                                range: {
                                    start: { line: 0, character: 0 },
                                    end: { line: 7, character: 1 }
                                },
                                selectionRange: {
                                    start: { line: 0, character: 13 },
                                    end: { line: 0, character: 23 }
                                }
                            },
                            fromSpans: [
                                {
                                    start: { line: 5, character: 4 },
                                    end: { line: 5, character: 11 }
                                }
                            ]
                        }
                    ]
                }
                if (method === 'textDocument/references') {
                    return [
                        {
                            uri: pathToFileURL(storePath).href,
                            range: {
                                start: { line: 5, character: 4 },
                                end: { line: 5, character: 11 }
                            }
                        }
                    ]
                }
                return { capabilities: {} }
            })
            localVueLs.sendRequest.mockImplementation(async (method: string) => {
                if (method === 'initialize') return { capabilities: {} }
                if (method === 'textDocument/documentSymbol') {
                    return [
                        {
                            name: 'template',
                            kind: 2,
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 2, character: 11 }
                            },
                            selectionRange: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 8 }
                            },
                            children: [
                                {
                                    name: 'button',
                                    kind: 8,
                                    range: {
                                        start: { line: 1, character: 2 },
                                        end: { line: 1, character: 48 }
                                    },
                                    selectionRange: {
                                        start: { line: 1, character: 3 },
                                        end: { line: 1, character: 9 }
                                    }
                                }
                            ]
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = (await localUpstream.triggerRequest('callHierarchy/incomingCalls', {
                item: {
                    uri: pathToFileURL(storePath).href,
                    name: 'goToTab',
                    kind: 12,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 3, character: 3 }
                    },
                    selectionRange: {
                        start: { line: 1, character: 8 },
                        end: { line: 1, character: 15 }
                    },
                    detail: ''
                }
            })) as Array<{ from: { name: string } }>

            expect(result).toHaveLength(2)
            expect(result.map((entry) => entry.from.name)).toEqual(['useUiStore', 'button'])
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })

    it('merges synthesized Vue template callers into non-empty incoming call hierarchy results', async () => {
        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'callHierarchy/incomingCalls') {
                return [
                    {
                        from: {
                            uri: 'file:///workspace/src/helpers/recompute.ts',
                            name: 'recompute',
                            kind: 12,
                            range: {
                                start: { line: 4, character: 0 },
                                end: { line: 6, character: 1 }
                            },
                            selectionRange: {
                                start: { line: 4, character: 9 },
                                end: { line: 4, character: 18 }
                            }
                        },
                        fromSpans: [
                            {
                                start: { line: 5, character: 2 },
                                end: { line: 5, character: 27 }
                            }
                        ]
                    }
                ]
            }
            if (method === 'textDocument/references') {
                return [
                    {
                        uri: 'file:///workspace/components/App.vue',
                        range: {
                            start: { line: 1, character: 18 },
                            end: { line: 1, character: 43 }
                        }
                    }
                ]
            }
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/documentSymbol') {
                return [
                    {
                        name: 'template',
                        kind: 2,
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 2, character: 11 }
                        },
                        selectionRange: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 8 }
                        },
                        children: [
                            {
                                name: 'button',
                                kind: 8,
                                range: {
                                    start: { line: 1, character: 2 },
                                    end: { line: 1, character: 58 }
                                },
                                selectionRange: {
                                    start: { line: 1, character: 3 },
                                    end: { line: 1, character: 9 }
                                }
                            }
                        ]
                    }
                ]
            }
            return { capabilities: {} }
        })

        const result = (await upstream.triggerRequest('callHierarchy/incomingCalls', {
            item: {
                uri: 'file:///workspace/src/stores/property.ts',
                name: 'checkIfPropertyIsComplete',
                kind: 12,
                range: {
                    start: { line: 40, character: 0 },
                    end: { line: 48, character: 1 }
                },
                selectionRange: {
                    start: { line: 40, character: 9 },
                    end: { line: 40, character: 34 }
                },
                detail: ''
            }
        })) as Array<{ from: { name: string } }>

        expect(result).toHaveLength(2)
        expect(result.map((entry) => entry.from.name)).toEqual(['recompute', 'button'])
        expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/references', {
            textDocument: { uri: 'file:///workspace/src/stores/property.ts' },
            position: { line: 40, character: 9 },
            context: { includeDeclaration: false }
        })
    })

    it('builds outgoing call hierarchy entries from Vue script calls when vtsls returns none', async () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///workspace/App.vue',
                languageId: 'vue',
                version: 1,
                text: `<script setup lang="ts">
const emit = defineEmits<{ (e: 'click', event: MouseEvent): void }>()
const click = (e: MouseEvent) => {
  emit('click', e)
}
</script>
`
            }
        })

        vtslsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'callHierarchy/outgoingCalls') return []
            return { capabilities: {} }
        })
        vueLsConn.sendRequest.mockImplementation(async (method: string) => {
            if (method === 'textDocument/documentSymbol') {
                return [
                    {
                        name: 'script setup',
                        kind: 2,
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 5, character: 0 }
                        },
                        selectionRange: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 12 }
                        },
                        children: [
                            {
                                name: 'emit',
                                kind: 13,
                                range: {
                                    start: { line: 1, character: 6 },
                                    end: { line: 1, character: 10 }
                                },
                                selectionRange: {
                                    start: { line: 1, character: 6 },
                                    end: { line: 1, character: 10 }
                                }
                            },
                            {
                                name: 'click',
                                kind: 13,
                                range: {
                                    start: { line: 2, character: 6 },
                                    end: { line: 4, character: 1 }
                                },
                                selectionRange: {
                                    start: { line: 2, character: 6 },
                                    end: { line: 2, character: 11 }
                                }
                            }
                        ]
                    }
                ]
            }
            return { capabilities: {} }
        })

        const result = (await upstream.triggerRequest('callHierarchy/outgoingCalls', {
            item: {
                uri: 'file:///workspace/App.vue',
                name: 'click',
                kind: 12,
                range: {
                    start: { line: 2, character: 14 },
                    end: { line: 4, character: 1 }
                },
                selectionRange: {
                    start: { line: 2, character: 6 },
                    end: { line: 2, character: 11 }
                }
            }
        })) as Array<{ to: { name: string }; fromSpans: unknown[] }>

        expect(result).toHaveLength(1)
        expect(result[0]?.to.name).toBe('emit')
        expect(result[0]?.fromSpans).toHaveLength(1)
    })

    it('recovers prepareCallHierarchy for destructured composable returns via definition remapping', async () => {
        let targetOpened = false
        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-prepare-'))
        const targetPath = path.join(tempWorkspace, 'helpers', 'estimate', 'useSummaryBuilder.ts')
        const targetUri = pathToFileURL(targetPath).href
        const targetText = `export function useSummaryBuilder() {\n  function buildSummary() {\n    return 1\n  }\n\n  return {\n    buildSummary,\n  }\n}\n`
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.writeFileSync(targetPath, targetText)

        try {
            upstream.triggerNotification('textDocument/didOpen', {
                textDocument: {
                    uri: 'file:///workspace/components/ScenarioOverview.vue',
                    languageId: 'vue',
                    version: 1,
                    text: `<script setup lang="ts">
import { useSummaryBuilder } from '../utils/summary/useSummaryBuilder'
const { buildSummary } = useSummaryBuilder()
</script>
`
                }
            })
            vtslsConn.sendNotification.mockImplementation((method: string, params?: unknown) => {
                const typedParams = params as { textDocument?: { uri?: string } }
                if (method === 'textDocument/didOpen' && typedParams?.textDocument?.uri === targetUri) {
                    targetOpened = true
                }
                if (method === 'textDocument/didClose' && typedParams?.textDocument?.uri === targetUri) {
                    targetOpened = false
                }
            })

            vtslsConn.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
                if (method === 'textDocument/prepareCallHierarchy') {
                    const typedParams = params as { textDocument?: { uri?: string } }
                    if (typedParams.textDocument?.uri === 'file:///workspace/components/ScenarioOverview.vue') {
                        return []
                    }
                    if (!targetOpened) {
                        return []
                    }
                    return [
                        {
                            uri: targetUri,
                            name: 'buildSummary',
                            kind: 12,
                            range: {
                                start: { line: 1, character: 2 },
                                end: { line: 3, character: 3 }
                            },
                            selectionRange: {
                                start: { line: 1, character: 11 },
                                end: { line: 1, character: 30 }
                            },
                            data: { id: 7 }
                        }
                    ]
                }
                if (method === 'textDocument/definition') {
                    return [
                        {
                            uri: targetUri,
                            range: {
                                start: { line: 5, character: 4 },
                                end: { line: 5, character: 23 }
                            }
                        }
                    ]
                }
                if (method === 'textDocument/documentSymbol') {
                    return [
                        {
                            name: 'useSummaryBuilder',
                            kind: 12,
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 8, character: 1 }
                            },
                            selectionRange: {
                                start: { line: 0, character: 16 },
                                end: { line: 0, character: 33 }
                            }
                        },
                        {
                            name: 'buildSummary',
                            kind: 12,
                            range: {
                                start: { line: 1, character: 2 },
                                end: { line: 3, character: 3 }
                            },
                            selectionRange: {
                                start: { line: 1, character: 11 },
                                end: { line: 1, character: 30 }
                            }
                        }
                    ]
                }
                return { capabilities: {} }
            })

            const result = await upstream.triggerRequest('textDocument/prepareCallHierarchy', {
                textDocument: {
                    uri: 'file:///workspace/components/ScenarioOverview.vue'
                },
                position: { line: 2, character: 8 }
            })

            expect(result).toEqual([
                {
                    uri: targetUri,
                    name: 'buildSummary',
                    kind: 12,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 3, character: 3 }
                    },
                    selectionRange: {
                        start: { line: 1, character: 11 },
                        end: { line: 1, character: 30 }
                    },
                    data: { id: 7 }
                }
            ])
            expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/definition', {
                textDocument: {
                    uri: 'file:///workspace/components/ScenarioOverview.vue'
                },
                position: { line: 2, character: 8 }
            })
            expect(vtslsConn.sendRequest).toHaveBeenCalledWith('textDocument/prepareCallHierarchy', {
                textDocument: { uri: targetUri },
                position: { line: 1, character: 11 }
            })
            expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
                textDocument: {
                    uri: targetUri,
                    languageId: 'typescript',
                    version: 1,
                    text: targetText
                }
            })
            expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didClose', {
                textDocument: { uri: targetUri }
            })
        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true })
        }
    })
})
