import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { Position } from 'vscode-languageserver-protocol'
import type { ProxyContext } from './proxy-context.js'
import { VUE_HOVER_TIMEOUT_MS, VUE_LOADING_HOVER_RETRY_DELAY_MS, TS_EXECUTION_TARGET_SEMANTIC, DownstreamRequestTimeoutError } from './proxy-types.js'
import { isVueUri, hoverResultLooksLoading, uriToFilePath, isTsserverQuickInfoBodyLike, extractTsserverResponseBody, quickInfoToHover } from './proxy-utils.js'
import { sendDownstreamRequest, buildTsserverRequestCommand, maybeRecoverVtslsAfterTimeout } from './proxy-communication.js'
import { getDocumentText } from './proxy-workspace.js'
import { requestWithVueDefinitionRetry, buildNormalizedVueTemplateParams } from './proxy-definitions.js'
import { normalizeReferenceLocations, extractRequestPosition } from './proxy-references.js'
import { normalizeDefinitionResult, preferDefinitionResult } from './helpers/definitions.js'
import { hoverResultLooksAny } from './helpers/hover.js'
import { isVueTemplatePosition } from './helpers/vue-template.js'
import { routeRequest } from './router.js'
import * as logger from './logger.js'

export function getLineAtPosition(text: string, position: Position): string {
    const lines = text.split('\n')
    return lines[position.line] ?? ''
}

export function isMacroHoverFallbackCandidate(text: string, position: Position): boolean {
    const line = getLineAtPosition(text, position)
    return /\bdefine(?:Props|Emits|Slots|Model)\b|\bwithDefaults\b|\bstoreToRefs\s*\(/.test(line)
}

export function hoverNeedsFallback(result: unknown, treatAnyAsPoor: boolean): boolean {
    if (result === null) {
        return true
    }

    if (hoverResultLooksLoading(result)) {
        return true
    }

    return treatAnyAsPoor && hoverResultLooksAny(result)
}

export async function tryHoverRequest(
    ctx: ProxyContext,
    target: 'vtsls' | 'vue_ls',
    params: unknown,
    timeoutMs = Math.min(ctx.requestTimeoutMs, VUE_HOVER_TIMEOUT_MS)
): Promise<{ result: unknown; timedOut: boolean }> {
    try {
        const result = await sendDownstreamRequest(ctx, target, 'textDocument/hover', params, {
            retryOnTimeout: false,
            timeoutMs
        })
        return { result, timedOut: false }
    } catch (err: unknown) {
        if (err instanceof DownstreamRequestTimeoutError) {
            return { result: null, timedOut: true }
        }
        throw err
    }
}

export async function requestDefinitionBackedHoverFallback(ctx: ProxyContext, requestUri: string, params: unknown): Promise<unknown | null> {
    const definitionResult = normalizeDefinitionResult(await requestWithVueDefinitionRetry(ctx, ctx.currentVtsls, params, 'vtsls', requestUri))
    const preferred = preferDefinitionResult(requestUri, definitionResult, ctx.savedInitParams?.rootUri ?? null)
    const locations = normalizeReferenceLocations(Array.isArray(preferred) ? preferred : preferred === null ? [] : [preferred])

    for (const location of locations) {
        const hoverTarget = routeRequest('textDocument/hover', {
            textDocument: { uri: location.uri },
            position: location.range.start
        })
        const { result } = await tryHoverRequest(ctx, hoverTarget, {
            textDocument: { uri: location.uri },
            position: location.range.start
        })
        if (result !== null && !hoverResultLooksLoading(result) && !hoverResultLooksAny(result)) {
            logger.debug(
                'proxy',
                `textDocument/hover definition fallback uri=${requestUri} target=${location.uri}:${location.range.start.line}:${location.range.start.character}`
            )
            return result
        }
    }

    return null
}

export async function requestTsserverQuickInfoHoverFallback(ctx: ProxyContext, requestUri: string, params: unknown, reason: string): Promise<unknown | null> {
    const position = extractRequestPosition(params)
    const filePath = uriToFilePath(requestUri)
    if (position === null || filePath === null) {
        return null
    }

    try {
        const response = await sendDownstreamRequest(
            ctx,
            'vtsls',
            'workspace/executeCommand',
            buildTsserverRequestCommand(
                '_vue:quickinfo',
                {
                    file: filePath,
                    line: position.line + 1,
                    offset: position.character + 1
                },
                { executionTarget: TS_EXECUTION_TARGET_SEMANTIC }
            ),
            {
                retryOnTimeout: false,
                timeoutMs: Math.min(ctx.requestTimeoutMs, VUE_HOVER_TIMEOUT_MS)
            }
        )
        const body = extractTsserverResponseBody(response)
        if (!isTsserverQuickInfoBodyLike(body)) {
            logger.debug('proxy', `textDocument/hover quickinfo fallback uri=${requestUri} reason=${reason} result=0`)
            return null
        }

        logger.debug('proxy', `textDocument/hover quickinfo fallback uri=${requestUri} reason=${reason} display=${body.displayString}`)
        return quickInfoToHover(body)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `textDocument/hover quickinfo fallback ${requestUri} ERROR: ${msg}`)
        return null
    }
}

export async function requestWithVueHoverRetry(
    ctx: ProxyContext,
    _conn: MessageConnection,
    params: unknown,
    target: 'vtsls' | 'vue_ls',
    requestUri: string | null
): Promise<unknown> {
    if (target !== 'vtsls' || requestUri === null || !isVueUri(requestUri)) {
        return sendDownstreamRequest(ctx, target, 'textDocument/hover', params)
    }

    const text = getDocumentText(ctx, requestUri)
    const position = extractRequestPosition(params)
    const isTemplateHover = text !== null && position !== null && isVueTemplatePosition(text, position)
    const isMacroHover = text !== null && position !== null && !isTemplateHover && isMacroHoverFallbackCandidate(text, position)
    const normalizedTemplateParams = buildNormalizedVueTemplateParams(ctx, requestUri, params)
    const treatAnyAsPoor = isTemplateHover || isMacroHover
    const shouldRecoverPoorScriptHover = !isTemplateHover && !isMacroHover

    const initialAttempt = await tryHoverRequest(ctx, 'vtsls', params)
    if (initialAttempt.timedOut) {
        logger.warn(
            'proxy',
            `textDocument/hover initial timeout uri=${requestUri} fallback=${isTemplateHover || isMacroHover || initialAttempt.timedOut ? 'enabled' : 'disabled'}`
        )
        maybeRecoverVtslsAfterTimeout(ctx, 'textDocument/hover')
    }

    let bestResult = initialAttempt.result
    let retryParams = params
    if (normalizedTemplateParams !== null && hoverNeedsFallback(bestResult, true)) {
        const normalizedAttempt = await tryHoverRequest(ctx, 'vtsls', normalizedTemplateParams.params)
        const normalizedResult = normalizedAttempt.result
        logger.debug(
            'proxy',
            `textDocument/hover template-normalized uri=${requestUri} position=${normalizedTemplateParams.normalizedPosition.line}:${normalizedTemplateParams.normalizedPosition.character} result=${normalizedResult === null ? 0 : 1}`
        )
        if (normalizedResult !== null) {
            bestResult = normalizedResult
            retryParams = normalizedTemplateParams.params
        }
    }

    if (!hoverNeedsFallback(bestResult, treatAnyAsPoor) && !(shouldRecoverPoorScriptHover && hoverResultLooksAny(bestResult))) {
        return bestResult
    }

    let retryResult: unknown = null
    if (bestResult !== null && hoverResultLooksLoading(bestResult)) {
        logger.debug('proxy', `textDocument/hover loading retry uri=${requestUri} delay=${VUE_LOADING_HOVER_RETRY_DELAY_MS}ms`)
        await new Promise<void>((resolve) => setTimeout(resolve, VUE_LOADING_HOVER_RETRY_DELAY_MS))
        const retryAttempt = await tryHoverRequest(ctx, 'vtsls', retryParams)
        retryResult = retryAttempt.result
        logger.debug('proxy', `textDocument/hover loading retry uri=${requestUri} result=${retryResult === null ? 0 : 1}`)
        if (!hoverNeedsFallback(retryResult, treatAnyAsPoor) && !(shouldRecoverPoorScriptHover && hoverResultLooksAny(retryResult))) {
            return retryResult
        }
        if (retryResult !== null) {
            bestResult = retryResult
        }
    }

    if (isTemplateHover || isMacroHover || initialAttempt.timedOut) {
        const vueParams = normalizedTemplateParams?.params ?? params
        const vueAttempt = await tryHoverRequest(ctx, 'vue_ls', vueParams)
        if (vueAttempt.timedOut) {
            logger.warn(
                'proxy',
                `textDocument/hover vue_ls timeout uri=${requestUri} template=${isTemplateHover} macro=${isMacroHover} initialTimeout=${initialAttempt.timedOut}`
            )
        } else {
            logger.debug(
                'proxy',
                `textDocument/hover vue_ls fallback uri=${requestUri} template=${isTemplateHover} macro=${isMacroHover} initialTimeout=${initialAttempt.timedOut} result=${vueAttempt.result === null ? 0 : 1}`
            )
        }
        const acceptVueFallback =
            initialAttempt.timedOut && !isTemplateHover && !isMacroHover
                ? vueAttempt.result !== null && !hoverResultLooksLoading(vueAttempt.result)
                : !hoverNeedsFallback(vueAttempt.result, treatAnyAsPoor)
        if (acceptVueFallback) {
            return vueAttempt.result
        }
        if (vueAttempt.result !== null) {
            bestResult = vueAttempt.result
        }
    }

    const quickInfoReason =
        initialAttempt.timedOut && !isTemplateHover
            ? isMacroHover
                ? 'macro-timeout'
                : 'script-timeout'
            : shouldRecoverPoorScriptHover && hoverResultLooksAny(bestResult)
              ? 'script-any'
              : shouldRecoverPoorScriptHover && hoverResultLooksLoading(bestResult)
                ? 'script-loading'
                : null

    if (quickInfoReason !== null) {
        const quickInfoFallback = await requestTsserverQuickInfoHoverFallback(ctx, requestUri, params, quickInfoReason)
        if (quickInfoFallback !== null) {
            return quickInfoFallback
        }
    }

    if (isTemplateHover || isMacroHover || initialAttempt.timedOut) {
        const definitionFallback = await requestDefinitionBackedHoverFallback(ctx, requestUri, params)
        if (definitionFallback !== null) {
            return definitionFallback
        }
    }

    return retryResult ?? bestResult
}
