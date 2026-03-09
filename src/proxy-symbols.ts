import { pathToFileURL } from 'node:url'
import type { ProxyContext } from './proxy-context.js'
import { DownstreamRequestTimeoutError, WORKSPACE_SYMBOL_CONTEXT_MAX_AGE_MS, WORKSPACE_SYMBOL_TIMEOUT_MS } from './proxy-types.js'
import { sendDownstreamRequest, summarizeResultCount } from './proxy-communication.js'
import { getWorkspaceRootPath, listWorkspaceSourceFiles, getDocumentText } from './proxy-workspace.js'
import { extractRequestPosition } from './proxy-references.js'
import { extractIdentifierAtPosition } from './helpers/identifiers.js'
import { isInternalProbeUri } from './helpers/probes.js'
import { collectWorkspaceSymbols, normalizeDocumentSymbolKinds } from './helpers/symbols.js'
import { isDefinitionMirrorUri } from './definition-mirrors.js'
import { routeRequest } from './router.js'
import * as logger from './logger.js'

export function rememberPositionContext(ctx: ProxyContext, requestUri: string | null, params: unknown): void {
    if (
        requestUri === null ||
        isInternalProbeUri(requestUri) ||
        isDefinitionMirrorUri(requestUri) ||
        (ctx.savedInitParams?.rootUri !== undefined && ctx.savedInitParams.rootUri !== null && !requestUri.startsWith(ctx.savedInitParams.rootUri))
    ) {
        return
    }

    const position = extractRequestPosition(params)
    if (position === null) {
        return
    }

    ctx.lastPositionContext = {
        uri: requestUri,
        position,
        capturedAt: Date.now()
    }
}

export function buildWorkspaceSymbolParams(ctx: ProxyContext, params: unknown): unknown {
    if (params === null || typeof params !== 'object' || !('query' in params) || typeof (params as { query: unknown }).query !== 'string') {
        return params
    }

    const query = (params as { query: string }).query
    if (query.trim().length > 0) {
        return params
    }

    if (ctx.lastPositionContext === null) {
        logger.debug('proxy', 'workspace/symbol empty query left unchanged reason=no-position-context')
        return params
    }

    const ageMs = Date.now() - ctx.lastPositionContext.capturedAt
    if (ageMs > WORKSPACE_SYMBOL_CONTEXT_MAX_AGE_MS) {
        logger.debug('proxy', `workspace/symbol empty query left unchanged reason=stale-context age=${ageMs}ms`)
        return params
    }

    const text = getDocumentText(ctx, ctx.lastPositionContext.uri)
    if (text === null) {
        logger.debug('proxy', `workspace/symbol empty query left unchanged reason=no-document-text uri=${ctx.lastPositionContext.uri}`)
        return params
    }

    const identifier = extractIdentifierAtPosition(text, ctx.lastPositionContext.position)
    if (identifier === null) {
        logger.debug(
            'proxy',
            `workspace/symbol empty query left unchanged reason=no-identifier uri=${ctx.lastPositionContext.uri} position=${ctx.lastPositionContext.position.line}:${ctx.lastPositionContext.position.character}`
        )
        return params
    }

    logger.debug(
        'proxy',
        `workspace/symbol synthesized query="${identifier}" uri=${ctx.lastPositionContext.uri} position=${ctx.lastPositionContext.position.line}:${ctx.lastPositionContext.position.character} age=${ageMs}ms`
    )
    return { ...(params as Record<string, unknown>), query: identifier }
}

export function buildLocalWorkspaceSymbolFallback(ctx: ProxyContext, params: unknown): unknown[] {
    if (params === null || typeof params !== 'object' || !('query' in params) || typeof (params as { query: unknown }).query !== 'string') {
        return []
    }

    const query = (params as { query: string }).query.trim()
    const workspaceRootPath = getWorkspaceRootPath(ctx)
    if (query.length === 0 || workspaceRootPath === null) {
        return []
    }

    const queryLower = query.toLowerCase()
    const matches = listWorkspaceSourceFiles(ctx, workspaceRootPath)
        .flatMap((filePath) => {
            const uri = pathToFileURL(filePath).href
            const text = getDocumentText(ctx, uri)
            if (text === null) {
                return []
            }
            return collectWorkspaceSymbols(text, uri).filter((symbol) => symbol.name.toLowerCase().includes(queryLower))
        })
        .sort((left, right) => {
            const leftName = left.name.toLowerCase()
            const rightName = right.name.toLowerCase()
            const leftRank = leftName === queryLower ? 0 : leftName.startsWith(queryLower) ? 1 : 2
            const rightRank = rightName === queryLower ? 0 : rightName.startsWith(queryLower) ? 1 : 2
            if (leftRank !== rightRank) {
                return leftRank - rightRank
            }
            if (left.name.length !== right.name.length) {
                return left.name.length - right.name.length
            }
            if (left.uri !== right.uri) {
                return left.uri.localeCompare(right.uri)
            }
            if (left.selectionRange.start.line !== right.selectionRange.start.line) {
                return left.selectionRange.start.line - right.selectionRange.start.line
            }
            return left.selectionRange.start.character - right.selectionRange.start.character
        })
        .slice(0, 100)

    logger.debug('proxy', `workspace/symbol local fallback query="${query}" results=${matches.length}`)

    return matches.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        location: {
            uri: symbol.uri,
            range: symbol.selectionRange
        },
        containerName: symbol.detail ?? ''
    }))
}

export async function requestWithWorkspaceSymbolFallback(ctx: ProxyContext, params: unknown): Promise<unknown> {
    const timeoutMs = Math.min(ctx.requestTimeoutMs, WORKSPACE_SYMBOL_TIMEOUT_MS)

    try {
        return await sendDownstreamRequest(ctx, 'vtsls', 'workspace/symbol', params, {
            retryOnTimeout: false,
            timeoutMs
        })
    } catch (err: unknown) {
        if (!(err instanceof DownstreamRequestTimeoutError)) {
            throw err
        }

        const fallback = buildLocalWorkspaceSymbolFallback(ctx, params)
        logger.warn('proxy', `workspace/symbol timed out after ${timeoutMs}ms; returning local fallback results=${summarizeResultCount(fallback)}`)
        return fallback
    }
}

export async function requestDocumentSymbols(ctx: ProxyContext, uri: string): Promise<unknown> {
    const params = { textDocument: { uri } }
    const target = routeRequest('textDocument/documentSymbol', params)
    const result = await sendDownstreamRequest(ctx, target, 'textDocument/documentSymbol', params)
    const text = getDocumentText(ctx, uri)
    if (text === null) {
        return result
    }
    return normalizeDocumentSymbolKinds(uri, text, result)
}
