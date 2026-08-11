import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { ProxyContext } from './proxy-context.js'
import { normalizeSpawnedConnection, buildVtslsInitParams, buildVtslsSettings, buildVueLsInitParams, buildVueLsSettings, isVueUri } from './proxy-utils.js'
import { safeSendNotification } from './proxy-communication.js'
import * as logger from './logger.js'

type RecoverFn = (reason: string, forceKill?: boolean) => Promise<void>

/** Everything that differs between the vtsls and vue_ls recovery paths. */
interface RecoverySpec {
    server: 'vtsls' | 'vue_ls'
    crashMessage: string
    canSpawn: (ctx: ProxyContext) => boolean
    spawn: (ctx: ProxyContext) => ReturnType<typeof normalizeSpawnedConnection>
    getRetry: (ctx: ProxyContext) => ProxyContext['vtslsRetry']
    getRecoveryPromise: (ctx: ProxyContext) => Promise<void> | null
    setRecoveryPromise: (ctx: ProxyContext, promise: Promise<void> | null) => void
    getConsecutiveFailures: (ctx: ProxyContext) => number
    setConsecutiveFailures: (ctx: ProxyContext, count: number) => void
    getCurrentConn: (ctx: ProxyContext) => MessageConnection
    killCurrent: (ctx: ProxyContext) => void
    publish: (ctx: ProxyContext, conn: MessageConnection, kill: (() => void) | undefined) => void
    setDiagnosticsConnection: (ctx: ProxyContext, conn: MessageConnection | null) => void
    buildInitParams: (ctx: ProxyContext) => unknown | null
    buildSettings: (ctx: ProxyContext) => unknown
    replayFilter: (uri: string) => boolean
    /** Runs after the restart delay, before spawning the replacement. */
    beforeSpawn?: (ctx: ProxyContext) => Promise<void>
}

const VTSLS_SPEC: RecoverySpec = {
    server: 'vtsls',
    crashMessage: 'vue-ts-lsp: vtsls has crashed too many times and will not be restarted. Please reload your editor.',
    canSpawn: (ctx) => ctx.crashOptions?.spawnVtsls !== undefined,
    spawn: (ctx) => normalizeSpawnedConnection(ctx.crashOptions!.spawnVtsls!()),
    getRetry: (ctx) => ctx.vtslsRetry,
    getRecoveryPromise: (ctx) => ctx.vtslsRecoveryPromise,
    setRecoveryPromise: (ctx, promise) => {
        ctx.vtslsRecoveryPromise = promise
    },
    getConsecutiveFailures: (ctx) => ctx.vtslsConsecutiveRecoveryFailures,
    setConsecutiveFailures: (ctx, count) => {
        ctx.vtslsConsecutiveRecoveryFailures = count
    },
    getCurrentConn: (ctx) => ctx.currentVtsls,
    killCurrent: (ctx) => ctx.currentKillVtsls?.(),
    publish: (ctx, conn, kill) => {
        ctx.currentVtsls = conn
        ctx.currentKillVtsls = kill ?? ctx.currentKillVtsls
        ctx.vtslsDiagnosticsConnection = conn
        ctx.vtslsInitialized = true
    },
    setDiagnosticsConnection: (ctx, conn) => {
        ctx.vtslsDiagnosticsConnection = conn
    },
    buildInitParams: (ctx) =>
        ctx.savedInitParams !== null && ctx.savedVueTypescriptPluginLocation !== null
            ? buildVtslsInitParams(ctx.savedInitParams, ctx.savedVueTypescriptPluginLocation)
            : null,
    buildSettings: (ctx) => buildVtslsSettings(ctx.savedVueTypescriptPluginLocation!),
    replayFilter: () => true
}

const VUE_LS_SPEC: RecoverySpec = {
    server: 'vue_ls',
    crashMessage: 'vue-ts-lsp: vue-language-server has crashed too many times and will not be restarted. Please reload your editor.',
    canSpawn: (ctx) => ctx.crashOptions?.spawnVueLs !== undefined,
    spawn: (ctx) => normalizeSpawnedConnection(ctx.crashOptions!.spawnVueLs!()),
    getRetry: (ctx) => ctx.vueLsRetry,
    getRecoveryPromise: (ctx) => ctx.vueLsRecoveryPromise,
    setRecoveryPromise: (ctx, promise) => {
        ctx.vueLsRecoveryPromise = promise
    },
    getConsecutiveFailures: (ctx) => ctx.vueLsConsecutiveRecoveryFailures,
    setConsecutiveFailures: (ctx, count) => {
        ctx.vueLsConsecutiveRecoveryFailures = count
    },
    getCurrentConn: (ctx) => ctx.currentVueLs,
    killCurrent: (ctx) => ctx.currentKillVueLs?.(),
    publish: (ctx, conn, kill) => {
        ctx.currentVueLs = conn
        ctx.currentKillVueLs = kill ?? ctx.currentKillVueLs
        ctx.vueLsDiagnosticsConnection = conn
    },
    setDiagnosticsConnection: (ctx, conn) => {
        ctx.vueLsDiagnosticsConnection = conn
    },
    buildInitParams: (ctx) => (ctx.savedInitParams !== null ? buildVueLsInitParams(ctx.savedInitParams) : null),
    buildSettings: () => buildVueLsSettings(),
    replayFilter: isVueUri,
    // vue_ls sends tsserver/request during initialize. The vtsls recovery promise now
    // spans its complete bounded retry chain, so success means the published bridge is
    // ready and rejection means Vue must fail closed rather than initialize degraded.
    beforeSpawn: async (ctx) => {
        const activeVtslsRecovery = ctx.vtslsRecoveryPromise
        if (activeVtslsRecovery !== null) {
            await activeVtslsRecovery
        }
        if (!ctx.vtslsInitialized) {
            throw new Error('vue_ls recovery blocked because vtsls is not initialized')
        }
    }
}

function setupCrashRecoveryFor(spec: RecoverySpec, ctx: ProxyContext, conn: MessageConnection, recoverFn: RecoverFn): void {
    if (!spec.canSpawn(ctx)) return
    conn.onClose(() => {
        if (ctx.intentionalRecoveryCloses.delete(conn)) {
            logger.debug('proxy', `${spec.server} ignored intentional recovery close`)
            return
        }
        if (conn !== spec.getCurrentConn(ctx)) {
            return
        }
        recoverFn('connection closed').catch((err: unknown) => {
            logger.error('proxy', `${spec.server} recovery error: ${String(err)}`)
        })
    })
}

function notifyRetryCap(spec: RecoverySpec, ctx: ProxyContext): void {
    const retry = spec.getRetry(ctx)
    logger.error(
        'proxy',
        `${spec.server}: retry cap reached (max ${retry.maxRestarts} in ${retry.windowMs / 1000}s, consecutive=${spec.getConsecutiveFailures(ctx)})`
    )
    safeSendNotification(ctx.upstream, 'window/showMessage', {
        type: 1,
        message: spec.crashMessage
    })
}

function disposeFailedCandidate(spec: RecoverySpec, spawned: ReturnType<typeof normalizeSpawnedConnection>): void {
    try {
        spawned.kill?.()
    } catch (err: unknown) {
        logger.warn('proxy', `${spec.server} failed candidate kill error: ${String(err)}`)
    }
    try {
        spawned.conn.dispose()
    } catch (err: unknown) {
        logger.warn('proxy', `${spec.server} failed candidate dispose error: ${String(err)}`)
    }
}

function observeCandidateClose(conn: MessageConnection): { closed: Promise<void>; isClosed: () => boolean } {
    let didClose = false
    let resolveClose!: () => void
    const closed = new Promise<void>((resolve) => {
        resolveClose = resolve
    })
    conn.onClose(() => {
        if (!didClose) {
            didClose = true
            resolveClose()
        }
    })
    return { closed, isClosed: () => didClose }
}

async function initializeCandidate(spec: RecoverySpec, ctx: ProxyContext, conn: MessageConnection, initParams: unknown, closed: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
        await Promise.race([
            conn.sendRequest('initialize', initParams),
            closed.then(() => {
                throw new Error(`${spec.server} replacement connection closed during initialization`)
            }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`${spec.server} replacement initialize timed out after ${ctx.requestTimeoutMs}ms`))
                }, ctx.requestTimeoutMs)
            })
        ])
    } finally {
        if (timer !== null) {
            clearTimeout(timer)
        }
    }
}

function candidateClosedError(spec: RecoverySpec): Error {
    return new Error(`${spec.server} replacement connection closed before publication`)
}

async function runRecoveryChain(
    spec: RecoverySpec,
    ctx: ProxyContext,
    initialReason: string,
    setupHandlers: (conn: MessageConnection) => void,
    forceKill: boolean
): Promise<void> {
    const retry = spec.getRetry(ctx)
    let reason = initialReason
    let lastError: unknown = null
    let shouldForceKill = forceKill

    // Supersede the old diagnostic generation before the recovery delay. This keeps
    // a timed-out child from repopulating the store while it is awaiting SIGTERM.
    spec.setDiagnosticsConnection(ctx, null)
    ctx.diagnosticsStore.clearServer(spec.server)
    if (spec.server === 'vtsls') {
        ctx.vtslsInitialized = false
    }

    while (true) {
        logger.info('proxy', `${spec.server} recovery starting reason=${reason}`)

        // Two independent bounds: the sliding window catches rapid crash bursts, and
        // the consecutive counter catches slow failed-initialize/short-lived cycles.
        if (spec.getConsecutiveFailures(ctx) >= retry.maxRestarts || !retry.canRestart()) {
            notifyRetryCap(spec, ctx)
            throw lastError instanceof Error ? lastError : new Error(`${spec.server} recovery retry cap reached`)
        }

        await new Promise<void>((resolve) => setTimeout(resolve, ctx.delayMs))

        if (shouldForceKill) {
            // Keep the connection marked until its close is actually observed. A
            // replacement can fail before SIGTERM produces onClose.
            ctx.intentionalRecoveryCloses.add(spec.getCurrentConn(ctx))
            spec.killCurrent(ctx)
            shouldForceKill = false
        }

        // For Vue this awaits the entire active vtsls retry chain and deliberately
        // rejects on permanent vtsls failure, before any Vue candidate is spawned.
        await spec.beforeSpawn?.(ctx)

        const spawned = spec.spawn(ctx)
        const closeGuard = observeCandidateClose(spawned.conn)

        try {
            spawned.conn.listen()
            setupHandlers(spawned.conn)

            const initParams = spec.buildInitParams(ctx)
            if (initParams !== null) {
                await initializeCandidate(spec, ctx, spawned.conn, initParams, closeGuard.closed)
                if (closeGuard.isClosed()) throw candidateClosedError(spec)
                safeSendNotification(spawned.conn, 'initialized', {})
                safeSendNotification(spawned.conn, 'workspace/didChangeConfiguration', {
                    settings: spec.buildSettings(ctx)
                })
            }

            for (const [uri, doc] of ctx.documentStore.getAll()) {
                if (!spec.replayFilter(uri)) {
                    continue
                }
                safeSendNotification(spawned.conn, 'textDocument/didOpen', {
                    textDocument: {
                        uri,
                        languageId: doc.languageId,
                        version: doc.version,
                        text: doc.content
                    }
                })
            }

            if (closeGuard.isClosed()) throw candidateClosedError(spec)

            // Install the post-publication crash observer before publishing. The
            // candidate close guard makes a close in this narrow window fail the
            // attempt rather than publishing an already-closed connection.
            const publishedAt = Date.now()
            setupCrashRecoveryFor(spec, ctx, spawned.conn, (nextReason, nextForceKill) => {
                if (Date.now() - publishedAt >= ctx.recoveryStabilityWindowMs) {
                    spec.setConsecutiveFailures(ctx, 0)
                } else {
                    spec.setConsecutiveFailures(ctx, spec.getConsecutiveFailures(ctx) + 1)
                }
                return recoverServer(spec, ctx, nextReason, setupHandlers, nextForceKill ?? false)
            })
            if (closeGuard.isClosed()) throw candidateClosedError(spec)

            // Publish exactly once, after initialize, replay, and close-listener setup.
            spec.publish(ctx, spawned.conn, spawned.kill)
            logger.info('proxy', `${spec.server} restarted successfully`)
            return
        } catch (err: unknown) {
            disposeFailedCandidate(spec, spawned)
            lastError = err
            const failures = spec.getConsecutiveFailures(ctx) + 1
            spec.setConsecutiveFailures(ctx, failures)
            if (failures >= retry.maxRestarts) {
                logger.error('proxy', `${spec.server}: ${failures} consecutive failed recovery attempts; giving up`)
                notifyRetryCap(spec, ctx)
                throw err
            }
            reason = `retry after failed recovery: ${String(err)}`
        }
    }
}

function recoverServer(
    spec: RecoverySpec,
    ctx: ProxyContext,
    reason: string,
    setupHandlers: (conn: MessageConnection) => void,
    forceKill: boolean
): Promise<void> {
    const active = spec.getRecoveryPromise(ctx)
    if (active !== null) {
        return active
    }

    const recovery = runRecoveryChain(spec, ctx, reason, setupHandlers, forceKill).finally(() => {
        spec.setRecoveryPromise(ctx, null)
    })
    spec.setRecoveryPromise(ctx, recovery)
    return recovery
}

export function setupVtslsCrashRecovery(ctx: ProxyContext, conn: MessageConnection, recoverFn: RecoverFn): void {
    setupCrashRecoveryFor(VTSLS_SPEC, ctx, conn, recoverFn)
}

export function setupVueLsCrashRecovery(ctx: ProxyContext, conn: MessageConnection, recoverFn: RecoverFn): void {
    setupCrashRecoveryFor(VUE_LS_SPEC, ctx, conn, recoverFn)
}

export function recoverVtsls(ctx: ProxyContext, reason: string, setupHandlers: (conn: MessageConnection) => void, forceKill = false): Promise<void> {
    return recoverServer(VTSLS_SPEC, ctx, reason, setupHandlers, forceKill)
}

export function recoverVueLs(ctx: ProxyContext, reason: string, setupHandlers: (conn: MessageConnection) => void, forceKill = false): Promise<void> {
    return recoverServer(VUE_LS_SPEC, ctx, reason, setupHandlers, forceKill)
}
