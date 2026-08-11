import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { TextDocumentSyncKind } from 'vscode-languageserver-protocol'
import type { CrashRecoveryOptions } from './proxy-types.js'
import { createProxyContext } from './proxy-context.js'
import { resolveVueTypescriptPluginLocation, buildVtslsInitParams, buildVueLsInitParams, buildVtslsSettings, buildVueLsSettings } from './proxy-utils.js'
import { applyWorkspaceConfigFromInitParams } from './proxy-workspace.js'
import {
    setupVtslsHandlers,
    setupVueLsHandlers,
    setupTsserverRequestHandler,
    setupDocumentLifecycleHandlers,
    setupPullDiagnosticHandler,
    forwardRequest
} from './proxy-handlers.js'
import { recoverVtsls, recoverVueLs, setupVtslsCrashRecovery, setupVueLsCrashRecovery } from './proxy-recovery.js'
import { safeSendNotification } from './proxy-communication.js'
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
    setupPullDiagnosticHandler(ctx)

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
                callHierarchyProvider: true,
                diagnosticProvider: {
                    interFileDependencies: true,
                    workspaceDiagnostics: false
                }
            }
        }
    })

    upstream.onNotification('initialized', (params: unknown) => {
        safeSendNotification(ctx.currentVtsls, 'initialized', params)
        safeSendNotification(ctx.currentVueLs, 'initialized', params)
        if (ctx.savedVueTypescriptPluginLocation !== null) {
            logger.debug('proxy', 'pushing workspace/didChangeConfiguration to child servers')
            safeSendNotification(ctx.currentVtsls, 'workspace/didChangeConfiguration', {
                settings: buildVtslsSettings(ctx.savedVueTypescriptPluginLocation)
            })
            safeSendNotification(ctx.currentVueLs, 'workspace/didChangeConfiguration', {
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

    // The child shutdown sequence must run at most once, whichever path triggers it
    // first — the LSP shutdown request, a signal, or the upstream connection closing.
    let shutdownStarted = false
    let exitStarted = false

    upstream.onRequest('shutdown', async () => {
        shutdownStarted = true
        await performShutdown()
        return null
    })

    function flushLogsAndExit(): void {
        if (exitStarted) {
            return
        }
        exitStarted = true
        void Promise.resolve(logger.closeFileLogging()).finally(() => process.exit(0))
    }

    upstream.onNotification('exit', () => {
        safeSendNotification(ctx.currentVtsls, 'exit')
        safeSendNotification(ctx.currentVueLs, 'exit')
        flushLogsAndExit()
    })

    const shutdownOnSignal = () => {
        if (shutdownStarted) {
            // A shutdown is already in flight (or a second signal arrived — treat it
            // as a force quit). The graceful path's SIGTERM-on-timeout may never get
            // to run before we exit, so kill the children outright: exiting here with
            // live children would orphan two memory-heavy processes.
            ctx.currentKillVtsls?.()
            ctx.currentKillVueLs?.()
            flushLogsAndExit()
            return
        }
        shutdownStarted = true
        void performShutdown().then(flushLogsAndExit, flushLogsAndExit)
    }
    if (activeShutdownSignalHandler !== null) {
        process.off('SIGINT', activeShutdownSignalHandler)
        process.off('SIGTERM', activeShutdownSignalHandler)
    }
    activeShutdownSignalHandler = shutdownOnSignal
    process.on('SIGINT', shutdownOnSignal)
    process.on('SIGTERM', shutdownOnSignal)

    // Claude Code dying without the shutdown/exit handshake or a signal (SIGKILL, OOM,
    // hard crash) surfaces only as stdin closing. Without this, the proxy would run
    // forever with two live, memory-heavy child servers.
    upstream.onClose(() => {
        logger.warn('proxy', 'upstream connection closed without shutdown handshake; stopping child servers')
        shutdownOnSignal()
    })

    return ctx.documentStore
}
