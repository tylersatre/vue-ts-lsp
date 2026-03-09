import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { TextDocumentSyncKind } from 'vscode-languageserver-protocol'
import type { CrashRecoveryOptions } from './proxy-types.js'
import { createProxyContext } from './proxy-context.js'
import { resolveVueTypescriptPluginLocation, buildVtslsInitParams, buildVueLsInitParams, buildVtslsSettings, buildVueLsSettings } from './proxy-utils.js'
import { applyWorkspaceConfigFromInitParams } from './proxy-workspace.js'
import { setupVtslsHandlers, setupVueLsHandlers, setupTsserverRequestHandler, setupDocumentLifecycleHandlers, forwardRequest } from './proxy-handlers.js'
import { recoverVtsls, recoverVueLs, setupVtslsCrashRecovery, setupVueLsCrashRecovery } from './proxy-recovery.js'
import type { DocumentStore } from './documents.js'
import * as logger from './logger.js'

export { resolveVueTypescriptPluginLocation } from './proxy-utils.js'
export type { CrashRecoveryOptions } from './proxy-types.js'

// Module-level state — safe because setupProxy is only called once (from index.ts entrypoint).
let activeShutdownSignalHandler: (() => void) | null = null

export function setupProxy(
    upstream: MessageConnection,
    vtsls: MessageConnection,
    vueLs: MessageConnection,
    crashOptions?: CrashRecoveryOptions
): DocumentStore {
    const ctx = createProxyContext(upstream, vtsls, vueLs, crashOptions)

    ctx.currentVtsls.listen()
    ctx.currentVueLs.listen()

    // Wire recovery callbacks (breaks circular dep between recovery and handlers)
    const vtslsSetupHandlers = (conn: MessageConnection): void => {
        setupVtslsHandlers(ctx, conn)
        setupTsserverRequestHandler(ctx, conn)
    }
    const vueLsSetupHandlers = (conn: MessageConnection): void => {
        setupVueLsHandlers(ctx, conn)
        setupTsserverRequestHandler(ctx, conn)
    }

    ctx.recoverVtsls = (reason: string, forceKill?: boolean) => recoverVtsls(ctx, reason, vtslsSetupHandlers, forceKill)
    ctx.recoverVueLs = (reason: string, forceKill?: boolean) => recoverVueLs(ctx, reason, vueLsSetupHandlers, forceKill)

    // Set up server-side handlers
    setupVtslsHandlers(ctx, ctx.currentVtsls)
    setupVueLsHandlers(ctx, ctx.currentVueLs)

    // Set up document lifecycle handlers (didOpen, didChange, didClose, didSave)
    setupDocumentLifecycleHandlers(ctx)

    // Forward LSP requests
    forwardRequest(ctx, 'textDocument/definition')
    forwardRequest(ctx, 'textDocument/implementation')
    forwardRequest(ctx, 'textDocument/hover')
    forwardRequest(ctx, 'textDocument/references')
    forwardRequest(ctx, 'textDocument/documentSymbol')
    forwardRequest(ctx, 'workspace/symbol')
    forwardRequest(ctx, 'textDocument/prepareCallHierarchy')
    forwardRequest(ctx, 'callHierarchy/incomingCalls')
    forwardRequest(ctx, 'callHierarchy/outgoingCalls')

    // Initialize handler
    upstream.onRequest('initialize', async (params: InitializeParams) => {
        ctx.savedInitParams = params
        applyWorkspaceConfigFromInitParams(ctx, params)
        logger.info('proxy', 'initialize: starting initialization sequence')
        const vueTypescriptPluginLocation = resolveVueTypescriptPluginLocation()
        ctx.savedVueTypescriptPluginLocation = vueTypescriptPluginLocation

        // vue_ls starts sending tsserver/request during initialize, so vtsls has to be ready first.
        logger.info('proxy', 'initialize: spawning vtsls')
        const vtslsInitResult = await ctx.currentVtsls.sendRequest('initialize', buildVtslsInitParams(params, vueTypescriptPluginLocation))
        logger.info('proxy', `initialize: vtsls capabilities: ${JSON.stringify((vtslsInitResult as Record<string, unknown>).capabilities)}`)

        logger.info('proxy', 'initialize: spawning vue_ls')
        const vueLsInitResult = await ctx.currentVueLs.sendRequest('initialize', buildVueLsInitParams(params))
        logger.info('proxy', `initialize: vue_ls capabilities: ${JSON.stringify((vueLsInitResult as Record<string, unknown>).capabilities)}`)

        setupTsserverRequestHandler(ctx, ctx.currentVueLs)

        setupVtslsCrashRecovery(ctx, ctx.currentVtsls, ctx.recoverVtsls)
        setupVueLsCrashRecovery(ctx, ctx.currentVueLs, ctx.recoverVueLs)
        ctx.initializeCompletedAt = Date.now()

        return {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Incremental,
                definitionProvider: true,
                implementationProvider: true,
                hoverProvider: true,
                documentSymbolProvider: true,
                referencesProvider: true,
                workspaceSymbolProvider: true,
                callHierarchyProvider: true
            }
        }
    })

    upstream.onNotification('initialized', (params: unknown) => {
        ctx.currentVtsls.sendNotification('initialized', params)
        ctx.currentVueLs.sendNotification('initialized', params)
        if (ctx.savedVueTypescriptPluginLocation !== null) {
            logger.debug('proxy', 'pushing workspace/didChangeConfiguration to child servers')
            ctx.currentVtsls.sendNotification('workspace/didChangeConfiguration', {
                settings: buildVtslsSettings(ctx.savedVueTypescriptPluginLocation)
            })
            ctx.currentVueLs.sendNotification('workspace/didChangeConfiguration', {
                settings: buildVueLsSettings()
            })
        }
    })

    // Shutdown handling
    const shutdownTimeoutMs = crashOptions?.shutdownTimeoutMs ?? 5000

    async function performShutdown(): Promise<void> {
        async function shutdownServer(conn: MessageConnection, kill: (() => void) | undefined, name: string): Promise<void> {
            try {
                await Promise.race([
                    conn.sendRequest('shutdown'),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${name} shutdown timed out`)), shutdownTimeoutMs))
                ])
            } catch {
                logger.warn('proxy', `${name} did not respond in time, sending SIGTERM`)
                kill?.()
            }
        }

        await Promise.all([shutdownServer(ctx.currentVtsls, ctx.currentKillVtsls, 'vtsls'), shutdownServer(ctx.currentVueLs, ctx.currentKillVueLs, 'vue_ls')])
    }

    upstream.onRequest('shutdown', async () => {
        await performShutdown()
        return null
    })

    upstream.onNotification('exit', () => {
        ctx.currentVtsls.sendNotification('exit')
        ctx.currentVueLs.sendNotification('exit')
        process.exit(0)
    })

    const shutdownOnSignal = () => {
        void performShutdown().then(() => process.exit(0))
    }
    if (activeShutdownSignalHandler !== null) {
        process.off('SIGINT', activeShutdownSignalHandler)
        process.off('SIGTERM', activeShutdownSignalHandler)
    }
    activeShutdownSignalHandler = shutdownOnSignal
    process.on('SIGINT', shutdownOnSignal)
    process.on('SIGTERM', shutdownOnSignal)

    return ctx.documentStore
}
