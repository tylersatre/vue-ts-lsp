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
    },
    buildInitParams: (ctx) => (ctx.savedInitParams !== null ? buildVueLsInitParams(ctx.savedInitParams) : null),
    buildSettings: () => buildVueLsSettings(),
    replayFilter: isVueUri,
    // vue_ls sends tsserver/request during initialize, so any active vtsls recovery
    // must finish before vue_ls comes back up. A failed vtsls recovery must not abort
    // this one — vue_ls can still be useful and its retry budget is already spent.
    beforeSpawn: async (ctx) => {
        if (ctx.vtslsRecoveryPromise !== null) {
            await ctx.vtslsRecoveryPromise.catch(() => {})
        }
    }
}

function setupCrashRecoveryFor(spec: RecoverySpec, ctx: ProxyContext, conn: MessageConnection, recoverFn: RecoverFn): void {
    if (!spec.canSpawn(ctx)) return
    conn.onClose(() => {
        if (conn !== spec.getCurrentConn(ctx)) {
            return
        }
        recoverFn('connection closed').catch((err: unknown) => {
            logger.error('proxy', `${spec.server} recovery error: ${String(err)}`)
        })
    })
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

    const recovery = (async () => {
        logger.info('proxy', `${spec.server} recovery starting reason=${reason}`)

        const retry = spec.getRetry(ctx)
        // Two independent bounds: the sliding window catches rapid crash bursts, and
        // the consecutive counter catches slow cycles (crash-shortly-after-recovery
        // and failed initializes) that the window's timestamp eviction cannot see.
        if (spec.getConsecutiveFailures(ctx) >= retry.maxRestarts || !retry.canRestart()) {
            logger.error(
                'proxy',
                `${spec.server}: retry cap reached (max ${retry.maxRestarts} in ${retry.windowMs / 1000}s, consecutive=${spec.getConsecutiveFailures(ctx)})`
            )
            safeSendNotification(ctx.upstream, 'window/showMessage', {
                type: 1,
                message: spec.crashMessage
            })
            return
        }

        if (forceKill) {
            spec.killCurrent(ctx)
        }

        // The dead server's stored diagnostics are stale; drop them so .vue merges
        // don't blend pre-crash entries with the other server's fresh publishes.
        ctx.diagnosticsStore.clearServer(spec.server)

        await new Promise<void>((resolve) => setTimeout(resolve, ctx.delayMs))
        await spec.beforeSpawn?.(ctx)

        const spawned = spec.spawn(ctx)
        spawned.conn.listen()
        setupHandlers(spawned.conn)

        try {
            const initParams = spec.buildInitParams(ctx)
            if (initParams !== null) {
                await spawned.conn.sendRequest('initialize', initParams)
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
        } catch (err: unknown) {
            // The replacement never became usable; kill it and keep the old connection
            // published. The old connection's onClose has already fired, so nothing
            // external will trigger another attempt — schedule one ourselves.
            //
            // RetryTracker's sliding window cannot bound this chain (attempts that
            // outlast windowMs/maxRestarts never accumulate), so a consecutive-failure
            // counter provides a wall-clock-independent stop.
            spawned.kill?.()
            spawned.conn.dispose()
            const failures = spec.getConsecutiveFailures(ctx) + 1
            spec.setConsecutiveFailures(ctx, failures)
            if (failures >= retry.maxRestarts) {
                logger.error('proxy', `${spec.server}: ${failures} consecutive failed recovery attempts; giving up`)
                safeSendNotification(ctx.upstream, 'window/showMessage', {
                    type: 1,
                    message: spec.crashMessage
                })
            } else {
                setTimeout(() => {
                    recoverServer(spec, ctx, `retry after failed recovery: ${String(err)}`, setupHandlers, false).catch((retryErr: unknown) => {
                        logger.error('proxy', `${spec.server} recovery retry error: ${String(retryErr)}`)
                    })
                }, ctx.delayMs)
            }
            throw err
        }

        // Publish only now: until the fresh child is initialized and knows about every
        // open document, upstream notifications must keep routing to the previous
        // connection. A didChange sent to an uninitialized child is a protocol
        // violation that can re-crash it, and a didOpen would be duplicated by replay.
        spec.publish(ctx, spawned.conn, spawned.kill)

        logger.info('proxy', `${spec.server} restarted successfully`)
        // The give-up budget resets only once the replacement proves stable: a crash
        // within the stability window counts as another consecutive failure, so a
        // child that dies shortly after every recovery cannot respawn forever.
        const publishedAt = Date.now()
        setupCrashRecoveryFor(spec, ctx, spawned.conn, (r, fk) => {
            if (Date.now() - publishedAt >= ctx.recoveryStabilityWindowMs) {
                spec.setConsecutiveFailures(ctx, 0)
            } else {
                spec.setConsecutiveFailures(ctx, spec.getConsecutiveFailures(ctx) + 1)
            }
            return recoverServer(spec, ctx, r, setupHandlers, fk ?? false)
        })
    })().finally(() => {
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
