import fs from 'node:fs'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { ProxyContext } from './proxy-context.js'
import type { ContentChange } from './proxy-types.js'
import { computeDocumentEnd } from './documents.js'
import {
    isVueUri,
    isScriptLikeUri,
    languageIdForUri,
    summarizePayload,
    buildVtslsSettings,
    buildVueLsSettings,
    patchFullDocReplacements,
    uriToFilePath
} from './proxy-utils.js'
import {
    sendDownstreamRequest,
    safeSendNotification,
    buildTsserverRequestCommand,
    logDiagnostics,
    summarizeResultCount,
    summarizeMethodResult,
    maybeLogVueTsWarmup
} from './proxy-communication.js'
import { getDocumentText, invalidateWorkspaceCachesForUri } from './proxy-workspace.js'
import {
    forwardDiagnosticsUpstream,
    resolveDiagnosticsVersion,
    scheduleVueDiagnosticsNudge,
    scheduleScriptDiagnosticsNudge,
    scheduleScriptDependentDiagnosticsNudge,
    clearDiagnosticNudgesForUri
} from './proxy-diagnostics.js'
import { requestWithVueDefinitionRetry, maybePrimeDocument } from './proxy-definitions.js'
import { requestWithVueHoverRetry } from './proxy-hover.js'
import { requestWithReferenceFallback } from './proxy-references.js'
import { requestWithWorkspaceSymbolFallback, buildWorkspaceSymbolParams, rememberPositionContext } from './proxy-symbols.js'
import { requestWithPrepareCallHierarchyFallback, requestWithCallHierarchyFallback } from './proxy-call-hierarchy.js'
import { extractRequestUri } from './helpers/identifiers.js'
import { isInternalProbeUri } from './helpers/probes.js'
import { isDefinitionMirrorUri } from './definition-mirrors.js'
import { normalizeDocumentSymbolKinds } from './helpers/symbols.js'
import { extractTsserverRequestId, parseTsserverRequest, summarizeBridgeResponseBody } from './helpers/tsserver.js'
import { routeRequest } from './router.js'
import { diagnosticKey, type Diagnostic } from './diagnostics.js'
import * as logger from './logger.js'

function setupDownstreamHandlers(ctx: ProxyContext, conn: MessageConnection, server: 'vtsls' | 'vue_ls'): void {
    conn.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
        const p = params as { uri: string; diagnostics: Diagnostic[]; version?: unknown }
        if (isInternalProbeUri(p.uri)) {
            logger.debug('proxy', `publishDiagnostics ignored internal probe uri=${p.uri} count=${p.diagnostics.length}`)
            return
        }
        if (server === 'vtsls') {
            ctx.lastVtslsDiagnosticsAt.set(p.uri, Date.now())
        }
        const version = resolveDiagnosticsVersion(ctx, p.uri, p.version)
        if (isVueUri(p.uri)) {
            const merged = ctx.diagnosticsStore.update(p.uri, server, p.diagnostics)
            logDiagnostics(server, p.uri, p.diagnostics.length, merged.length)
            forwardDiagnosticsUpstream(ctx, p.uri, merged, version)
        } else {
            logDiagnostics(server, p.uri, p.diagnostics.length)
            forwardDiagnosticsUpstream(ctx, p.uri, p.diagnostics, version)
        }
    })
    conn.onNotification('window/logMessage', (params: unknown) => {
        const p = params as { type: number; message: string }
        logger.debug(server, p.message)
        safeSendNotification(ctx.upstream, 'window/logMessage', {
            type: p.type,
            message: `[${server}] ${p.message}`
        })
    })
    setupConfigHandler(ctx, conn, server)
}

export function setupVtslsHandlers(ctx: ProxyContext, conn: MessageConnection): void {
    setupDownstreamHandlers(ctx, conn, 'vtsls')
}

export function setupVueLsHandlers(ctx: ProxyContext, conn: MessageConnection): void {
    setupDownstreamHandlers(ctx, conn, 'vue_ls')
}

export function setupConfigHandler(ctx: ProxyContext, conn: MessageConnection, serverName: string): void {
    conn.onRequest('workspace/configuration', (params: unknown) => {
        const p = params as { items: Array<{ section?: string }> }
        logger.debug('proxy', `workspace/configuration from ${serverName}: ${JSON.stringify(p.items)}`)
        const settings = serverName === 'vtsls' ? buildVtslsSettings(ctx.savedVueTypescriptPluginLocation!) : buildVueLsSettings()
        return p.items.map((item) => {
            if (!item.section) return settings
            const parts = item.section.split('.')
            let value: unknown = settings
            for (const part of parts) {
                if (value !== null && typeof value === 'object' && part in value) {
                    value = (value as Record<string, unknown>)[part]
                } else {
                    value = undefined
                    break
                }
            }
            return value ?? null
        })
    })
}

export function setupTsserverRequestHandler(ctx: ProxyContext, conn: MessageConnection): void {
    const sendTsserverResponse = (id: number, body: unknown): void => {
        safeSendNotification(conn, 'tsserver/response', [id, body], `tsserver/response #${id}`)
    }

    conn.onNotification('tsserver/request', (params: unknown) => {
        const parsed = parseTsserverRequest(params)
        if (parsed === null) {
            logger.warn('proxy', `tsserver/request invalid payload: ${summarizePayload(params)}`)
            const id = extractTsserverRequestId(params)
            if (id !== null) {
                sendTsserverResponse(id, null)
            }
            return
        }

        const { id, command, args, shape } = parsed
        const startedAt = Date.now()
        logger.debug('proxy', `tsserver/request #${id} ${command} shape=${shape} args=${summarizePayload(args)}`)
        sendDownstreamRequest(ctx, 'vtsls', 'workspace/executeCommand', buildTsserverRequestCommand(command, args))
            .then((response: unknown) => {
                const body =
                    response !== null && response !== undefined && typeof response === 'object' && 'body' in response
                        ? (response as { body: unknown }).body
                        : null
                logger.debug('proxy', `tsserver/response #${id} ${command} ${Date.now() - startedAt}ms body=${summarizeBridgeResponseBody(body)}`)
                sendTsserverResponse(id, body)
            })
            .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                logger.warn('proxy', `tsserver/request #${id} ${command} ERROR: ${msg}`)
                sendTsserverResponse(id, null)
            })
    })
}

/** Sends didOpen to the servers responsible for the document and records it in the store. */
export function openDocumentOnServers(ctx: ProxyContext, uri: string, languageId: string, version: number, text: string): void {
    ctx.documentStore.open(uri, languageId, version, text)
    invalidateWorkspaceCachesForUri(ctx, uri)
    const params = { textDocument: { uri, languageId, version, text } }
    safeSendNotification(ctx.currentVtsls, 'textDocument/didOpen', params)
    if (isVueUri(uri)) {
        safeSendNotification(ctx.currentVueLs, 'textDocument/didOpen', params)
        scheduleVueDiagnosticsNudge(ctx, uri)
    }
    maybePrimeDocument(ctx, uri)
}

/** Claude Code sends a single rangeless full-document change; anything else is not healable. */
function extractFullTextChange(changes: ContentChange[]): string | null {
    if (changes.length === 0) {
        return null
    }
    const last = changes[changes.length - 1]!
    return last.range === undefined ? last.text : null
}

// Matches the 10MB cap Claude Code applies when it reads a file for didOpen.
const MAX_SELF_HEAL_DOCUMENT_BYTES = 10_000_000

/**
 * Claude Code does not replay didOpen after it restarts a crashed LSP server — its
 * open-file map survives the restart, so requests and didChange notifications arrive
 * for documents the child servers have never seen. Recover by opening the document
 * from disk (the client saves after every edit, so disk content is current).
 */
export function ensureRequestDocumentOpen(ctx: ProxyContext, uri: string | null): void {
    if (uri === null || ctx.documentStore.get(uri) !== undefined) {
        return
    }
    if (isInternalProbeUri(uri) || isDefinitionMirrorUri(uri) || !(isVueUri(uri) || isScriptLikeUri(uri))) {
        return
    }
    const filePath = uriToFilePath(uri)
    if (filePath === null) {
        return
    }

    let text: string
    try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile() || stat.size > MAX_SELF_HEAL_DOCUMENT_BYTES) {
            return
        }
        text = fs.readFileSync(filePath, 'utf8')
    } catch {
        return
    }

    logger.warn('proxy', `request for unopened document ${uri} — opening from disk (client restarted the proxy without replaying open files?)`)
    openDocumentOnServers(ctx, uri, languageIdForUri(uri), 1, text)
}

export function setupDocumentLifecycleHandlers(ctx: ProxyContext): void {
    ctx.upstream.onNotification('textDocument/didOpen', (params: unknown) => {
        const didOpenParams = params as {
            textDocument: {
                uri: string
                languageId: string
                version: number
                text: string
            }
        }
        const { uri, languageId, version, text } = didOpenParams.textDocument
        invalidateWorkspaceCachesForUri(ctx, uri)

        const existing = ctx.documentStore.get(uri)
        if (existing !== undefined) {
            // The child servers already have this document open; a second didOpen is a
            // protocol violation. Re-sync content as a full-document replacement instead,
            // re-using the incoming version so numbering realigns with the client.
            logger.warn('proxy', `textDocument/didOpen ${uri} for already-open document — forwarding as full-document didChange`)
            const changeParams = {
                textDocument: { uri, version },
                contentChanges: [
                    {
                        range: { start: { line: 0, character: 0 }, end: computeDocumentEnd(existing.content) },
                        text
                    }
                ]
            }
            ctx.documentStore.open(uri, languageId, version, text)
            safeSendNotification(ctx.currentVtsls, 'textDocument/didChange', changeParams)
            if (isVueUri(uri)) {
                safeSendNotification(ctx.currentVueLs, 'textDocument/didChange', changeParams)
                scheduleVueDiagnosticsNudge(ctx, uri)
            } else if (isScriptLikeUri(uri)) {
                scheduleScriptDiagnosticsNudge(ctx, uri)
            }
            return
        }

        ctx.documentStore.open(uri, languageId, version, text)
        const target = isVueUri(uri) ? 'vtsls+vue_ls' : 'vtsls'
        logger.info('proxy', `textDocument/didOpen ${uri} → ${target}`)
        logger.debug('proxy', `textDocument/didOpen payload: ${summarizePayload(params)}`)
        safeSendNotification(ctx.currentVtsls, 'textDocument/didOpen', params)
        if (isVueUri(uri)) {
            safeSendNotification(ctx.currentVueLs, 'textDocument/didOpen', params)
            scheduleVueDiagnosticsNudge(ctx, uri)
        }
        maybePrimeDocument(ctx, uri)
    })

    ctx.upstream.onNotification('textDocument/didChange', (params: unknown) => {
        const didChangeParams = params as {
            textDocument: { uri: string; version: number }
            contentChanges: ContentChange[]
        }
        const { uri, version } = didChangeParams.textDocument
        invalidateWorkspaceCachesForUri(ctx, uri)
        const documentBeforeChange = ctx.documentStore.get(uri)

        if (documentBeforeChange === undefined) {
            const fullText = extractFullTextChange(didChangeParams.contentChanges)
            if (fullText !== null) {
                // Claude Code does not replay didOpen after restarting the proxy, so the
                // first edit after a restart arrives as didChange for a document the child
                // servers never opened. The change carries the full text — open with it.
                logger.warn('proxy', `textDocument/didChange ${uri} v${version} for unopened document — synthesizing didOpen`)
                openDocumentOnServers(ctx, uri, languageIdForUri(uri), version, fullText)
                if (!isVueUri(uri) && isScriptLikeUri(uri)) {
                    scheduleScriptDiagnosticsNudge(ctx, uri)
                    scheduleScriptDependentDiagnosticsNudge(ctx, uri, null, didChangeParams.contentChanges)
                }
                return
            }
            logger.warn('proxy', `textDocument/didChange ${uri} v${version} for unopened document with ranged changes — forwarding as-is`)
        }

        let forwardedChangeParams: unknown = params
        if (documentBeforeChange !== undefined) {
            const patchedChanges = patchFullDocReplacements(didChangeParams.contentChanges, documentBeforeChange.content)
            if (patchedChanges !== didChangeParams.contentChanges) {
                forwardedChangeParams = {
                    textDocument: didChangeParams.textDocument,
                    contentChanges: patchedChanges
                }
                logger.debug('proxy', `textDocument/didChange ${uri} v${version}: patched full-doc replacement`)
            }
        }

        ctx.documentStore.change(uri, version, didChangeParams.contentChanges)

        logger.debug('proxy', `textDocument/didChange ${uri} v${version}`)
        safeSendNotification(ctx.currentVtsls, 'textDocument/didChange', forwardedChangeParams)
        if (isVueUri(uri)) {
            safeSendNotification(ctx.currentVueLs, 'textDocument/didChange', forwardedChangeParams)
            scheduleVueDiagnosticsNudge(ctx, uri)
        } else if (isScriptLikeUri(uri)) {
            scheduleScriptDiagnosticsNudge(ctx, uri)
            scheduleScriptDependentDiagnosticsNudge(ctx, uri, documentBeforeChange?.content ?? null, didChangeParams.contentChanges)
        }
    })

    ctx.upstream.onNotification('textDocument/didClose', (params: unknown) => {
        const didCloseParams = params as { textDocument: { uri: string } }
        const { uri } = didCloseParams.textDocument
        ctx.documentStore.close(uri)
        invalidateWorkspaceCachesForUri(ctx, uri)
        ctx.diagnosticsStore.remove(uri)
        ctx.lastVtslsDiagnosticsAt.delete(uri)
        clearDiagnosticNudgesForUri(ctx, uri)
        safeSendNotification(ctx.currentVtsls, 'textDocument/didClose', params)
        if (isVueUri(uri)) {
            safeSendNotification(ctx.currentVueLs, 'textDocument/didClose', params)
        }
    })

    ctx.upstream.onNotification('textDocument/didSave', (params: unknown) => {
        const didSaveParams = params as { textDocument: { uri: string } }
        const { uri } = didSaveParams.textDocument
        // Disk content changed; any cached disk read for this URI is stale.
        invalidateWorkspaceCachesForUri(ctx, uri)
        safeSendNotification(ctx.currentVtsls, 'textDocument/didSave', params)
        if (isVueUri(uri)) {
            safeSendNotification(ctx.currentVueLs, 'textDocument/didSave', params)
        }
    })
}

export function forwardRequest(ctx: ProxyContext, method: string): void {
    ctx.upstream.onRequest(method, async (params: unknown) => {
        const requestUri = extractRequestUri(params)
        ensureRequestDocumentOpen(ctx, requestUri)
        rememberPositionContext(ctx, requestUri, params)
        const forwardedParams = method === 'workspace/symbol' ? buildWorkspaceSymbolParams(ctx, params) : params
        const target = routeRequest(method, params)
        const conn = target === 'vtsls' ? ctx.currentVtsls : ctx.currentVueLs
        const startedAt = Date.now()
        maybeLogVueTsWarmup(ctx, method, requestUri, target)
        logger.debug('proxy', `${method} → ${target} uri=${requestUri ?? '-'} payload=${summarizePayload(forwardedParams)}`)
        try {
            let result: unknown
            if (method === 'textDocument/definition') {
                result = await requestWithVueDefinitionRetry(ctx, conn, forwardedParams, target, requestUri)
            } else if (method === 'textDocument/hover') {
                result = await requestWithVueHoverRetry(ctx, conn, forwardedParams, target, requestUri)
            } else if (method === 'textDocument/references') {
                result = await requestWithReferenceFallback(ctx, forwardedParams, target, requestUri)
            } else if (method === 'textDocument/prepareCallHierarchy') {
                result = await requestWithPrepareCallHierarchyFallback(ctx, forwardedParams, target, requestUri)
            } else if (method === 'callHierarchy/incomingCalls' || method === 'callHierarchy/outgoingCalls') {
                result = await requestWithCallHierarchyFallback(ctx, method, forwardedParams, target, requestUri)
            } else if (method === 'workspace/symbol') {
                result = await requestWithWorkspaceSymbolFallback(ctx, forwardedParams)
            } else {
                result = await sendDownstreamRequest(ctx, target, method, forwardedParams)
            }
            if (method === 'textDocument/documentSymbol' && requestUri !== null) {
                const text = getDocumentText(ctx, requestUri)
                if (text !== null) {
                    result = normalizeDocumentSymbolKinds(requestUri, text, result)
                }
            }
            logger.debug('proxy', `${method} ← ${target} OK ${Date.now() - startedAt}ms ${summarizeMethodResult(ctx, method, requestUri, result)}`)
            if (
                method === 'textDocument/documentSymbol' &&
                target === 'vue_ls' &&
                requestUri !== null &&
                isVueUri(requestUri) &&
                summarizeResultCount(result) === 0
            ) {
                logger.warn('proxy', `textDocument/documentSymbol ${requestUri} via vue_ls returned no symbols`)
            }
            return result
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn('proxy', `${method} ← ${target} ERROR ${Date.now() - startedAt}ms uri=${requestUri ?? '-'}: ${msg}`)
            throw err
        }
    })
}

export function setupPullDiagnosticHandler(ctx: ProxyContext): void {
    ctx.upstream.onRequest('textDocument/diagnostic', async (params: unknown) => {
        const uri = extractDiagnosticUri(params)
        if (uri === null || (!isVueUri(uri) && !isScriptLikeUri(uri))) {
            return { kind: 'full', items: [] }
        }
        ensureRequestDocumentOpen(ctx, uri)

        const file = uriToFilePath(uri)
        if (file === null) {
            return { kind: 'full', items: [] }
        }

        const [syntactic, semantic] = await Promise.all([
            requestTsserverDiagnostics(ctx, 'syntacticDiagnosticsSync', file),
            requestTsserverDiagnostics(ctx, 'semanticDiagnosticsSync', file)
        ])
        const items = dedupeDiagnostics([...syntactic, ...semantic])
        if (isVueUri(uri)) {
            ctx.lastVtslsDiagnosticsAt.set(uri, Date.now())
            // The tsserver sync commands only cover the vtsls side; fold in the latest
            // vue_ls push diagnostics so the pull response matches the merged push view.
            const merged = ctx.diagnosticsStore.update(uri, 'vtsls', items)
            return { kind: 'full', items: merged }
        }
        return { kind: 'full', items }
    })
}

function extractDiagnosticUri(params: unknown): string | null {
    if (params === null || typeof params !== 'object' || !('textDocument' in params)) {
        return null
    }
    const textDocument = (params as { textDocument?: unknown }).textDocument
    if (textDocument === null || typeof textDocument !== 'object' || !('uri' in textDocument)) {
        return null
    }
    const uri = (textDocument as { uri?: unknown }).uri
    return typeof uri === 'string' ? uri : null
}

async function requestTsserverDiagnostics(ctx: ProxyContext, command: string, file: string): Promise<Diagnostic[]> {
    try {
        const response = await sendDownstreamRequest(ctx, 'vtsls', 'workspace/executeCommand', buildTsserverRequestCommand(command, { file }))
        const body =
            response !== null && response !== undefined && typeof response === 'object' && 'body' in response
                ? (response as { body?: unknown }).body
                : undefined
        if (!Array.isArray(body)) {
            return []
        }
        return body.flatMap((diagnostic) => normalizeTsserverDiagnostic(diagnostic))
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `textDocument/diagnostic ${command} file=${file} ERROR: ${msg}`)
        return []
    }
}

function normalizeTsserverDiagnostic(value: unknown): Diagnostic[] {
    if (value === null || typeof value !== 'object') {
        return []
    }
    const diagnostic = value as {
        start?: { line?: unknown; offset?: unknown }
        end?: { line?: unknown; offset?: unknown }
        text?: unknown
        messageText?: unknown
        code?: unknown
        category?: unknown
    }
    if (
        typeof diagnostic.start?.line !== 'number' ||
        typeof diagnostic.start.offset !== 'number' ||
        typeof diagnostic.end?.line !== 'number' ||
        typeof diagnostic.end.offset !== 'number'
    ) {
        return []
    }
    const message = diagnosticMessage(diagnostic.text ?? diagnostic.messageText)
    if (message.length === 0) {
        return []
    }
    const result: Diagnostic = {
        range: {
            start: { line: Math.max(0, diagnostic.start.line - 1), character: Math.max(0, diagnostic.start.offset - 1) },
            end: { line: Math.max(0, diagnostic.end.line - 1), character: Math.max(0, diagnostic.end.offset - 1) }
        },
        severity: diagnosticSeverity(diagnostic.category),
        source: 'ts',
        message
    }
    if (typeof diagnostic.code === 'number' || typeof diagnostic.code === 'string') {
        result.code = diagnostic.code
    }
    return [result]
}

function diagnosticMessage(value: unknown): string {
    if (typeof value === 'string') {
        return value.replace(/\s+/g, ' ').trim()
    }
    if (value !== null && typeof value === 'object' && 'messageText' in value) {
        return diagnosticMessage((value as { messageText?: unknown }).messageText)
    }
    return ''
}

function diagnosticSeverity(category: unknown): 1 | 2 | 3 | 4 {
    switch (category) {
        case 'error':
        case 1:
            return 1
        case 'warning':
        case 0:
            return 2
        case 'suggestion':
        case 2:
            return 3
        case 'message':
        case 3:
            return 4
        default:
            return 1
    }
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>()
    const result: Diagnostic[] = []
    for (const diagnostic of diagnostics) {
        const key = diagnosticKey(diagnostic)
        if (!seen.has(key)) {
            seen.add(key)
            result.push(diagnostic)
        }
    }
    return result
}
