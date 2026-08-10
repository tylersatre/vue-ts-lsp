import { pathToFileURL } from 'node:url'
import type { Range } from 'vscode-languageserver-protocol'
import type { ProxyContext } from './proxy-context.js'
import type { LspLocation } from './proxy-types.js'
import { isLocation } from './proxy-utils.js'
import { sendDownstreamRequest } from './proxy-communication.js'
import { getWorkspaceRootPath, listWorkspaceSourceFiles, getDocumentText, collectWorkspaceImporterUris } from './proxy-workspace.js'
import { isInternalProbeUri } from './helpers/probes.js'
import { findReferenceTargetAtPosition, collectIdentifierReferencesInDocument } from './helpers/references.js'
import { extractRequestPosition } from './helpers/identifiers.js'
import * as logger from './logger.js'

function locationKey(location: LspLocation): string {
    return [location.uri, location.range.start.line, location.range.start.character, location.range.end.line, location.range.end.character].join(':')
}

export function normalizeReferenceLocations(result: unknown): LspLocation[] {
    if (!Array.isArray(result)) {
        return []
    }

    const seen = new Set<string>()
    return result
        .filter(isLocation)
        .filter((location) => !isInternalProbeUri(location.uri))
        .filter((location) => {
            const key = locationKey(location)
            if (seen.has(key)) {
                return false
            }
            seen.add(key)
            return true
        })
}

export function isSuspiciousReferenceResult(requestUri: string, targetKind: string, locations: LspLocation[]): boolean {
    if (locations.length === 0) {
        return true
    }

    const uniqueUris = new Set(locations.map((location) => location.uri))
    if ((targetKind === 'type-alias' || targetKind === 'interface' || targetKind === 'enum') && uniqueUris.size === 1 && uniqueUris.has(requestUri)) {
        return true
    }

    if (targetKind === 'component' && uniqueUris.size === 1 && uniqueUris.has(requestUri)) {
        return true
    }

    if ((targetKind === 'method' || targetKind === 'function') && uniqueUris.size === 1 && uniqueUris.has(requestUri)) {
        return true
    }

    return false
}

function collectReferencesFromUris(
    ctx: ProxyContext,
    uris: Iterable<string>,
    targetName: string,
    excludeLocation?: (uri: string, location: LspLocation) => boolean
): LspLocation[] {
    const results: LspLocation[] = []
    const seen = new Set<string>()
    for (const uri of uris) {
        const text = getDocumentText(ctx, uri)
        if (text === null) {
            continue
        }

        for (const location of collectIdentifierReferencesInDocument(uri, text, targetName)) {
            if (excludeLocation !== undefined && excludeLocation(uri, location)) {
                continue
            }

            const key = locationKey(location)
            if (seen.has(key)) {
                continue
            }
            seen.add(key)
            results.push(location)
        }
    }

    return results
}

export function buildWorkspaceReferenceFallback(
    ctx: ProxyContext,
    requestUri: string,
    targetName: string,
    includeDeclaration: boolean,
    declarationRange: Range | null
): LspLocation[] {
    const workspaceRootPath = getWorkspaceRootPath(ctx)
    if (workspaceRootPath === null) {
        return []
    }

    const uris = listWorkspaceSourceFiles(ctx, workspaceRootPath).map((filePath) => pathToFileURL(filePath).href)
    return collectReferencesFromUris(ctx, uris, targetName, (uri, location) => {
        const isDeclaration =
            declarationRange !== null &&
            uri === requestUri &&
            location.range.start.line === declarationRange.start.line &&
            location.range.start.character === declarationRange.start.character &&
            location.range.end.line === declarationRange.end.line &&
            location.range.end.character === declarationRange.end.character
        return !includeDeclaration && isDeclaration
    })
}

export function buildWorkspaceImporterReferenceFallback(ctx: ProxyContext, requestUri: string, targetName: string): LspLocation[] {
    return collectReferencesFromUris(ctx, collectWorkspaceImporterUris(ctx, requestUri), targetName)
}

export async function requestWithReferenceFallback(
    ctx: ProxyContext,
    params: unknown,
    target: 'vtsls' | 'vue_ls',
    requestUri: string | null
): Promise<unknown> {
    const initialResult = await sendDownstreamRequest(ctx, target, 'textDocument/references', params)
    if (target !== 'vtsls' || requestUri === null) {
        return initialResult
    }

    const position = extractRequestPosition(params)
    if (position === null) {
        return initialResult
    }

    const text = getDocumentText(ctx, requestUri)
    if (text === null) {
        return initialResult
    }

    const referenceTarget = findReferenceTargetAtPosition(requestUri, text, position)
    if (referenceTarget === null) {
        return initialResult
    }

    const initialLocations = normalizeReferenceLocations(initialResult)
    if (!isSuspiciousReferenceResult(requestUri, referenceTarget.kind, initialLocations)) {
        return initialResult
    }

    const includeDeclaration =
        params !== null &&
        typeof params === 'object' &&
        'context' in params &&
        (params as { context?: { includeDeclaration?: boolean } }).context?.includeDeclaration === true
    let fallbackLocations = buildWorkspaceReferenceFallback(ctx, requestUri, referenceTarget.name, includeDeclaration, referenceTarget.selectionRange)
    if (initialLocations.length > 0) {
        fallbackLocations = fallbackLocations.filter((location) => location.uri !== requestUri)
    }

    if (fallbackLocations.length === 0) {
        logger.debug(
            'proxy',
            `textDocument/references fallback skipped uri=${requestUri} symbol=${referenceTarget.name} kind=${referenceTarget.kind} result=${initialLocations.length}`
        )
        return initialResult
    }

    const merged = normalizeReferenceLocations([...initialLocations, ...fallbackLocations])
    logger.debug(
        'proxy',
        `textDocument/references fallback uri=${requestUri} symbol=${referenceTarget.name} kind=${referenceTarget.kind} raw=${initialLocations.length} fallback=${fallbackLocations.length} merged=${merged.length}`
    )
    return merged
}
