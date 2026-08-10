import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MessageConnection } from 'vscode-jsonrpc/node'

vi.mock('@src/logger.js', () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    setLogLevel: vi.fn()
}))

import { createProxyContext, type ProxyContext } from '@src/proxy-context.js'
const {
    listWorkspaceSourceFiles,
    getDocumentText,
    collectWorkspaceImporterUris,
    invalidateWorkspaceCachesForUri,
    applyWorkspaceConfigFromInitParams,
    applyPathPattern,
    resolveFileCandidate,
    loadPathAliasConfigs,
    resolveWorkspaceModuleSpecifier
} = await import('@src/proxy-workspace.js')
const { setupDocumentLifecycleHandlers } = await import('@src/proxy-handlers.js')

type MockConnection = {
    sendRequest: ReturnType<typeof vi.fn>
    sendNotification: ReturnType<typeof vi.fn>
    onRequest: ReturnType<typeof vi.fn>
    onNotification: ReturnType<typeof vi.fn>
    onClose: ReturnType<typeof vi.fn>
    listen: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    triggerNotification: (method: string, params?: unknown) => void
}

function createMockConnection(): MockConnection {
    const notificationHandlers = new Map<string, (params: unknown) => void>()
    return {
        sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
        sendNotification: vi.fn(),
        onRequest: vi.fn(),
        onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
            notificationHandlers.set(method, handler)
        }),
        onClose: vi.fn(),
        listen: vi.fn(),
        dispose: vi.fn(),
        triggerNotification: (method: string, params?: unknown) => notificationHandlers.get(method)?.(params)
    }
}

describe('workspace scan caching', () => {
    let workDir: string
    let ctx: ProxyContext
    let upstream: MockConnection

    function createCtx(): ProxyContext {
        upstream = createMockConnection()
        const context = createProxyContext(
            upstream as unknown as MessageConnection,
            createMockConnection() as unknown as MessageConnection,
            createMockConnection() as unknown as MessageConnection
        )
        context.savedInitParams = {
            processId: null,
            rootUri: pathToFileURL(workDir).href,
            workspaceFolders: [{ uri: pathToFileURL(workDir).href, name: 'workspace' }],
            capabilities: {}
        }
        return context
    }

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-workspace-cache-'))
        fs.writeFileSync(path.join(workDir, 'target.ts'), 'export const target = 1;\n')
        fs.writeFileSync(path.join(workDir, 'importer.ts'), "import { target } from './target';\nexport const use = target;\n")
        ctx = createCtx()
    })

    afterEach(() => {
        fs.rmSync(workDir, { recursive: true, force: true })
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    describe('listWorkspaceSourceFiles', () => {
        it('lists source files in the workspace', () => {
            const files = listWorkspaceSourceFiles(ctx, workDir)
            expect(files.map((f) => path.basename(f)).sort()).toEqual(['importer.ts', 'target.ts'])
        })

        it('caches the directory walk across repeated calls', () => {
            const readdirSpy = vi.spyOn(fs, 'readdirSync')
            const first = listWorkspaceSourceFiles(ctx, workDir)
            const callsAfterFirst = readdirSpy.mock.calls.length
            const second = listWorkspaceSourceFiles(ctx, workDir)
            expect(second).toEqual(first)
            expect(readdirSpy.mock.calls.length).toBe(callsAfterFirst)
        })

        it('re-walks after the cache TTL expires', () => {
            vi.useFakeTimers({ now: Date.now() })
            listWorkspaceSourceFiles(ctx, workDir)
            fs.writeFileSync(path.join(workDir, 'late.ts'), 'export const late = 1;\n')

            vi.advanceTimersByTime(60_000)

            const files = listWorkspaceSourceFiles(ctx, workDir)
            expect(files.map((f) => path.basename(f))).toContain('late.ts')
        })
    })

    describe('getDocumentText', () => {
        it('prefers the document store over disk', () => {
            const uri = pathToFileURL(path.join(workDir, 'target.ts')).href
            ctx.documentStore.open(uri, 'typescript', 2, 'export const fromStore = true;')
            expect(getDocumentText(ctx, uri)).toBe('export const fromStore = true;')
        })

        it('caches disk reads across repeated calls', () => {
            const uri = pathToFileURL(path.join(workDir, 'target.ts')).href
            const readSpy = vi.spyOn(fs, 'readFileSync')
            getDocumentText(ctx, uri)
            const callsAfterFirst = readSpy.mock.calls.length
            expect(getDocumentText(ctx, uri)).toBe('export const target = 1;\n')
            expect(readSpy.mock.calls.length).toBe(callsAfterFirst)
        })

        it('re-reads from disk after per-URI invalidation', () => {
            const uri = pathToFileURL(path.join(workDir, 'target.ts')).href
            expect(getDocumentText(ctx, uri)).toBe('export const target = 1;\n')

            fs.writeFileSync(path.join(workDir, 'target.ts'), 'export const target = 2;\n')
            invalidateWorkspaceCachesForUri(ctx, uri)

            expect(getDocumentText(ctx, uri)).toBe('export const target = 2;\n')
        })
    })

    describe('collectWorkspaceImporterUris', () => {
        it('finds importers of the edited module', () => {
            const targetUri = pathToFileURL(path.join(workDir, 'target.ts')).href
            const importerUri = pathToFileURL(path.join(workDir, 'importer.ts')).href
            expect(collectWorkspaceImporterUris(ctx, targetUri)).toEqual([importerUri])
        })

        it('reuses one scan for repeated calls within a nudge cycle', () => {
            const targetUri = pathToFileURL(path.join(workDir, 'target.ts')).href
            const first = collectWorkspaceImporterUris(ctx, targetUri)
            const readdirSpy = vi.spyOn(fs, 'readdirSync')
            const readSpy = vi.spyOn(fs, 'readFileSync')

            expect(collectWorkspaceImporterUris(ctx, targetUri)).toEqual(first)

            expect(readdirSpy).not.toHaveBeenCalled()
            expect(readSpy).not.toHaveBeenCalled()
        })

        it('re-scans after a document edit invalidates the import graph', () => {
            const targetUri = pathToFileURL(path.join(workDir, 'target.ts')).href
            const importerUri = pathToFileURL(path.join(workDir, 'importer.ts')).href
            expect(collectWorkspaceImporterUris(ctx, targetUri)).toEqual([importerUri])

            fs.writeFileSync(path.join(workDir, 'importer.ts'), 'export const use = 1;\n')
            invalidateWorkspaceCachesForUri(ctx, importerUri)

            expect(collectWorkspaceImporterUris(ctx, targetUri)).toEqual([])
        })
    })

    describe('document lifecycle invalidation wiring', () => {
        it('didChange invalidates the importer cache and the changed document text', () => {
            setupDocumentLifecycleHandlers(ctx)
            const uri = pathToFileURL(path.join(workDir, 'importer.ts')).href
            const targetUri = pathToFileURL(path.join(workDir, 'target.ts')).href
            collectWorkspaceImporterUris(ctx, targetUri)
            getDocumentText(ctx, uri)
            expect(ctx.workspaceScanCache.importerUris.size).toBeGreaterThan(0)

            upstream.triggerNotification('textDocument/didChange', {
                textDocument: { uri, version: 2 },
                contentChanges: [{ text: 'export const use = 1;\n' }]
            })

            expect(ctx.workspaceScanCache.importerUris.size).toBe(0)
            expect(ctx.workspaceScanCache.fileTexts.has(uri)).toBe(false)
        })

        it('didOpen invalidates the workspace file list', () => {
            setupDocumentLifecycleHandlers(ctx)
            listWorkspaceSourceFiles(ctx, workDir)
            expect(ctx.workspaceScanCache.fileLists.size).toBeGreaterThan(0)

            const newFilePath = path.join(workDir, 'brand-new.ts')
            fs.writeFileSync(newFilePath, 'export const brandNew = 1;\n')
            upstream.triggerNotification('textDocument/didOpen', {
                textDocument: { uri: pathToFileURL(newFilePath).href, languageId: 'typescript', version: 1, text: 'export const brandNew = 1;\n' }
            })

            expect(listWorkspaceSourceFiles(ctx, workDir).map((f) => path.basename(f))).toContain('brand-new.ts')
        })

        it('didChange makes a file created on disk without a didOpen visible to scans', () => {
            // Agents write new files with no didOpen; the next edit event must not
            // leave scans running against a stale directory listing for the TTL.
            setupDocumentLifecycleHandlers(ctx)
            const editedUri = pathToFileURL(path.join(workDir, 'importer.ts')).href
            listWorkspaceSourceFiles(ctx, workDir)

            fs.writeFileSync(path.join(workDir, 'agent-created.ts'), 'export const created = 1;\n')
            upstream.triggerNotification('textDocument/didChange', {
                textDocument: { uri: editedUri, version: 2 },
                contentChanges: [{ text: "import { target } from './target';\nexport const use = target;\n" }]
            })

            expect(listWorkspaceSourceFiles(ctx, workDir).map((f) => path.basename(f))).toContain('agent-created.ts')
        })

        it('bounds the disk-text cache and drops expired entries on invalidation', () => {
            vi.useFakeTimers({ now: Date.now() })
            const uri = pathToFileURL(path.join(workDir, 'target.ts')).href
            getDocumentText(ctx, uri)
            expect(ctx.workspaceScanCache.fileTexts.has(uri)).toBe(true)

            // Entries past the TTL are swept when any lifecycle invalidation runs, so
            // an idle session doesn't retain the whole workspace's text forever.
            vi.advanceTimersByTime(60_000)
            invalidateWorkspaceCachesForUri(ctx, 'file:///unrelated.ts')
            expect(ctx.workspaceScanCache.fileTexts.has(uri)).toBe(false)
        })

        it('didSave and didClose invalidate the saved document text', () => {
            setupDocumentLifecycleHandlers(ctx)
            const uri = pathToFileURL(path.join(workDir, 'target.ts')).href
            getDocumentText(ctx, uri)
            expect(ctx.workspaceScanCache.fileTexts.has(uri)).toBe(true)

            upstream.triggerNotification('textDocument/didSave', { textDocument: { uri } })
            expect(ctx.workspaceScanCache.fileTexts.has(uri)).toBe(false)

            getDocumentText(ctx, uri)
            expect(ctx.workspaceScanCache.fileTexts.has(uri)).toBe(true)
            upstream.triggerNotification('textDocument/didClose', { textDocument: { uri } })
            expect(ctx.workspaceScanCache.fileTexts.has(uri)).toBe(false)
        })
    })

    describe('workspace config reload', () => {
        it('clears scan caches and the path-alias cache', () => {
            listWorkspaceSourceFiles(ctx, workDir)
            ctx.pathAliasConfigCache.set(workDir, [])
            expect(ctx.workspaceScanCache.fileLists.size).toBeGreaterThan(0)

            applyWorkspaceConfigFromInitParams(ctx, ctx.savedInitParams!)

            expect(ctx.workspaceScanCache.fileLists.size).toBe(0)
            expect(ctx.pathAliasConfigCache.size).toBe(0)
        })
    })
})

describe('path alias resolution', () => {
    let workDir: string
    let ctx: ProxyContext

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-alias-'))
        ctx = (() => {
            const context = createProxyContext(
                createMockConnection() as unknown as MessageConnection,
                createMockConnection() as unknown as MessageConnection,
                createMockConnection() as unknown as MessageConnection
            )
            context.savedInitParams = {
                processId: null,
                rootUri: pathToFileURL(workDir).href,
                workspaceFolders: [{ uri: pathToFileURL(workDir).href, name: 'workspace' }],
                capabilities: {}
            }
            return context
        })()
    })

    afterEach(() => {
        fs.rmSync(workDir, { recursive: true, force: true })
    })

    describe('applyPathPattern', () => {
        it('substitutes the wildcard middle into the target', () => {
            expect(applyPathPattern('@/*', 'src/*', '@/stores/ui')).toBe('src/stores/ui')
        })

        it('requires prefix and suffix to match', () => {
            expect(applyPathPattern('@/*', 'src/*', 'lib/stores/ui')).toBeNull()
            expect(applyPathPattern('@/*.ts', 'src/*.ts', '@/stores/ui.js')).toBeNull()
        })

        it('handles exact patterns without wildcards', () => {
            expect(applyPathPattern('vue', 'node_modules/vue', 'vue')).toBe('node_modules/vue')
            expect(applyPathPattern('vue', 'node_modules/vue', 'vue-router')).toBeNull()
        })
    })

    describe('resolveFileCandidate', () => {
        it('prefers the exact path, then tries extensions in order', () => {
            fs.writeFileSync(path.join(workDir, 'mod.ts'), '')
            fs.writeFileSync(path.join(workDir, 'mod.js'), '')
            expect(resolveFileCandidate(path.join(workDir, 'mod'))).toBe(path.join(workDir, 'mod.ts'))
        })

        it('falls back to directory index files', () => {
            fs.mkdirSync(path.join(workDir, 'pkg'))
            fs.writeFileSync(path.join(workDir, 'pkg', 'index.vue'), '')
            expect(resolveFileCandidate(path.join(workDir, 'pkg'))).toBe(path.join(workDir, 'pkg', 'index.vue'))
        })

        it('returns null when nothing exists', () => {
            expect(resolveFileCandidate(path.join(workDir, 'missing'))).toBeNull()
        })
    })

    describe('loadPathAliasConfigs', () => {
        it('reads baseUrl and paths from tsconfig.json', () => {
            fs.writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }))
            const configs = loadPathAliasConfigs(ctx, workDir)
            expect(configs).toHaveLength(1)
            expect(configs[0]!.baseUrl).toBe(workDir)
            expect(configs[0]!.paths).toEqual({ '@/*': ['src/*'] })
        })

        it('includes jsconfig.json alongside tsconfig.json', () => {
            fs.writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.' } }))
            fs.writeFileSync(path.join(workDir, 'jsconfig.json'), JSON.stringify({ compilerOptions: { paths: { 'Lib/*': ['lib/*'] } } }))
            const configs = loadPathAliasConfigs(ctx, workDir)
            expect(configs).toHaveLength(2)
        })

        it('skips configs without baseUrl or paths and tolerates missing files', () => {
            fs.writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
            expect(loadPathAliasConfigs(ctx, workDir)).toEqual([])
        })

        it('caches per root path', () => {
            fs.writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.' } }))
            const first = loadPathAliasConfigs(ctx, workDir)
            expect(loadPathAliasConfigs(ctx, workDir)).toBe(first)
        })
    })

    describe('resolveWorkspaceModuleSpecifier', () => {
        it('resolves relative imports against the requesting file', () => {
            fs.mkdirSync(path.join(workDir, 'src'))
            fs.writeFileSync(path.join(workDir, 'src', 'helper.ts'), '')
            const requestUri = pathToFileURL(path.join(workDir, 'src', 'main.ts')).href
            expect(resolveWorkspaceModuleSpecifier(ctx, requestUri, './helper')).toBe(path.join(workDir, 'src', 'helper.ts'))
        })

        it('resolves aliased imports through tsconfig paths', () => {
            fs.mkdirSync(path.join(workDir, 'src', 'stores'), { recursive: true })
            fs.writeFileSync(path.join(workDir, 'src', 'stores', 'ui.ts'), '')
            fs.writeFileSync(path.join(workDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }))
            const requestUri = pathToFileURL(path.join(workDir, 'main.ts')).href
            expect(resolveWorkspaceModuleSpecifier(ctx, requestUri, '@/stores/ui')).toBe(path.join(workDir, 'src', 'stores', 'ui.ts'))
        })

        it('returns null for unresolvable bare specifiers', () => {
            const requestUri = pathToFileURL(path.join(workDir, 'main.ts')).href
            expect(resolveWorkspaceModuleSpecifier(ctx, requestUri, 'left-pad')).toBeNull()
        })
    })
})
