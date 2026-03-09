import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { ProxyContext } from './proxy-context.js'
import {
    DownstreamRequestTimeoutError,
    type DownstreamTarget,
    type DownstreamRequestOptions,
    type TsserverRequestExecuteInfo,
    VTSLS_BACKGROUND_IDLE_POLL_MS,
    VTSLS_BACKGROUND_IDLE_MAX_WAIT_MS,
    VTSLS_BACKGROUND_REQUEST_TIMEOUT_MS,
    VUE_TS_WARMUP_WINDOW_MS
} from './proxy-types.js'
import { isVueUri, summarizePayload } from './proxy-utils.js'
import { classifyDefinitionResult } from './helpers/definitions.js'
import { isDefinitionMirrorUri } from './definition-mirrors.js'
import * as logger from './logger.js'

export function logDiagnostics(server: 'vtsls' | 'vue_ls', uri: string, count: number, mergedCount?: number): void {
    const merged = mergedCount === undefined ? '' : ` merged=${mergedCount}`
    logger.debug('proxy', `publishDiagnostics ${server} uri=${uri} count=${count}${merged}`)
}

export function buildTsserverRequestCommand(
    command: string,
    args: unknown,
    executeInfo?: TsserverRequestExecuteInfo
): { command: 'typescript.tsserverRequest'; arguments: unknown[] } {
    return {
        command: 'typescript.tsserverRequest',
        arguments: executeInfo === undefined ? [command, args] : [command, args, executeInfo]
    }
}

export function summarizeResultCount(result: unknown): number {
    if (result === null || result === undefined) return 0
    if (Array.isArray(result)) return result.length
    return 1
}

export function summarizeMethodResult(ctx: ProxyContext, method: string, requestUri: string | null, result: unknown): string {
    switch (method) {
        case 'textDocument/documentSymbol':
            return `uri=${requestUri ?? '-'} symbols=${summarizeResultCount(result)}`
        case 'textDocument/definition': {
            const classification = requestUri === null ? null : classifyDefinitionResult(requestUri, result, ctx.savedInitParams?.rootUri ?? null)
            const hasMirrorPresentation = Array.isArray(result)
                ? result.some(
                      (entry) =>
                          entry !== null &&
                          typeof entry === 'object' &&
                          'uri' in entry &&
                          typeof (entry as { uri: unknown }).uri === 'string' &&
                          isDefinitionMirrorUri((entry as { uri: string }).uri)
                  )
                : result !== null &&
                  typeof result === 'object' &&
                  'uri' in result &&
                  typeof (result as { uri: unknown }).uri === 'string' &&
                  isDefinitionMirrorUri((result as { uri: string }).uri)
            const presentation = hasMirrorPresentation ? ' presentation=mirror' : ''
            if (classification === null) {
                return `uri=${requestUri ?? '-'} definitions=${summarizeResultCount(result)}${presentation}`
            }
            const shape =
                Array.isArray(result) && result.some((entry) => entry !== null && typeof entry === 'object' && 'targetUri' in entry)
                    ? 'location-links'
                    : result !== null && typeof result === 'object' && 'targetUri' in result
                      ? 'location-link'
                      : Array.isArray(result)
                        ? 'locations'
                        : result === null || result === undefined
                          ? 'empty'
                          : 'location'
            return `uri=${requestUri} definitions=${classification.count} classification=${classification.kind} shape=${shape}${presentation}`
        }
        case 'textDocument/prepareCallHierarchy': {
            const items = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result]
            const firstName =
                items.length > 0 &&
                items[0] !== null &&
                typeof items[0] === 'object' &&
                'name' in items[0] &&
                typeof (items[0] as { name: unknown }).name === 'string'
                    ? ` item=${(items[0] as { name: string }).name}`
                    : ''
            return `uri=${requestUri ?? '-'} items=${items.length}${firstName}`
        }
        case 'callHierarchy/incomingCalls':
        case 'callHierarchy/outgoingCalls':
            return `uri=${requestUri ?? '-'} calls=${summarizeResultCount(result)}`
        case 'workspace/symbol':
            return `uri=${requestUri ?? '-'} symbols=${summarizeResultCount(result)}`
        default:
            return `uri=${requestUri ?? '-'} result=${summarizeResultCount(result)}`
    }
}

export function maybeLogVueTsWarmup(ctx: ProxyContext, method: string, requestUri: string | null, target: 'vtsls' | 'vue_ls'): void {
    if (ctx.loggedVueTsWarmup || target !== 'vtsls' || requestUri === null || !isVueUri(requestUri)) {
        return
    }
    if (ctx.initializeCompletedAt === 0) return
    const elapsedMs = Date.now() - ctx.initializeCompletedAt
    if (elapsedMs > VUE_TS_WARMUP_WINDOW_MS) return

    ctx.loggedVueTsWarmup = true
    logger.info(
        'proxy',
        `first .vue TS request (${method}) arrived ${elapsedMs}ms after initialize; vtsls may still be warming and library definitions can temporarily resolve empty/self`
    )
}

export function maybeRecoverVtslsAfterTimeout(ctx: ProxyContext, method: 'textDocument/definition' | 'textDocument/hover'): Promise<void> | null {
    if (!ctx.crashOptions?.spawnVtsls) {
        return null
    }

    if (ctx.vtslsRecoveryPromise !== null) {
        return ctx.vtslsRecoveryPromise
    }

    logger.warn('proxy', `vtsls ${method} timed out during a Vue request; recovering in background`)
    return ctx.recoverVtsls(`request timeout: ${method}`, true).catch((err: unknown) => {
        logger.error('proxy', `vtsls background recovery error: ${String(err)}`)
    })
}

export async function waitForActiveRecovery(ctx: ProxyContext, target: DownstreamTarget): Promise<void> {
    const recoveryPromise = target === 'vtsls' ? ctx.vtslsRecoveryPromise : ctx.vueLsRecoveryPromise
    if (recoveryPromise !== null) {
        await recoveryPromise
    }
}

export async function sendRequestWithTimeout(
    conn: MessageConnection,
    target: DownstreamTarget,
    method: string,
    params: unknown,
    timeoutMs: number
): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
        return await Promise.race([
            conn.sendRequest(method, params),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new DownstreamRequestTimeoutError(target, method, timeoutMs))
                }, timeoutMs)
            })
        ])
    } finally {
        if (timer !== null) {
            clearTimeout(timer)
        }
    }
}

export async function sendDownstreamRequest(
    ctx: ProxyContext,
    target: DownstreamTarget,
    method: string,
    params: unknown,
    options: DownstreamRequestOptions = {}
): Promise<unknown> {
    let attempt = 0
    const timeoutMs = options.timeoutMs ?? ctx.requestTimeoutMs
    const priority = options.priority ?? 'foreground'

    while (true) {
        await waitForActiveRecovery(ctx, target)
        const conn = target === 'vtsls' ? ctx.currentVtsls : ctx.currentVueLs
        const trackForegroundVtsls = target === 'vtsls' && priority === 'foreground'

        try {
            if (trackForegroundVtsls) {
                ctx.activeForegroundVtslsRequests += 1
            }
            return await sendRequestWithTimeout(conn, target, method, params, timeoutMs)
        } catch (err: unknown) {
            if (!(err instanceof DownstreamRequestTimeoutError)) {
                throw err
            }

            const canRecover = target === 'vtsls' ? ctx.crashOptions?.spawnVtsls !== undefined : ctx.crashOptions?.spawnVueLs !== undefined
            if (!canRecover || options.retryOnTimeout === false || attempt > 0) {
                throw err
            }

            logger.warn('proxy', `${target} ${method} timed out after ${timeoutMs}ms; restarting ${target}`)
            if (target === 'vtsls') {
                await ctx.recoverVtsls(`request timeout: ${method}`, true)
            } else {
                await ctx.recoverVueLs(`request timeout: ${method}`, true)
            }
            attempt += 1
        } finally {
            if (trackForegroundVtsls) {
                ctx.activeForegroundVtslsRequests = Math.max(0, ctx.activeForegroundVtslsRequests - 1)
            }
        }
    }
}

export async function waitForVtslsForegroundIdle(ctx: ProxyContext, maxWaitMs: number): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt <= maxWaitMs) {
        await waitForActiveRecovery(ctx, 'vtsls')
        if (ctx.vtslsRecoveryPromise === null && ctx.activeForegroundVtslsRequests === 0) {
            return true
        }
        await new Promise<void>((resolve) => setTimeout(resolve, VTSLS_BACKGROUND_IDLE_POLL_MS))
    }
    return false
}

export function enqueueVtslsBackgroundCommand(
    ctx: ProxyContext,
    reason: string,
    task: () => Promise<void>,
    maxIdleWaitMs = VTSLS_BACKGROUND_IDLE_MAX_WAIT_MS
): Promise<void> {
    const queuedTask = ctx.vtslsBackgroundQueue.then(async () => {
        const becameIdle = await waitForVtslsForegroundIdle(ctx, maxIdleWaitMs)
        if (!becameIdle) {
            logger.debug('proxy', `${reason} skipped reason=vtsls-busy active=${ctx.activeForegroundVtslsRequests}`)
            return
        }
        await task()
    })
    ctx.vtslsBackgroundQueue = queuedTask.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `${reason} ERROR: ${msg}`)
    })
    return queuedTask
}

export async function sendTsserverCommand(
    ctx: ProxyContext,
    command: string,
    args: unknown,
    reason: string,
    executeInfo?: TsserverRequestExecuteInfo,
    requestOptions?: DownstreamRequestOptions
): Promise<void> {
    try {
        await sendDownstreamRequest(ctx, 'vtsls', 'workspace/executeCommand', buildTsserverRequestCommand(command, args, executeInfo), requestOptions)
        logger.debug('proxy', `${reason} command=${command} args=${summarizePayload(args)}`)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `${reason} command=${command} ERROR: ${msg}`)
    }
}

export async function executeTsserverCommand(
    ctx: ProxyContext,
    command: string,
    args: unknown,
    reason: string,
    options: { background?: boolean; maxIdleWaitMs?: number } = {}
): Promise<void> {
    const run = async (): Promise<void> => {
        await sendTsserverCommand(
            ctx,
            command,
            args,
            reason,
            options.background ? { isAsync: true, lowPriority: true } : undefined,
            options.background
                ? {
                      priority: 'background',
                      retryOnTimeout: false,
                      timeoutMs: Math.min(ctx.requestTimeoutMs, VTSLS_BACKGROUND_REQUEST_TIMEOUT_MS)
                  }
                : undefined
        )
    }

    if (!options.background) {
        await run()
        return
    }

    await enqueueVtslsBackgroundCommand(ctx, reason, run, options.maxIdleWaitMs)
}
