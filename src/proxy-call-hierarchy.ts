import type { Range } from 'vscode-languageserver-protocol'
import type { ProxyContext } from './proxy-context.js'
import type { CallHierarchyItemLike } from './proxy-types.js'
import {
    isVueUri,
    isLocation,
    isCallHierarchyItem,
    basenameFromUri,
    languageIdForUri,
    buildSyntheticItem,
    itemKey,
    mergeIncomingCallResults
} from './proxy-utils.js'
import { sendDownstreamRequest, summarizeResultCount } from './proxy-communication.js'
import { getDocumentText } from './proxy-workspace.js'
import { requestWithReferenceFallback, extractRequestPosition } from './proxy-references.js'
import { requestDocumentSymbols } from './proxy-symbols.js'
import { extractIdentifierAtPosition } from './helpers/identifiers.js'
import { isInternalProbeUri } from './helpers/probes.js'
import { normalizeDefinitionResult, preferDefinitionResult } from './helpers/definitions.js'
import { findBestSymbolAtPosition, findSymbolByName, findScriptSymbolByName } from './helpers/symbols.js'
import { extractVueOutgoingCalls } from './helpers/vue-template.js'
import * as logger from './logger.js'

export function toCallHierarchyItem(symbol: {
    uri: string
    name: string
    kind: number
    range: Range
    selectionRange: Range
    detail?: string
}): CallHierarchyItemLike {
    return {
        uri: symbol.uri,
        name: symbol.name,
        kind: symbol.kind,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
        detail: symbol.detail ?? ''
    }
}

export async function requestWithPrepareCallHierarchyFallback(
    ctx: ProxyContext,
    params: unknown,
    target: 'vtsls' | 'vue_ls',
    requestUri: string | null
): Promise<unknown> {
    const initialResult = await sendDownstreamRequest(ctx, target, 'textDocument/prepareCallHierarchy', params)
    if (target !== 'vtsls' || requestUri === null || !isVueUri(requestUri) || summarizeResultCount(initialResult) > 0) {
        return initialResult
    }

    const position = extractRequestPosition(params)
    if (position === null) {
        return initialResult
    }

    const requestText = getDocumentText(ctx, requestUri)
    const symbolName = requestText === null ? null : extractIdentifierAtPosition(requestText, position)
    const definitionResult = normalizeDefinitionResult(await sendDownstreamRequest(ctx, 'vtsls', 'textDocument/definition', params))
    const preferredDefinition = preferDefinitionResult(requestUri, definitionResult, ctx.savedInitParams?.rootUri ?? null)
    const locations = (Array.isArray(preferredDefinition) ? preferredDefinition : [preferredDefinition])
        .filter(isLocation)
        .filter((location) => !isInternalProbeUri(location.uri))

    for (const location of locations) {
        const targetText = getDocumentText(ctx, location.uri)
        const symbols = await requestDocumentSymbols(ctx, location.uri)
        const symbol =
            (symbolName === null || targetText === null ? null : findScriptSymbolByName(targetText, symbolName, location.uri)) ??
            (symbolName === null ? null : findSymbolByName(symbols, symbolName, location.uri)) ??
            findBestSymbolAtPosition(symbols, location.range.start, location.uri)
        if (symbol === null) {
            continue
        }

        const temporarilyOpened = ctx.documentStore.get(symbol.uri) === undefined && targetText !== null
        if (temporarilyOpened) {
            ctx.currentVtsls.sendNotification('textDocument/didOpen', {
                textDocument: {
                    uri: symbol.uri,
                    languageId: languageIdForUri(symbol.uri),
                    version: 1,
                    text: targetText
                }
            })
            logger.debug('proxy', `textDocument/prepareCallHierarchy fallback opened target uri=${symbol.uri}`)
        }

        try {
            const prepared = await sendDownstreamRequest(ctx, 'vtsls', 'textDocument/prepareCallHierarchy', {
                textDocument: { uri: symbol.uri },
                position: symbol.selectionRange.start
            })
            if (summarizeResultCount(prepared) > 0) {
                logger.debug(
                    'proxy',
                    `textDocument/prepareCallHierarchy fallback uri=${requestUri} symbol=${symbol.name} target=${symbol.uri}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character} result=${summarizeResultCount(prepared)}`
                )
                return prepared
            }
        } finally {
            if (temporarilyOpened) {
                ctx.currentVtsls.sendNotification('textDocument/didClose', {
                    textDocument: { uri: symbol.uri }
                })
            }
        }

        const synthetic = toCallHierarchyItem(symbol)
        logger.debug(
            'proxy',
            `textDocument/prepareCallHierarchy fallback uri=${requestUri} symbol=${symbol.name} target=${symbol.uri}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character} result=synthetic`
        )
        return [synthetic]
    }

    logger.debug('proxy', `textDocument/prepareCallHierarchy fallback uri=${requestUri} symbol=${symbolName ?? '-'} result=0`)
    return initialResult
}

export async function buildIncomingCallFallback(ctx: ProxyContext, params: unknown, includeSameFileReferences: boolean): Promise<unknown[]> {
    if (params === null || typeof params !== 'object' || !('item' in params) || !isCallHierarchyItem((params as { item: unknown }).item)) {
        return []
    }

    const item = (params as { item: CallHierarchyItemLike }).item
    const references = await requestWithReferenceFallback(
        ctx,
        {
            textDocument: { uri: item.uri },
            position: item.selectionRange.start,
            context: { includeDeclaration: false }
        },
        'vtsls',
        item.uri
    )
    const locations = (Array.isArray(references) ? references.filter(isLocation).filter((location) => !isInternalProbeUri(location.uri)) : []).filter(
        (location) => includeSameFileReferences || location.uri !== item.uri
    )
    const grouped = new Map<string, { from: CallHierarchyItemLike; fromSpans: Range[] }>()

    for (const location of locations) {
        let from = buildSyntheticItem(location.uri, basenameFromUri(location.uri), 2, location.range)

        try {
            const symbols = await requestDocumentSymbols(ctx, location.uri)
            const match = findBestSymbolAtPosition(symbols, location.range.start, location.uri)
            if (match !== null) {
                from = toCallHierarchyItem(match)
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.debug('proxy', `callHierarchy/incomingCalls fallback symbols uri=${location.uri} ERROR: ${msg}`)
        }

        const key = itemKey(from)
        const existing = grouped.get(key) ?? { from, fromSpans: [] }
        existing.fromSpans.push(location.range)
        grouped.set(key, existing)
    }

    logger.debug('proxy', `callHierarchy/incomingCalls fallback uri=${item.uri} references=${locations.length} calls=${grouped.size}`)
    return Array.from(grouped.values())
}

export async function buildOutgoingCallFallback(ctx: ProxyContext, params: unknown): Promise<unknown[]> {
    if (params === null || typeof params !== 'object' || !('item' in params) || !isCallHierarchyItem((params as { item: unknown }).item)) {
        return []
    }

    const item = (params as { item: CallHierarchyItemLike }).item
    const text = getDocumentText(ctx, item.uri)
    if (text === null) {
        return []
    }

    const calls = extractVueOutgoingCalls(text, item.selectionRange.start)
    if (calls.length === 0) {
        logger.debug('proxy', `callHierarchy/outgoingCalls fallback uri=${item.uri} calls=0 reason=no-script-calls`)
        return []
    }

    let symbols: unknown = null
    try {
        symbols = await requestDocumentSymbols(ctx, item.uri)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.debug('proxy', `callHierarchy/outgoingCalls fallback symbols uri=${item.uri} ERROR: ${msg}`)
    }

    const grouped = new Map<string, { to: CallHierarchyItemLike; fromSpans: Range[] }>()
    for (const call of calls) {
        const symbol = symbols === null ? null : findSymbolByName(symbols, call.name, item.uri)
        const to = symbol !== null ? toCallHierarchyItem(symbol) : buildSyntheticItem(item.uri, call.name, 12, call.range)
        const key = itemKey(to)
        const existing = grouped.get(key) ?? { to, fromSpans: [] }
        existing.fromSpans.push(call.range)
        grouped.set(key, existing)
    }

    logger.debug('proxy', `callHierarchy/outgoingCalls fallback uri=${item.uri} calls=${grouped.size} targets=${calls.map((call) => call.name).join(',')}`)
    return Array.from(grouped.values())
}

export async function requestWithCallHierarchyFallback(
    ctx: ProxyContext,
    method: 'callHierarchy/incomingCalls' | 'callHierarchy/outgoingCalls',
    params: unknown,
    target: 'vtsls' | 'vue_ls',
    requestUri: string | null
): Promise<unknown> {
    const initialResult = await sendDownstreamRequest(ctx, target, method, params)
    if (target !== 'vtsls' || requestUri === null) {
        return initialResult
    }

    if (method === 'callHierarchy/incomingCalls') {
        const fallback = await buildIncomingCallFallback(ctx, params, summarizeResultCount(initialResult) === 0)
        return fallback.length > 0 ? mergeIncomingCallResults(initialResult, fallback) : initialResult
    }

    if (!isVueUri(requestUri) || summarizeResultCount(initialResult) > 0) {
        return initialResult
    }

    const fallback = await buildOutgoingCallFallback(ctx, params)
    return fallback.length > 0 ? fallback : initialResult
}
