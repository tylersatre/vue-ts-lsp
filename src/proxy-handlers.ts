import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { ProxyContext } from './proxy-context.js'
import type { ContentChange } from './proxy-types.js'
import { isVueUri, isScriptLikeUri, summarizePayload, buildVtslsSettings, buildVueLsSettings, patchFullDocReplacements } from './proxy-utils.js'
import {
    sendDownstreamRequest,
    buildTsserverRequestCommand,
    logDiagnostics,
    summarizeResultCount,
    summarizeMethodResult,
    maybeLogVueTsWarmup
} from './proxy-communication.js'
import { getDocumentText } from './proxy-workspace.js'
import {
    forwardDiagnosticsUpstream,
    scheduleVueDiagnosticsNudge,
    scheduleScriptDiagnosticsNudge,
    scheduleScriptDependentDiagnosticsNudge,
    clearVueDiagnosticsNudge,
    clearScriptDiagnosticsNudge,
    clearScriptDependentDiagnosticsNudge
} from './proxy-diagnostics.js'
import { requestWithVueDefinitionRetry, maybePrimeDocument } from './proxy-definitions.js'
import { requestWithVueHoverRetry } from './proxy-hover.js'
import { requestWithReferenceFallback } from './proxy-references.js'
import { requestWithWorkspaceSymbolFallback, buildWorkspaceSymbolParams, rememberPositionContext } from './proxy-symbols.js'
import { requestWithPrepareCallHierarchyFallback, requestWithCallHierarchyFallback } from './proxy-call-hierarchy.js'
import { extractRequestUri } from './helpers/identifiers.js'
import { isInternalProbeUri } from './helpers/probes.js'
import { normalizeDocumentSymbolKinds } from './helpers/symbols.js'
import { extractTsserverRequestId, parseTsserverRequest, summarizeBridgeResponseBody } from './helpers/tsserver.js'
import { routeRequest } from './router.js'
import type { Diagnostic } from './diagnostics.js'
import * as logger from './logger.js'

export function setupVtslsHandlers(ctx: ProxyContext, conn: MessageConnection): void {
    conn.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
        const p = params as { uri: string; diagnostics: Diagnostic[] }
        if (isInternalProbeUri(p.uri)) {
            logger.debug('proxy', `publishDiagnostics ignored internal probe uri=${p.uri} count=${p.diagnostics.length}`)
            return
        }
        ctx.lastVtslsDiagnosticsAt.set(p.uri, Date.now())
        if (isVueUri(p.uri)) {
            const merged = ctx.diagnosticsStore.update(p.uri, 'vtsls', p.diagnostics)
            logDiagnostics('vtsls', p.uri, p.diagnostics.length, merged.length)
            forwardDiagnosticsUpstream(ctx, p.uri, merged)
        } else {
            logDiagnostics('vtsls', p.uri, p.diagnostics.length)
            forwardDiagnosticsUpstream(ctx, p.uri, p.diagnostics)
        }
    })
    conn.onNotification('window/logMessage', (params: unknown) => {
        const p = params as { type: number; message: string }
        logger.debug('vtsls', p.message)
        ctx.upstream.sendNotification('window/logMessage', {
            type: p.type,
            message: `[vtsls] ${p.message}`
        })
    })
    setupConfigHandler(ctx, conn, 'vtsls')
}

export function setupVueLsHandlers(ctx: ProxyContext, conn: MessageConnection): void {
    conn.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
        const p = params as { uri: string; diagnostics: Diagnostic[] }
        if (isInternalProbeUri(p.uri)) {
            logger.debug('proxy', `publishDiagnostics ignored internal probe uri=${p.uri} count=${p.diagnostics.length}`)
            return
        }
        if (isVueUri(p.uri)) {
            const merged = ctx.diagnosticsStore.update(p.uri, 'vue_ls', p.diagnostics)
            logDiagnostics('vue_ls', p.uri, p.diagnostics.length, merged.length)
            forwardDiagnosticsUpstream(ctx, p.uri, merged)
        } else {
            logDiagnostics('vue_ls', p.uri, p.diagnostics.length)
            forwardDiagnosticsUpstream(ctx, p.uri, p.diagnostics)
        }
    })
    conn.onNotification('window/logMessage', (params: unknown) => {
        const p = params as { type: number; message: string }
        logger.debug('vue_ls', p.message)
        ctx.upstream.sendNotification('window/logMessage', {
            type: p.type,
            message: `[vue_ls] ${p.message}`
        })
    })
    setupConfigHandler(ctx, conn, 'vue_ls')
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
        try {
            conn.sendNotification('tsserver/response', [id, body])
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn('proxy', `tsserver/response #${id} dropped: ${msg}`)
        }
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
        ctx.documentStore.open(uri, languageId, version, text)
        const target = isVueUri(uri) ? 'vtsls+vue_ls' : 'vtsls'
        logger.info('proxy', `textDocument/didOpen ${uri} → ${target}`)
        logger.debug('proxy', `textDocument/didOpen payload: ${summarizePayload(params)}`)
        ctx.currentVtsls.sendNotification('textDocument/didOpen', params)
        if (isVueUri(uri)) {
            ctx.currentVueLs.sendNotification('textDocument/didOpen', params)
        }
        maybePrimeDocument(ctx, uri)
    })

    ctx.upstream.onNotification('textDocument/didChange', (params: unknown) => {
        const didChangeParams = params as {
            textDocument: { uri: string; version: number }
            contentChanges: ContentChange[]
        }
        const { uri, version } = didChangeParams.textDocument
        const documentBeforeChange = ctx.documentStore.get(uri)

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
        ctx.currentVtsls.sendNotification('textDocument/didChange', forwardedChangeParams)
        if (isVueUri(uri)) {
            ctx.currentVueLs.sendNotification('textDocument/didChange', forwardedChangeParams)
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
        ctx.lastVtslsDiagnosticsAt.delete(uri)
        clearVueDiagnosticsNudge(ctx, uri)
        clearScriptDiagnosticsNudge(ctx, uri)
        clearScriptDependentDiagnosticsNudge(ctx, uri)
        ctx.queuedVueDiagnosticNudges.delete(uri)
        ctx.queuedScriptDiagnosticNudges.delete(uri)
        ctx.queuedScriptDependentDiagnosticNudges.delete(uri)
        ctx.currentVtsls.sendNotification('textDocument/didClose', params)
        if (isVueUri(uri)) {
            ctx.currentVueLs.sendNotification('textDocument/didClose', params)
        }
    })

    ctx.upstream.onNotification('textDocument/didSave', (params: unknown) => {
        const didSaveParams = params as { textDocument: { uri: string } }
        const { uri } = didSaveParams.textDocument
        ctx.currentVtsls.sendNotification('textDocument/didSave', params)
        if (isVueUri(uri)) {
            ctx.currentVueLs.sendNotification('textDocument/didSave', params)
        }
    })
}

export function forwardRequest(ctx: ProxyContext, method: string): void {
    ctx.upstream.onRequest(method, async (params: unknown) => {
        const requestUri = extractRequestUri(params)
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
