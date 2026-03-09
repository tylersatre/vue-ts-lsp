import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node.js'
import { isDefinitionMirrorUri } from '@src/definition-mirrors.js'
import { resolveVueTypescriptPluginLocation, setupProxy } from '@src/proxy.js'
import { spawnServer, vtslsCommand, vueLsCommand } from '@src/spawn.js'
import {
    BUTTON_COMPONENT_COMPUTED_REPORT_POSITION,
    BUTTON_COMPONENT_REF_TOKEN_POSITION,
    BUTTON_COMPONENT_TEXT,
    BUTTON_COMPONENT_URI,
    CHARGE_EDITOR_CURRENCY_FIELD_TAG_POSITION,
    CHARGE_EDITOR_CURRENCY_MODEL_POSITION,
    CHARGE_EDITOR_TEXT,
    CHARGE_EDITOR_TEXT_MODEL_POSITION,
    CHARGE_EDITOR_URI,
    CURRENCY_FIELD_URI,
    DOMAIN_INTERFACES_URI,
    DOMAIN_TYPES_LINE_ITEM_ID_POSITION,
    DOMAIN_TYPES_TEXT,
    DOMAIN_TYPES_URI,
    DRAFT_SYNC_COMPUTED_REPORT_POSITION,
    DRAFT_SYNC_REF_TOKEN_POSITION,
    DRAFT_SYNC_STORE_POSITION,
    DRAFT_SYNC_TEXT,
    DRAFT_SYNC_URI,
    FIXTURE_NODE_MODULES,
    GENERATED_TYPES_URI,
    ITEM_DETAILS_LINE_ITEM_COUNT_POSITION,
    ITEM_DETAILS_PROPS_POSITION,
    ITEM_DETAILS_TEXT,
    ITEM_DETAILS_URI,
    ITEM_DETAILS_VFOR_ENTRY_POSITION,
    ITEM_ENTRY_ADD_SCENARIO_POSITION,
    ITEM_ENTRY_TEXT,
    ITEM_ENTRY_URI,
    PROJECT_ROOT,
    ROOT_URI,
    SCENARIO_OVERVIEW_BUILD_SUMMARY_POSITION,
    SCENARIO_OVERVIEW_TEXT,
    SCENARIO_OVERVIEW_URI,
    SCENARIOS_STORE_RUN_PREVIEW_POSITION,
    SCENARIOS_STORE_TEXT,
    SCENARIOS_STORE_URI,
    smokeEnabled,
    SUMMARY_BUILDER_TEXT,
    SUMMARY_BUILDER_URI,
    SUMMARY_PANEL_COMPUTED_REPORT_POSITION,
    SUMMARY_PANEL_REF_TOKEN_POSITION,
    SUMMARY_PANEL_TEXT,
    SUMMARY_PANEL_URI,
    WORKSPACE_NAME,
    WORKSPACE_STORE_URI,
    firstPositionOf,
    positionOf
} from './fixture-workspace.js'
const SMOKE_TIMEOUT_MS = 45_000
const RUN_DIAGNOSTIC_SMOKE = process.env.VUE_TS_LSP_RUN_DIAGNOSTIC_SMOKE === '1'
const DEFINITION_MIRROR_ROOT = process.env.VUE_TS_LSP_DEFINITION_MIRROR_ROOT ?? path.join(os.homedir(), '.cache', 'vue-ts-lsp', 'definition-mirrors')
const smokeDescribe = smokeEnabled ? describe.sequential : describe.skip
const diagnosticDescribe = smokeEnabled && RUN_DIAGNOSTIC_SMOKE ? describe.sequential : describe.skip

type PublishDiagnosticsParams = { uri: string; diagnostics: unknown[] }
type SymbolLike = { name?: string; children?: unknown[] }
type DefinitionLike = { uri?: string; targetUri?: string }
type NamedCallHierarchy = { from?: { name?: string }; to?: { name?: string } }

interface ProxyHarness {
    client: MessageConnection
    diagnostics: PublishDiagnosticsParams[]
    cleanup: () => Promise<void>
}

interface RawVtslsHarness {
    conn: MessageConnection
    cleanup: () => Promise<void>
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function shutdownIgnoringErrors(connection: MessageConnection): Promise<void> {
    try {
        await connection.sendRequest('shutdown')
    } catch {}
}

function workspaceFolders() {
    return [{ uri: ROOT_URI, name: WORKSPACE_NAME }]
}

function buildVtslsSettings(pluginLocation: string) {
    return {
        vtsls: {
            autoUseWorkspaceTsdk: true,
            tsserver: {
                globalPlugins: [
                    {
                        name: '@vue/typescript-plugin',
                        location: pluginLocation,
                        languages: ['vue'],
                        configNamespace: 'typescript',
                        enableForWorkspaceTypeScriptVersions: true
                    }
                ]
            }
        },
        typescript: {
            tsserver: {
                maxTsServerMemory: 8192,
                log: 'verbose'
            }
        }
    }
}

function createConnectionPair(): {
    client: MessageConnection
    server: MessageConnection
} {
    const upstreamToProxy = new PassThrough()
    const proxyToUpstream = new PassThrough()

    const client = createMessageConnection(new StreamMessageReader(proxyToUpstream), new StreamMessageWriter(upstreamToProxy))
    const server = createMessageConnection(new StreamMessageReader(upstreamToProxy), new StreamMessageWriter(proxyToUpstream))

    return { client, server }
}

function resolveSettingsSection(settings: Record<string, unknown>, section?: string): unknown {
    if (!section) return settings

    let value: unknown = settings
    for (const part of section.split('.')) {
        if (value !== null && typeof value === 'object' && part in value) {
            value = (value as Record<string, unknown>)[part]
            continue
        }
        return null
    }

    return value ?? null
}

async function waitForValue<T>(description: string, getValue: () => Promise<T | null>, timeoutMs = 20_000, intervalMs = 250): Promise<T> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        const value = await getValue()
        if (value !== null) {
            return value
        }
        await delay(intervalMs)
    }

    throw new Error(`Timed out waiting for ${description}`)
}

function collectSymbolNames(symbols: unknown[]): string[] {
    const names: string[] = []

    for (const symbol of symbols) {
        if (symbol === null || typeof symbol !== 'object') continue
        const typedSymbol = symbol as SymbolLike
        if (typeof typedSymbol.name === 'string') {
            names.push(typedSymbol.name)
        }
        if (Array.isArray(typedSymbol.children)) {
            names.push(...collectSymbolNames(typedSymbol.children))
        }
    }

    return names
}

function findSymbol(symbols: unknown[], name: string): { name?: string; kind?: number; children?: unknown[] } | null {
    for (const symbol of symbols) {
        if (symbol === null || typeof symbol !== 'object') {
            continue
        }
        const typedSymbol = symbol as SymbolLike & { kind?: number }
        if (typedSymbol.name === name) {
            return typedSymbol
        }
        if (Array.isArray(typedSymbol.children)) {
            const child = findSymbol(typedSymbol.children, name)
            if (child !== null) {
                return child
            }
        }
    }

    return null
}

function topLevelSymbolNames(symbols: unknown[]): string[] {
    return symbols.flatMap((symbol) => {
        if (symbol === null || typeof symbol !== 'object') return []
        const typedSymbol = symbol as SymbolLike
        return typeof typedSymbol.name === 'string' ? [typedSymbol.name] : []
    })
}

function extractDefinitionUris(result: unknown): string[] {
    if (result === null || result === undefined) return []

    const values = Array.isArray(result) ? result : [result]
    return values.flatMap((value) => {
        if (value === null || typeof value !== 'object') return []
        const typedValue = value as DefinitionLike
        if (typeof typedValue.targetUri === 'string') return [typedValue.targetUri]
        if (typeof typedValue.uri === 'string') return [typedValue.uri]
        return []
    })
}

function usesLocationLinks(result: unknown): boolean {
    if (result === null || result === undefined) return false

    const values = Array.isArray(result) ? result : [result]
    return values.some(
        (value) => value !== null && typeof value === 'object' && 'targetUri' in value && typeof (value as DefinitionLike).targetUri === 'string'
    )
}

function isInternalProbeDefinitionUri(uri: string): boolean {
    return decodeURIComponent(uri).includes('/.__vue_ts_lsp__.')
}

function isVueLibraryUri(uri: string): boolean {
    const decoded = decodeURIComponent(uri)
    return decoded.includes('/node_modules/') && (decoded.includes('/vue/') || decoded.includes('/@vue/'))
}

function isMirroredDefinitionUri(uri: string): boolean {
    return isDefinitionMirrorUri(uri, DEFINITION_MIRROR_ROOT)
}

function extractCallHierarchyNames(calls: unknown[], side: 'from' | 'to'): string[] {
    return calls.flatMap((call) => {
        if (call === null || typeof call !== 'object') return []
        const namedCall = call as NamedCallHierarchy
        const target = side === 'from' ? namedCall.from : namedCall.to
        return target?.name ? [target.name] : []
    })
}

async function createProxyHarness(): Promise<ProxyHarness> {
    const pair = createConnectionPair()
    const { command: vtslsBin, args: vtslsArgs } = vtslsCommand()
    const { command: vueLsBin, args: vueLsArgs } = vueLsCommand()
    const vtsls = spawnServer(vtslsBin, vtslsArgs)
    const vueLs = spawnServer(vueLsBin, vueLsArgs)
    const diagnostics: PublishDiagnosticsParams[] = []

    pair.client.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
        diagnostics.push(params as PublishDiagnosticsParams)
    })
    pair.client.onNotification('window/logMessage', () => {})

    setupProxy(pair.server, vtsls.conn, vueLs.conn, {
        killVtsls: vtsls.kill,
        killVueLs: vueLs.kill
    })

    pair.server.listen()
    pair.client.listen()

    await pair.client.sendRequest('initialize', {
        rootUri: ROOT_URI,
        workspaceFolders: workspaceFolders(),
        capabilities: {}
    })
    pair.client.sendNotification('initialized', {})
    pair.client.sendNotification('textDocument/didOpen', {
        textDocument: {
            uri: BUTTON_COMPONENT_URI,
            languageId: 'vue',
            version: 1,
            text: BUTTON_COMPONENT_TEXT
        }
    })
    if (SUMMARY_PANEL_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SUMMARY_PANEL_URI,
                languageId: 'vue',
                version: 1,
                text: SUMMARY_PANEL_TEXT
            }
        })
    }
    if (DRAFT_SYNC_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: DRAFT_SYNC_URI,
                languageId: 'typescript',
                version: 1,
                text: DRAFT_SYNC_TEXT
            }
        })
    }
    if (DOMAIN_TYPES_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: DOMAIN_TYPES_URI,
                languageId: 'typescript',
                version: 1,
                text: DOMAIN_TYPES_TEXT
            }
        })
    }
    if (SUMMARY_BUILDER_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SUMMARY_BUILDER_URI,
                languageId: 'typescript',
                version: 1,
                text: SUMMARY_BUILDER_TEXT
            }
        })
    }
    if (SCENARIO_OVERVIEW_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SCENARIO_OVERVIEW_URI,
                languageId: 'vue',
                version: 1,
                text: SCENARIO_OVERVIEW_TEXT
            }
        })
    }
    if (CHARGE_EDITOR_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: CHARGE_EDITOR_URI,
                languageId: 'vue',
                version: 1,
                text: CHARGE_EDITOR_TEXT
            }
        })
    }
    if (ITEM_ENTRY_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: ITEM_ENTRY_URI,
                languageId: 'vue',
                version: 1,
                text: ITEM_ENTRY_TEXT
            }
        })
    }
    if (ITEM_DETAILS_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: ITEM_DETAILS_URI,
                languageId: 'vue',
                version: 1,
                text: ITEM_DETAILS_TEXT
            }
        })
    }
    if (SCENARIOS_STORE_TEXT.length > 0) {
        pair.client.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SCENARIOS_STORE_URI,
                languageId: 'typescript',
                version: 1,
                text: SCENARIOS_STORE_TEXT
            }
        })
    }

    return {
        client: pair.client,
        diagnostics,
        cleanup: async () => {
            try {
                await shutdownIgnoringErrors(pair.client)
            } finally {
                vtsls.kill()
                vueLs.kill()
                pair.client.dispose()
                pair.server.dispose()
                vtsls.conn.dispose()
                vueLs.conn.dispose()
                await delay(100)
            }
        }
    }
}

async function createRawVtslsHarness(): Promise<RawVtslsHarness> {
    const { command, args } = vtslsCommand()
    const { conn, kill } = spawnServer(command, args)
    const settings = buildVtslsSettings(resolveVueTypescriptPluginLocation())

    conn.onRequest('workspace/configuration', (params: unknown) => {
        const items = (params as { items?: Array<{ section?: string }> }).items ?? []
        return items.map((item) => resolveSettingsSection(settings as Record<string, unknown>, item.section))
    })
    conn.onNotification('textDocument/publishDiagnostics', () => {})
    conn.onNotification('window/logMessage', () => {})
    conn.listen()

    await conn.sendRequest('initialize', {
        rootUri: ROOT_URI,
        workspaceFolders: workspaceFolders(),
        capabilities: {
            workspace: {
                configuration: true
            }
        },
        initializationOptions: {
            settings
        }
    })
    conn.sendNotification('initialized', {})
    conn.sendNotification('workspace/didChangeConfiguration', { settings })
    conn.sendNotification('textDocument/didOpen', {
        textDocument: {
            uri: BUTTON_COMPONENT_URI,
            languageId: 'vue',
            version: 1,
            text: BUTTON_COMPONENT_TEXT
        }
    })
    if (SUMMARY_PANEL_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SUMMARY_PANEL_URI,
                languageId: 'vue',
                version: 1,
                text: SUMMARY_PANEL_TEXT
            }
        })
    }
    if (DRAFT_SYNC_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: DRAFT_SYNC_URI,
                languageId: 'typescript',
                version: 1,
                text: DRAFT_SYNC_TEXT
            }
        })
    }
    if (DOMAIN_TYPES_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: DOMAIN_TYPES_URI,
                languageId: 'typescript',
                version: 1,
                text: DOMAIN_TYPES_TEXT
            }
        })
    }
    if (SUMMARY_BUILDER_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SUMMARY_BUILDER_URI,
                languageId: 'typescript',
                version: 1,
                text: SUMMARY_BUILDER_TEXT
            }
        })
    }
    if (SCENARIO_OVERVIEW_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SCENARIO_OVERVIEW_URI,
                languageId: 'vue',
                version: 1,
                text: SCENARIO_OVERVIEW_TEXT
            }
        })
    }
    if (CHARGE_EDITOR_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: CHARGE_EDITOR_URI,
                languageId: 'vue',
                version: 1,
                text: CHARGE_EDITOR_TEXT
            }
        })
    }
    if (ITEM_ENTRY_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: ITEM_ENTRY_URI,
                languageId: 'vue',
                version: 1,
                text: ITEM_ENTRY_TEXT
            }
        })
    }
    if (ITEM_DETAILS_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: ITEM_DETAILS_URI,
                languageId: 'vue',
                version: 1,
                text: ITEM_DETAILS_TEXT
            }
        })
    }
    if (SCENARIOS_STORE_TEXT.length > 0) {
        conn.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: SCENARIOS_STORE_URI,
                languageId: 'typescript',
                version: 1,
                text: SCENARIOS_STORE_TEXT
            }
        })
    }

    return {
        conn,
        cleanup: async () => {
            try {
                await shutdownIgnoringErrors(conn)
            } finally {
                kill()
                conn.dispose()
                await delay(100)
            }
        }
    }
}

smokeDescribe('proxy smoke tests with real child servers', () => {
    let harness: ProxyHarness

    beforeAll(async () => {
        harness = await createProxyHarness()
    }, SMOKE_TIMEOUT_MS)

    afterAll(async () => {
        await harness.cleanup()
    }, SMOKE_TIMEOUT_MS)

    it(
        'routes .vue documentSymbol through vue_ls and returns SFC symbols',
        async () => {
            const symbols = await waitForValue(
                'PrimaryAction.vue document symbols',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/documentSymbol', {
                        textDocument: { uri: BUTTON_COMPONENT_URI }
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            const topLevelNames = topLevelSymbolNames(symbols).map((name) => name.toLowerCase())
            const allNames = collectSymbolNames(symbols)

            expect(topLevelNames.some((name) => name.includes('template'))).toBe(true)
            expect(topLevelNames.some((name) => name.includes('script'))).toBe(true)
            expect(allNames.some((name) => name === 'showIndicator' || name === 'showCheckmark')).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'normalizes TypeScript document symbol kinds for aliases, interfaces, and enums',
        async () => {
            const symbols = await waitForValue(
                'types.ts document symbols',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/documentSymbol', {
                        textDocument: { uri: DOMAIN_TYPES_URI }
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            expect(findSymbol(symbols, 'Brand')?.kind).toBe(26)
            expect(findSymbol(symbols, 'VisibilityMap')?.kind).toBe(11)
            expect(findSymbol(symbols, 'WorkspaceViewMode')?.kind).toBe(10)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'synthesizes workspaceSymbol queries from recent positional context in the fixture workspace',
        async () => {
            await waitForValue(
                'hover on useSelectionStore',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/hover', {
                        textDocument: { uri: DRAFT_SYNC_URI },
                        position: DRAFT_SYNC_STORE_POSITION
                    })
                    return result === null ? null : result
                },
                20_000,
                250
            )

            const result = await waitForValue(
                'workspace symbol results for useSelectionStore',
                async () => {
                    const response = await harness.client.sendRequest('workspace/symbol', { query: '' })
                    return Array.isArray(response) &&
                        response.some(
                            (symbol) =>
                                symbol !== null && typeof symbol === 'object' && 'name' in symbol && (symbol as { name?: string }).name === 'useSelectionStore'
                        )
                        ? response
                        : null
                },
                20_000,
                250
            )

            expect(
                result.some(
                    (symbol) => symbol !== null && typeof symbol === 'object' && 'name' in symbol && (symbol as { name?: string }).name === 'useSelectionStore'
                )
            ).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'finds cross-file references for branded identifiers in the fixture workspace',
        async () => {
            const references = await waitForValue(
                'LineItemId references',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/references', {
                        textDocument: { uri: DOMAIN_TYPES_URI },
                        position: DOMAIN_TYPES_LINE_ITEM_ID_POSITION,
                        context: { includeDeclaration: true }
                    })
                    return Array.isArray(result) &&
                        result.some(
                            (location) =>
                                location !== null &&
                                typeof location === 'object' &&
                                'uri' in location &&
                                (location as { uri?: string }).uri === SCENARIOS_STORE_URI
                        ) &&
                        result.some(
                            (location) =>
                                location !== null &&
                                typeof location === 'object' &&
                                'uri' in location &&
                                (location as { uri?: string }).uri === GENERATED_TYPES_URI
                        ) &&
                        result.some(
                            (location) =>
                                location !== null &&
                                typeof location === 'object' &&
                                'uri' in location &&
                                (location as { uri?: string }).uri === ITEM_DETAILS_URI
                        )
                        ? result
                        : null
                },
                20_000,
                250
            )

            const uris = new Set((references as Array<{ uri: string }>).map((location) => location.uri))
            expect(uris.has(SCENARIOS_STORE_URI)).toBe(true)
            expect(uris.has(GENERATED_TYPES_URI)).toBe(true)
            expect(uris.has(ITEM_DETAILS_URI)).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'returns specific hover types for complex Vue template and script positions',
        async () => {
            const templateHover = await waitForValue(
                'ItemDetails template v-for hover',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/hover', {
                        textDocument: { uri: ITEM_DETAILS_URI },
                        position: ITEM_DETAILS_VFOR_ENTRY_POSITION
                    })
                    const text = JSON.stringify(result)
                    return result !== null && !text.includes('any') ? result : null
                },
                20_000,
                250
            )

            const propsHover = await waitForValue(
                'ItemDetails defineProps hover',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/hover', {
                        textDocument: { uri: ITEM_DETAILS_URI },
                        position: ITEM_DETAILS_PROPS_POSITION
                    })
                    const text = JSON.stringify(result)
                    return text.includes('ItemDetailsProps') ? result : null
                },
                20_000,
                250
            )

            const lineItemCountHover = await waitForValue(
                'ItemDetails storeToRefs hover',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/hover', {
                        textDocument: { uri: ITEM_DETAILS_URI },
                        position: ITEM_DETAILS_LINE_ITEM_COUNT_POSITION
                    })
                    const text = JSON.stringify(result)
                    return text.includes('number') && !text.includes('any') ? result : null
                },
                20_000,
                250
            )

            expect(JSON.stringify(templateHover)).not.toContain('any')
            expect(JSON.stringify(propsHover)).toContain('ItemDetailsProps')
            expect(JSON.stringify(lineItemCountHover)).not.toContain('any')
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'resolves .ts Vue imports into cache mirror Locations instead of raw node_modules paths',
        async () => {
            let lastComputedResult: unknown = null
            const computedResult = await waitForValue(
                'useDraftSync.ts computed definition mirror',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: DRAFT_SYNC_URI },
                        position: DRAFT_SYNC_COMPUTED_REPORT_POSITION
                    })
                    lastComputedResult = result
                    const uris = extractDefinitionUris(result)
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) && !usesLocationLinks(result) ? result : null
                },
                20_000,
                250
            ).catch((error: unknown) => {
                const suffix = extractDefinitionUris(lastComputedResult).join(', ') || 'none'
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${message}; last computed definition URIs: ${suffix}`)
            })

            let lastRefResult: unknown = null
            const refResult = await waitForValue(
                'useDraftSync.ts ref definition mirror',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: DRAFT_SYNC_URI },
                        position: DRAFT_SYNC_REF_TOKEN_POSITION
                    })
                    lastRefResult = result
                    const uris = extractDefinitionUris(result)
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) && !usesLocationLinks(result) ? result : null
                },
                20_000,
                250
            ).catch((error: unknown) => {
                const suffix = extractDefinitionUris(lastRefResult).join(', ') || 'none'
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${message}; last ref definition URIs: ${suffix}`)
            })

            expect(extractDefinitionUris(computedResult).every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
            expect(extractDefinitionUris(refResult).every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
            expect(usesLocationLinks(computedResult)).toBe(false)
            expect(usesLocationLinks(refResult)).toBe(false)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'resolves the real-project computed import position into definition mirrors without leaking the shim',
        async () => {
            const hoverPosition = firstPositionOf(BUTTON_COMPONENT_TEXT, ['showIndicator', 'showCheckmark'])

            await waitForValue(
                'initial Vue hover warm-up',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/hover', {
                        textDocument: { uri: BUTTON_COMPONENT_URI },
                        position: hoverPosition
                    })
                    return result === null ? null : result
                },
                20_000,
                250
            )

            let lastUris: string[] = []
            const definitionUris = await waitForValue(
                'computed definition outside the internal shim',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: BUTTON_COMPONENT_URI },
                        position: BUTTON_COMPONENT_COMPUTED_REPORT_POSITION
                    })
                    const uris = extractDefinitionUris(result)
                    lastUris = uris
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) && uris.every((uri) => !isInternalProbeDefinitionUri(uri)) ? uris : null
                },
                30_000,
                500
            ).catch((error: unknown) => {
                const suffix = lastUris.length === 0 ? 'none' : lastUris.join(', ')
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${message}; last definition URIs: ${suffix}`)
            })

            expect(definitionUris.every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
            expect(definitionUris.every((uri) => !isInternalProbeDefinitionUri(uri))).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'resolves the real-project ref token position into definition mirrors',
        async () => {
            let lastUris: string[] = []
            const definitionUris = await waitForValue(
                'ref definition mirror from the token position',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: BUTTON_COMPONENT_URI },
                        position: BUTTON_COMPONENT_REF_TOKEN_POSITION
                    })
                    const uris = extractDefinitionUris(result)
                    lastUris = uris
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) ? uris : null
                },
                20_000,
                250
            ).catch((error: unknown) => {
                const suffix = lastUris.length === 0 ? 'none' : lastUris.join(', ')
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${message}; last definition URIs: ${suffix}`)
            })

            expect(definitionUris.every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'resolves the same computed/ref token positions in CostSummaryPanel.vue',
        async () => {
            let computedUris: string[] = []
            const warmedComputedUris = await waitForValue(
                'CostSummaryPanel computed definition outside the internal shim',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: SUMMARY_PANEL_URI },
                        position: SUMMARY_PANEL_COMPUTED_REPORT_POSITION
                    })
                    const uris = extractDefinitionUris(result)
                    computedUris = uris
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) && uris.every((uri) => !isInternalProbeDefinitionUri(uri)) ? uris : null
                },
                30_000,
                500
            ).catch((error: unknown) => {
                const suffix = computedUris.length === 0 ? 'none' : computedUris.join(', ')
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${message}; last computed definition URIs: ${suffix}`)
            })

            let refUris: string[] = []
            const warmedRefUris = await waitForValue(
                'CostSummaryPanel ref definition mirror from the token position',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: SUMMARY_PANEL_URI },
                        position: SUMMARY_PANEL_REF_TOKEN_POSITION
                    })
                    const uris = extractDefinitionUris(result)
                    refUris = uris
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) ? uris : null
                },
                30_000,
                500
            ).catch((error: unknown) => {
                const suffix = refUris.length === 0 ? 'none' : refUris.join(', ')
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${message}; last ref definition URIs: ${suffix}`)
            })

            expect(warmedComputedUris.every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
            expect(warmedComputedUris.every((uri) => !isInternalProbeDefinitionUri(uri))).toBe(true)
            expect(warmedRefUris.every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'resolves aliased component tags in template positions to the actual Vue file',
        async () => {
            const result = await waitForValue(
                'ChargeEditor CurrencyField definition',
                async () => {
                    const response = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: CHARGE_EDITOR_URI },
                        position: CHARGE_EDITOR_CURRENCY_FIELD_TAG_POSITION
                    })
                    return extractDefinitionUris(response).includes(CURRENCY_FIELD_URI) ? response : null
                },
                20_000,
                250
            )

            expect(extractDefinitionUris(result)).toContain(CURRENCY_FIELD_URI)
            expect(extractDefinitionUris(result).every((uri) => !uri.includes('vue-shims.d.ts'))).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'normalizes template member definitions for v-model expressions',
        async () => {
            const nameDefinition = await waitForValue(
                'ChargeEditor charge.name definition',
                async () => {
                    const response = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: CHARGE_EDITOR_URI },
                        position: CHARGE_EDITOR_TEXT_MODEL_POSITION
                    })
                    return extractDefinitionUris(response).includes(DOMAIN_INTERFACES_URI) ? response : null
                },
                20_000,
                250
            )
            const amountDefinition = await waitForValue(
                'ChargeEditor charge.amount definition',
                async () => {
                    const response = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: CHARGE_EDITOR_URI },
                        position: CHARGE_EDITOR_CURRENCY_MODEL_POSITION
                    })
                    return extractDefinitionUris(response).includes(DOMAIN_INTERFACES_URI) ? response : null
                },
                20_000,
                250
            )

            expect(extractDefinitionUris(nameDefinition)).toContain(DOMAIN_INTERFACES_URI)
            expect(extractDefinitionUris(amountDefinition)).toContain(DOMAIN_INTERFACES_URI)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'normalizes template member definitions for store action chains',
        async () => {
            const result = await waitForValue(
                'ItemEntry workspaceStore.addEntry definition',
                async () => {
                    const response = await harness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: ITEM_ENTRY_URI },
                        position: ITEM_ENTRY_ADD_SCENARIO_POSITION
                    })
                    return extractDefinitionUris(response).includes(WORKSPACE_STORE_URI) ? response : null
                },
                20_000,
                250
            )

            expect(extractDefinitionUris(result)).toContain(WORKSPACE_STORE_URI)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'normalizes template hover for v-model expressions',
        async () => {
            const result = await waitForValue(
                'ChargeEditor charge.name hover',
                async () => {
                    const response = await harness.client.sendRequest('textDocument/hover', {
                        textDocument: { uri: CHARGE_EDITOR_URI },
                        position: CHARGE_EDITOR_TEXT_MODEL_POSITION
                    })
                    const text = JSON.stringify(response)
                    return text.includes('name: string') ? response : null
                },
                20_000,
                250
            )

            expect(JSON.stringify(result)).toContain('name: string')
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'builds non-empty .vue incoming and outgoing call hierarchy',
        async () => {
            const position = positionOf(BUTTON_COMPONENT_TEXT, 'click =')
            const prepared = await waitForValue(
                'proxy .vue call hierarchy prepare result',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: BUTTON_COMPONENT_URI },
                        position
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            const incoming = (await harness.client.sendRequest('callHierarchy/incomingCalls', {
                item: prepared[0]
            })) as unknown[]
            const outgoing = (await harness.client.sendRequest('callHierarchy/outgoingCalls', {
                item: prepared[0]
            })) as unknown[]

            expect(incoming.length).toBeGreaterThan(0)
            expect(outgoing.length).toBeGreaterThan(0)
            expect(extractCallHierarchyNames(outgoing, 'to')).toContain('emit')
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'recovers prepareCallHierarchy for destructured composable returns in the fixture workspace',
        async () => {
            const prepared = await waitForValue(
                'ScenarioOverview buildSummary call hierarchy prepare result',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: SCENARIO_OVERVIEW_URI },
                        position: SCENARIO_OVERVIEW_BUILD_SUMMARY_POSITION
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            const outgoing = (await harness.client.sendRequest('callHierarchy/outgoingCalls', {
                item: prepared[0]
            })) as unknown[]

            expect(prepared[0]).toMatchObject({
                uri: SUMMARY_BUILDER_URI,
                name: 'buildSummary'
            })
            expect(outgoing.length).toBeGreaterThan(0)
            expect(extractCallHierarchyNames(outgoing, 'to')).toContain('formatCurrency')
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'finds incoming calls for Pinia store methods used from Vue templates',
        async () => {
            const prepared = await waitForValue(
                'prepareCallHierarchy for runScenarioPreview',
                async () => {
                    const result = await harness.client.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: SCENARIOS_STORE_URI },
                        position: SCENARIOS_STORE_RUN_PREVIEW_POSITION
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            const incoming = (await harness.client.sendRequest('callHierarchy/incomingCalls', {
                item: prepared[0]
            })) as Array<{ from?: { uri?: string } }>

            expect(incoming.length).toBeGreaterThan(0)
            expect(incoming.some((call) => call.from?.uri === ITEM_DETAILS_URI)).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'eventually publishes diagnostics for the opened Vue document',
        async () => {
            const notifications = await waitForValue(
                'diagnostics for PrimaryAction.vue',
                async () => {
                    const matches = harness.diagnostics.filter((entry) => entry.uri === BUTTON_COMPONENT_URI)
                    return matches.length > 0 ? matches : null
                },
                20_000,
                250
            )

            expect(notifications.length).toBeGreaterThan(0)
        },
        SMOKE_TIMEOUT_MS
    )
})

diagnosticDescribe('diagnostic smoke baselines', () => {
    let proxyHarness: ProxyHarness
    let rawVtsls: RawVtslsHarness

    beforeAll(async () => {
        proxyHarness = await createProxyHarness()
        rawVtsls = await createRawVtslsHarness()
    }, SMOKE_TIMEOUT_MS)

    afterAll(async () => {
        await proxyHarness.cleanup()
        await rawVtsls.cleanup()
    }, SMOKE_TIMEOUT_MS)

    it(
        'improves aliased component-tag definitions beyond raw vtsls',
        async () => {
            const rawResult = await rawVtsls.conn.sendRequest('textDocument/definition', {
                textDocument: { uri: CHARGE_EDITOR_URI },
                position: CHARGE_EDITOR_CURRENCY_FIELD_TAG_POSITION
            })
            const proxyResult = await waitForValue(
                'proxy ChargeEditor CurrencyField definition',
                async () => {
                    const response = await proxyHarness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: CHARGE_EDITOR_URI },
                        position: CHARGE_EDITOR_CURRENCY_FIELD_TAG_POSITION
                    })
                    return extractDefinitionUris(response).includes(CURRENCY_FIELD_URI) ? response : null
                },
                20_000,
                250
            )

            expect(extractDefinitionUris(rawResult)).not.toContain(CURRENCY_FIELD_URI)
            expect(extractDefinitionUris(proxyResult)).toContain(CURRENCY_FIELD_URI)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'improves template store-action definitions beyond raw vtsls when the cursor is on the full chain',
        async () => {
            const rawResult = await rawVtsls.conn.sendRequest('textDocument/definition', {
                textDocument: { uri: ITEM_ENTRY_URI },
                position: ITEM_ENTRY_ADD_SCENARIO_POSITION
            })
            const proxyResult = await waitForValue(
                'proxy ItemEntry workspaceStore.addEntry definition',
                async () => {
                    const response = await proxyHarness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: ITEM_ENTRY_URI },
                        position: ITEM_ENTRY_ADD_SCENARIO_POSITION
                    })
                    return extractDefinitionUris(response).includes(WORKSPACE_STORE_URI) ? response : null
                },
                20_000,
                250
            )

            expect(extractDefinitionUris(rawResult)).not.toContain(WORKSPACE_STORE_URI)
            expect(extractDefinitionUris(proxyResult)).toContain(WORKSPACE_STORE_URI)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'improves .ts vue import definitions beyond raw vtsls',
        async () => {
            const rawComputed = await rawVtsls.conn.sendRequest('textDocument/definition', {
                textDocument: { uri: DRAFT_SYNC_URI },
                position: DRAFT_SYNC_COMPUTED_REPORT_POSITION
            })
            const proxyComputed = await waitForValue(
                'proxy .ts computed definition mirror',
                async () => {
                    const proxyResult = await proxyHarness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: DRAFT_SYNC_URI },
                        position: DRAFT_SYNC_COMPUTED_REPORT_POSITION
                    })
                    const uris = extractDefinitionUris(proxyResult)
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) ? proxyResult : null
                },
                20_000,
                250
            )

            expect(extractDefinitionUris(proxyComputed).every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
            expect(usesLocationLinks(proxyComputed)).toBe(false)
            expect(extractDefinitionUris(rawComputed).length === 0 || extractDefinitionUris(rawComputed).every((uri) => !isMirroredDefinitionUri(uri))).toBe(
                true
            )
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'matches or improves branded type-alias references relative to raw vtsls',
        async () => {
            const rawResult = await rawVtsls.conn.sendRequest('textDocument/references', {
                textDocument: { uri: DOMAIN_TYPES_URI },
                position: DOMAIN_TYPES_LINE_ITEM_ID_POSITION,
                context: { includeDeclaration: true }
            })
            const rawCount = Array.isArray(rawResult) ? rawResult.length : 0
            const proxyResult = await waitForValue(
                'proxy LineItemId references',
                async () => {
                    const response = await proxyHarness.client.sendRequest('textDocument/references', {
                        textDocument: { uri: DOMAIN_TYPES_URI },
                        position: DOMAIN_TYPES_LINE_ITEM_ID_POSITION,
                        context: { includeDeclaration: true }
                    })
                    return Array.isArray(response) &&
                        response.length >= rawCount &&
                        response.some(
                            (location) =>
                                location !== null &&
                                typeof location === 'object' &&
                                'uri' in location &&
                                (location as { uri?: string }).uri === SCENARIOS_STORE_URI
                        )
                        ? response
                        : null
                },
                20_000,
                250
            )

            expect(Array.isArray(proxyResult) && proxyResult.length >= rawCount).toBe(true)
            expect(
                Array.isArray(proxyResult) &&
                    proxyResult.some(
                        (location) =>
                            location !== null && typeof location === 'object' && 'uri' in location && (location as { uri?: string }).uri === SCENARIOS_STORE_URI
                    )
            ).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'improves the real-project .vue ref token position beyond raw vtsls',
        async () => {
            const rawResult = await rawVtsls.conn.sendRequest('textDocument/definition', {
                textDocument: { uri: BUTTON_COMPONENT_URI },
                position: BUTTON_COMPONENT_REF_TOKEN_POSITION
            })
            const proxyUris = await waitForValue(
                'proxy ref definition mirror',
                async () => {
                    const proxyResult = await proxyHarness.client.sendRequest('textDocument/definition', {
                        textDocument: { uri: BUTTON_COMPONENT_URI },
                        position: BUTTON_COMPONENT_REF_TOKEN_POSITION
                    })
                    const uris = extractDefinitionUris(proxyResult)
                    return uris.some((uri) => isMirroredDefinitionUri(uri)) ? uris : null
                },
                20_000,
                250
            )
            const rawUris = extractDefinitionUris(rawResult)

            expect(proxyUris.every((uri) => isMirroredDefinitionUri(uri))).toBe(true)
            expect(rawUris.length === 0 || rawUris.every((uri) => !isMirroredDefinitionUri(uri))).toBe(true)
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'improves .vue call hierarchy beyond raw vtsls',
        async () => {
            const position = positionOf(BUTTON_COMPONENT_TEXT, 'click =')
            const proxyPrepared = await waitForValue(
                'proxy call hierarchy prepare result',
                async () => {
                    const result = await proxyHarness.client.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: BUTTON_COMPONENT_URI },
                        position
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )
            const rawPrepared = await waitForValue(
                'raw vtsls call hierarchy prepare result',
                async () => {
                    const result = await rawVtsls.conn.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: BUTTON_COMPONENT_URI },
                        position
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            const proxyIncoming = await proxyHarness.client.sendRequest('callHierarchy/incomingCalls', {
                item: proxyPrepared[0]
            })
            const proxyOutgoing = await proxyHarness.client.sendRequest('callHierarchy/outgoingCalls', {
                item: proxyPrepared[0]
            })
            const rawIncoming = await rawVtsls.conn.sendRequest('callHierarchy/incomingCalls', {
                item: rawPrepared[0]
            })
            const rawOutgoing = await rawVtsls.conn.sendRequest('callHierarchy/outgoingCalls', {
                item: rawPrepared[0]
            })

            expect(Array.isArray(proxyIncoming) && proxyIncoming.length > 0).toBe(true)
            expect(Array.isArray(proxyOutgoing) && proxyOutgoing.length > 0).toBe(true)
            expect(rawIncoming).toEqual([])
            expect(rawOutgoing).toEqual([])
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'improves Pinia store-method incoming call hierarchy beyond raw vtsls',
        async () => {
            const proxyPrepared = await waitForValue(
                'proxy store-method call hierarchy prepare result',
                async () => {
                    const result = await proxyHarness.client.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: SCENARIOS_STORE_URI },
                        position: SCENARIOS_STORE_RUN_PREVIEW_POSITION
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )
            const rawPrepared = await waitForValue(
                'raw store-method call hierarchy prepare result',
                async () => {
                    const result = await rawVtsls.conn.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: SCENARIOS_STORE_URI },
                        position: SCENARIOS_STORE_RUN_PREVIEW_POSITION
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            const proxyIncoming = await proxyHarness.client.sendRequest('callHierarchy/incomingCalls', {
                item: proxyPrepared[0]
            })
            const rawIncoming = await rawVtsls.conn.sendRequest('callHierarchy/incomingCalls', {
                item: rawPrepared[0]
            })

            expect(Array.isArray(proxyIncoming) && proxyIncoming.length > 0).toBe(true)
            expect(rawIncoming).toEqual([])
        },
        SMOKE_TIMEOUT_MS
    )

    it(
        'improves destructured composable prepareCallHierarchy beyond raw vtsls',
        async () => {
            const proxyPrepared = await waitForValue(
                'proxy destructured call hierarchy prepare result',
                async () => {
                    const result = await proxyHarness.client.sendRequest('textDocument/prepareCallHierarchy', {
                        textDocument: { uri: SCENARIO_OVERVIEW_URI },
                        position: SCENARIO_OVERVIEW_BUILD_SUMMARY_POSITION
                    })
                    return Array.isArray(result) && result.length > 0 ? result : null
                },
                20_000,
                250
            )

            const rawPrepared = await rawVtsls.conn.sendRequest('textDocument/prepareCallHierarchy', {
                textDocument: { uri: SCENARIO_OVERVIEW_URI },
                position: SCENARIO_OVERVIEW_BUILD_SUMMARY_POSITION
            })

            expect(proxyPrepared[0]).toMatchObject({
                uri: SUMMARY_BUILDER_URI,
                name: 'buildSummary'
            })
            expect(rawPrepared).toBeNull()
        },
        SMOKE_TIMEOUT_MS
    )
})
