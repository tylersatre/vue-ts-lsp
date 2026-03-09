import type { Position } from 'vscode-languageserver-protocol'
import type { ProxyContext } from './proxy-context.js'
import type { ContentChange, LspLocation } from './proxy-types.js'
import {
    VUE_DIAGNOSTIC_NUDGE_DELAY_MS,
    SCRIPT_DIAGNOSTIC_NUDGE_DELAY_MS,
    SCRIPT_DEPENDENT_DIAGNOSTIC_NUDGE_DELAY_MS,
    SCRIPT_DEPENDENT_DIAGNOSTIC_SYMBOL_LIMIT,
    SCRIPT_DEPENDENT_DIAGNOSTIC_FILE_LIMIT,
    VTSLS_BACKGROUND_REQUEST_TIMEOUT_MS
} from './proxy-types.js'
import { executeTsserverCommand, enqueueVtslsBackgroundCommand, sendDownstreamRequest, sendTsserverCommand } from './proxy-communication.js'
import { getDocumentText, collectWorkspaceImporterUris } from './proxy-workspace.js'
import { isVueUri, isScriptLikeUri, uriToFilePath } from './proxy-utils.js'
import { isInternalProbeUri } from './helpers/probes.js'
import { collectReferenceTargetsForChanges } from './helpers/references.js'
import { isDefinitionMirrorUri } from './definition-mirrors.js'
import {
    normalizeReferenceLocations,
    isSuspiciousReferenceResult,
    buildWorkspaceReferenceFallback,
    buildWorkspaceImporterReferenceFallback
} from './proxy-references.js'
import type { Diagnostic } from './diagnostics.js'
import * as logger from './logger.js'

export function forwardDiagnosticsUpstream(ctx: ProxyContext, uri: string, diagnostics: Diagnostic[]): void {
    ctx.upstream.sendNotification('textDocument/publishDiagnostics', {
        uri,
        diagnostics: [...diagnostics]
    })
}

export function clearDiagnosticsNudge(uri: string, pending: Map<string, ReturnType<typeof setTimeout>>): void {
    const timer = pending.get(uri)
    if (timer !== undefined) {
        clearTimeout(timer)
        pending.delete(uri)
    }
}

export function collectOpenDiagnosticDocumentUris(ctx: ProxyContext): string[] {
    const uris: string[] = []
    for (const [uri] of ctx.documentStore.getAll()) {
        if ((isVueUri(uri) || isScriptLikeUri(uri)) && !isInternalProbeUri(uri)) {
            uris.push(uri)
        }
    }
    return uris
}

export function uniqueTsserverFilesForUris(uris: string[]): string[] {
    const files: string[] = []
    const seen = new Set<string>()

    for (const uri of uris) {
        const filePath = uriToFilePath(uri)
        if (filePath === null || seen.has(filePath)) {
            continue
        }
        seen.add(filePath)
        files.push(filePath)
    }

    return files
}

export function areDiagnosticsFresh(ctx: ProxyContext, targetUris: string[], scheduledAt: number): boolean {
    return (
        targetUris.length > 0 &&
        targetUris.every((targetUri) => {
            const lastDiagnosticsAt = ctx.lastVtslsDiagnosticsAt.get(targetUri)
            return lastDiagnosticsAt !== undefined && lastDiagnosticsAt >= scheduledAt
        })
    )
}

export function scheduleDiagnosticsNudge(
    ctx: ProxyContext,
    uri: string,
    targetUris: string[],
    delayMs: number,
    reason: string,
    pending: Map<string, ReturnType<typeof setTimeout>>,
    queued: Set<string>
): void {
    const files = uniqueTsserverFilesForUris(targetUris)
    if (files.length === 0 || isInternalProbeUri(uri)) {
        return
    }

    clearDiagnosticsNudge(uri, pending)
    const scheduledAt = Date.now()
    logger.debug('proxy', `textDocument/didChange ${uri} diagnostics nudge scheduled delay=${delayMs}ms reason=${reason}`)
    const timer = setTimeout(() => {
        pending.delete(uri)
        if (areDiagnosticsFresh(ctx, targetUris, scheduledAt)) {
            logger.debug(
                'proxy',
                `textDocument/didChange ${uri} diagnostics nudge skipped reason=fresh-vtsls-diagnostics targets=${targetUris.length} scheduledAt=${scheduledAt}`
            )
            return
        }
        if (queued.has(uri)) {
            logger.debug('proxy', `textDocument/didChange ${uri} diagnostics nudge skipped reason=already-queued`)
            return
        }
        queued.add(uri)
        void executeTsserverCommand(ctx, 'geterr', { delay: 0, files }, `textDocument/didChange ${uri} ${reason} diagnostics nudge`, {
            background: true
        }).finally(() => {
            queued.delete(uri)
        })
    }, delayMs)
    pending.set(uri, timer)
}

export function clearVueDiagnosticsNudge(ctx: ProxyContext, uri: string): void {
    clearDiagnosticsNudge(uri, ctx.pendingVueDiagnosticNudges)
}

export function clearScriptDiagnosticsNudge(ctx: ProxyContext, uri: string): void {
    clearDiagnosticsNudge(uri, ctx.pendingScriptDiagnosticNudges)
}

export function clearScriptDependentDiagnosticsNudge(ctx: ProxyContext, uri: string): void {
    clearDiagnosticsNudge(uri, ctx.pendingScriptDependentDiagnosticNudges)
}

export function scheduleVueDiagnosticsNudge(ctx: ProxyContext, uri: string): void {
    scheduleDiagnosticsNudge(ctx, uri, [uri], VUE_DIAGNOSTIC_NUDGE_DELAY_MS, 'vue', ctx.pendingVueDiagnosticNudges, ctx.queuedVueDiagnosticNudges)
}

export function scheduleScriptDiagnosticsNudge(ctx: ProxyContext, uri: string): void {
    scheduleDiagnosticsNudge(
        ctx,
        uri,
        [uri, ...collectOpenDiagnosticDocumentUris(ctx)],
        SCRIPT_DIAGNOSTIC_NUDGE_DELAY_MS,
        'script',
        ctx.pendingScriptDiagnosticNudges,
        ctx.queuedScriptDiagnosticNudges
    )
}

export async function requestScriptReferenceLocationsInBackground(ctx: ProxyContext, uri: string, position: Position): Promise<LspLocation[]> {
    try {
        const result = await sendDownstreamRequest(
            ctx,
            'vtsls',
            'textDocument/references',
            {
                textDocument: { uri },
                position,
                context: { includeDeclaration: false }
            },
            {
                priority: 'background',
                retryOnTimeout: false,
                timeoutMs: Math.min(ctx.requestTimeoutMs, VTSLS_BACKGROUND_REQUEST_TIMEOUT_MS)
            }
        )
        return normalizeReferenceLocations(result)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `textDocument/references background uri=${uri}:${position.line}:${position.character} ERROR: ${msg}`)
        return []
    }
}

export async function resolveScriptDependentDiagnosticTargetUris(
    ctx: ProxyContext,
    uri: string,
    oldText: string | null,
    contentChanges: ContentChange[]
): Promise<string[]> {
    const newText = getDocumentText(ctx, uri)
    if (newText === null) {
        return []
    }

    const workspaceRootUri = ctx.savedInitParams?.rootUri ?? null
    const referenceTargets = collectReferenceTargetsForChanges(uri, oldText, newText, contentChanges).slice(0, SCRIPT_DEPENDENT_DIAGNOSTIC_SYMBOL_LIMIT)
    if (referenceTargets.length === 0) {
        return collectWorkspaceImporterUris(ctx, uri).slice(0, SCRIPT_DEPENDENT_DIAGNOSTIC_FILE_LIMIT)
    }
    const targetUris: string[] = []
    const seenUris = new Set<string>()

    for (const target of referenceTargets) {
        let locations = (await requestScriptReferenceLocationsInBackground(ctx, uri, target.selectionRange.start)).filter((location) => location.uri !== uri)
        if (isSuspiciousReferenceResult(uri, target.kind, locations)) {
            const importerFallbackLocations = buildWorkspaceImporterReferenceFallback(ctx, uri, target.name).filter((location) => location.uri !== uri)
            const workspaceFallbackLocations =
                importerFallbackLocations.length > 0
                    ? importerFallbackLocations
                    : buildWorkspaceReferenceFallback(ctx, uri, target.name, false, target.selectionRange).filter((location) => location.uri !== uri)
            locations = normalizeReferenceLocations([...locations, ...workspaceFallbackLocations])
        }

        for (const location of locations) {
            if (workspaceRootUri !== null && !location.uri.startsWith(workspaceRootUri)) {
                continue
            }
            if (isDefinitionMirrorUri(location.uri)) {
                continue
            }
            if (seenUris.has(location.uri)) {
                continue
            }

            seenUris.add(location.uri)
            targetUris.push(location.uri)
            if (targetUris.length >= SCRIPT_DEPENDENT_DIAGNOSTIC_FILE_LIMIT) {
                return targetUris
            }
        }
    }

    if (targetUris.length === 0) {
        return collectWorkspaceImporterUris(ctx, uri).slice(0, SCRIPT_DEPENDENT_DIAGNOSTIC_FILE_LIMIT)
    }

    return targetUris
}

export function scheduleScriptDependentDiagnosticsNudge(ctx: ProxyContext, uri: string, oldText: string | null, contentChanges: ContentChange[]): void {
    const newText = getDocumentText(ctx, uri)
    if (newText === null || isInternalProbeUri(uri)) {
        return
    }

    const referenceTargets = collectReferenceTargetsForChanges(uri, oldText, newText, contentChanges).slice(0, SCRIPT_DEPENDENT_DIAGNOSTIC_SYMBOL_LIMIT)
    clearScriptDependentDiagnosticsNudge(ctx, uri)
    const scheduledAt = Date.now()
    logger.debug(
        'proxy',
        `textDocument/didChange ${uri} dependent diagnostics nudge scheduled delay=${SCRIPT_DEPENDENT_DIAGNOSTIC_NUDGE_DELAY_MS}ms targets=${referenceTargets.length}`
    )

    const timer = setTimeout(() => {
        ctx.pendingScriptDependentDiagnosticNudges.delete(uri)
        if (ctx.queuedScriptDependentDiagnosticNudges.has(uri)) {
            logger.debug('proxy', `textDocument/didChange ${uri} dependent diagnostics nudge skipped reason=already-queued`)
            return
        }

        ctx.queuedScriptDependentDiagnosticNudges.add(uri)
        void enqueueVtslsBackgroundCommand(ctx, `textDocument/didChange ${uri} dependent diagnostics nudge`, async () => {
            const dependentUris = await resolveScriptDependentDiagnosticTargetUris(ctx, uri, oldText, contentChanges)
            if (dependentUris.length === 0) {
                logger.debug('proxy', `textDocument/didChange ${uri} dependent diagnostics nudge skipped reason=no-dependent-targets`)
                return
            }

            const targetUris = [uri, ...collectOpenDiagnosticDocumentUris(ctx), ...dependentUris]
            if (areDiagnosticsFresh(ctx, targetUris, scheduledAt)) {
                logger.debug(
                    'proxy',
                    `textDocument/didChange ${uri} dependent diagnostics nudge skipped reason=fresh-vtsls-diagnostics targets=${targetUris.length} scheduledAt=${scheduledAt}`
                )
                return
            }

            await sendTsserverCommand(
                ctx,
                'geterr',
                { delay: 0, files: uniqueTsserverFilesForUris(targetUris) },
                `textDocument/didChange ${uri} dependent diagnostics nudge`,
                { isAsync: true, lowPriority: true },
                {
                    priority: 'background',
                    retryOnTimeout: false,
                    timeoutMs: Math.min(ctx.requestTimeoutMs, VTSLS_BACKGROUND_REQUEST_TIMEOUT_MS)
                }
            )
        }).finally(() => {
            ctx.queuedScriptDependentDiagnosticNudges.delete(uri)
        })
    }, SCRIPT_DEPENDENT_DIAGNOSTIC_NUDGE_DELAY_MS)
    ctx.pendingScriptDependentDiagnosticNudges.set(uri, timer)
}
