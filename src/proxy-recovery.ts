import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { ProxyContext } from './proxy-context.js'
import { normalizeSpawnedConnection, buildVtslsInitParams, buildVtslsSettings, buildVueLsInitParams, buildVueLsSettings, isVueUri } from './proxy-utils.js'
import * as logger from './logger.js'

export function setupVtslsCrashRecovery(ctx: ProxyContext, conn: MessageConnection, recoverFn: (reason: string, forceKill?: boolean) => Promise<void>): void {
    if (!ctx.crashOptions?.spawnVtsls) return
    conn.onClose(() => {
        if (conn !== ctx.currentVtsls) {
            return
        }
        recoverFn('connection closed').catch((err: unknown) => {
            logger.error('proxy', `vtsls recovery error: ${String(err)}`)
        })
    })
}

export function setupVueLsCrashRecovery(ctx: ProxyContext, conn: MessageConnection, recoverFn: (reason: string, forceKill?: boolean) => Promise<void>): void {
    if (!ctx.crashOptions?.spawnVueLs) return
    conn.onClose(() => {
        if (conn !== ctx.currentVueLs) {
            return
        }
        recoverFn('connection closed').catch((err: unknown) => {
            logger.error('proxy', `vue_ls recovery error: ${String(err)}`)
        })
    })
}

export async function recoverVtsls(ctx: ProxyContext, reason: string, setupHandlers: (conn: MessageConnection) => void, forceKill = false): Promise<void> {
    if (ctx.vtslsRecoveryPromise !== null) {
        return ctx.vtslsRecoveryPromise
    }

    ctx.vtslsRecoveryPromise = (async () => {
        logger.info('proxy', `vtsls recovery starting reason=${reason}`)

        if (!ctx.vtslsRetry.canRestart()) {
            logger.error('proxy', `vtsls: retry cap reached (max ${ctx.vtslsRetry.maxRestarts} in ${ctx.vtslsRetry.windowMs / 1000}s)`)
            ctx.upstream.sendNotification('window/showMessage', {
                type: 1,
                message: 'vue-ts-lsp: vtsls has crashed too many times and will not be restarted. Please reload your editor.'
            })
            return
        }

        if (forceKill) {
            ctx.currentKillVtsls?.()
        }

        await new Promise<void>((resolve) => setTimeout(resolve, ctx.delayMs))

        const spawned = normalizeSpawnedConnection(ctx.crashOptions!.spawnVtsls!())
        ctx.currentVtsls = spawned.conn
        ctx.currentKillVtsls = spawned.kill ?? ctx.currentKillVtsls
        ctx.currentVtsls.listen()
        setupHandlers(ctx.currentVtsls)

        if (ctx.savedInitParams !== null && ctx.savedVueTypescriptPluginLocation !== null) {
            await ctx.currentVtsls.sendRequest('initialize', buildVtslsInitParams(ctx.savedInitParams, ctx.savedVueTypescriptPluginLocation))
            ctx.currentVtsls.sendNotification('initialized', {})
            ctx.currentVtsls.sendNotification('workspace/didChangeConfiguration', {
                settings: buildVtslsSettings(ctx.savedVueTypescriptPluginLocation)
            })
        }

        for (const [uri, doc] of ctx.documentStore.getAll()) {
            ctx.currentVtsls.sendNotification('textDocument/didOpen', {
                textDocument: {
                    uri,
                    languageId: doc.languageId,
                    version: doc.version,
                    text: doc.content
                }
            })
        }

        logger.info('proxy', 'vtsls restarted successfully')
        setupVtslsCrashRecovery(ctx, ctx.currentVtsls, (r, fk) => recoverVtsls(ctx, r, setupHandlers, fk))
    })().finally(() => {
        ctx.vtslsRecoveryPromise = null
    })

    return ctx.vtslsRecoveryPromise
}

export async function recoverVueLs(ctx: ProxyContext, reason: string, setupHandlers: (conn: MessageConnection) => void, forceKill = false): Promise<void> {
    if (ctx.vueLsRecoveryPromise !== null) {
        return ctx.vueLsRecoveryPromise
    }

    ctx.vueLsRecoveryPromise = (async () => {
        logger.info('proxy', `vue_ls recovery starting reason=${reason}`)

        if (!ctx.vueLsRetry.canRestart()) {
            logger.error('proxy', `vue_ls: retry cap reached (max ${ctx.vueLsRetry.maxRestarts} in ${ctx.vueLsRetry.windowMs / 1000}s)`)
            ctx.upstream.sendNotification('window/showMessage', {
                type: 1,
                message: 'vue-ts-lsp: vue-language-server has crashed too many times and will not be restarted. Please reload your editor.'
            })
            return
        }

        if (forceKill) {
            ctx.currentKillVueLs?.()
        }

        await new Promise<void>((resolve) => setTimeout(resolve, ctx.delayMs))

        // vue_ls sends tsserver/request during initialize, so any active vtsls recovery
        // must finish before vue_ls comes back up.
        if (ctx.vtslsRecoveryPromise !== null) {
            await ctx.vtslsRecoveryPromise
        }

        const spawned = normalizeSpawnedConnection(ctx.crashOptions!.spawnVueLs!())
        ctx.currentVueLs = spawned.conn
        ctx.currentKillVueLs = spawned.kill ?? ctx.currentKillVueLs
        ctx.currentVueLs.listen()
        setupHandlers(ctx.currentVueLs)

        if (ctx.savedInitParams !== null) {
            await ctx.currentVueLs.sendRequest('initialize', buildVueLsInitParams(ctx.savedInitParams))
            ctx.currentVueLs.sendNotification('initialized', {})
            ctx.currentVueLs.sendNotification('workspace/didChangeConfiguration', {
                settings: buildVueLsSettings()
            })
        }

        for (const [uri, doc] of ctx.documentStore.getAll()) {
            if (isVueUri(uri)) {
                ctx.currentVueLs.sendNotification('textDocument/didOpen', {
                    textDocument: {
                        uri,
                        languageId: doc.languageId,
                        version: doc.version,
                        text: doc.content
                    }
                })
            }
        }

        logger.info('proxy', 'vue_ls restarted successfully')
        setupVueLsCrashRecovery(ctx, ctx.currentVueLs, (r, fk) => recoverVueLs(ctx, r, setupHandlers, fk))
    })().finally(() => {
        ctx.vueLsRecoveryPromise = null
    })

    return ctx.vueLsRecoveryPromise
}
