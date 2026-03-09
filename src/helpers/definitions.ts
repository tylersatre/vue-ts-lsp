import type { DefinitionClassification, DefinitionLocation } from './types.js'
import { isInternalProbeUri } from './probes.js'

export function classifyDefinitionResult(requestUri: string, result: unknown, workspaceRootUri: string | null): DefinitionClassification {
    const locations = normalizeDefinitionLocations(result).filter((location) => {
        const targetUri = 'targetUri' in location ? location.targetUri : location.uri
        return !isInternalProbeUri(targetUri)
    })
    if (locations.length === 0) {
        return {
            kind: 'empty',
            count: 0,
            hasSelf: false,
            hasWorkspace: false,
            hasExternalLibrary: false
        }
    }

    let hasSelf = false
    let hasWorkspace = false
    let hasExternalLibrary = false

    for (const location of locations) {
        const targetUri = 'targetUri' in location ? location.targetUri : location.uri
        if (targetUri === requestUri) {
            hasSelf = true
        } else if (targetUri.includes('/node_modules/')) {
            hasExternalLibrary = true
        } else if (workspaceRootUri !== null && targetUri.startsWith(workspaceRootUri)) {
            hasWorkspace = true
        } else {
            hasWorkspace = true
        }
    }

    const distinctKinds = [hasSelf, hasWorkspace, hasExternalLibrary].filter(Boolean).length
    let kind: DefinitionClassification['kind']
    if (distinctKinds > 1) {
        kind = 'mixed'
    } else if (hasSelf) {
        kind = 'self'
    } else if (hasExternalLibrary) {
        kind = 'external-library'
    } else {
        kind = 'workspace'
    }

    return {
        kind,
        count: locations.length,
        hasSelf,
        hasWorkspace,
        hasExternalLibrary
    }
}

export function normalizeDefinitionResult(result: unknown): unknown {
    if (Array.isArray(result)) {
        const normalized = result
            .flatMap((value) => normalizeDefinitionLocation(value))
            .filter((location) => !isInternalProbeUri('targetUri' in location ? location.targetUri : location.uri))
        return dedupeLocations(normalized)
    }

    if (isDefinitionLocation(result)) {
        const normalized = normalizeDefinitionLocation(result)
        if (normalized.length === 0) {
            return null
        }
        return normalized[0]!
    }

    return result
}

export function preferDefinitionResult(requestUri: string, result: unknown, workspaceRootUri: string | null): unknown {
    const wasArray = Array.isArray(result)
    const locations = normalizeDefinitionLocations(result).filter((location) => {
        const targetUri = 'targetUri' in location ? location.targetUri : location.uri
        return !isInternalProbeUri(targetUri)
    })
    if (locations.length === 0) {
        return result
    }

    const workspace = locations.filter(
        (location) => definitionBucketForUri(requestUri, 'targetUri' in location ? location.targetUri : location.uri, workspaceRootUri) === 'workspace'
    )
    if (workspace.length > 0) {
        return wasArray ? workspace : workspace[0]!
    }

    const external = locations.filter(
        (location) => definitionBucketForUri(requestUri, 'targetUri' in location ? location.targetUri : location.uri, workspaceRootUri) === 'external-library'
    )
    if (external.length > 0) {
        return wasArray ? external : external[0]!
    }

    return wasArray ? locations : locations[0]!
}

function normalizeDefinitionLocations(result: unknown): DefinitionLocation[] {
    if (result === null || result === undefined) return []
    if (Array.isArray(result)) {
        return result.filter(isDefinitionLocation)
    }
    return isDefinitionLocation(result) ? [result] : []
}

function normalizeDefinitionLocation(value: DefinitionLocation): DefinitionLocation[] {
    if ('targetUri' in value) {
        const range = value.targetSelectionRange ?? value.targetRange ?? value.originSelectionRange
        if (range === undefined) {
            return [{ targetUri: value.targetUri }]
        }
        return [{ uri: value.targetUri, range }]
    }

    return [value]
}

function dedupeLocations(locations: DefinitionLocation[]): DefinitionLocation[] {
    const seen = new Set<string>()
    return locations.filter((location) => {
        const uri = 'targetUri' in location ? location.targetUri : location.uri
        const range = 'targetUri' in location ? (location.targetSelectionRange ?? location.targetRange ?? location.originSelectionRange) : location.range
        const key = [uri, range?.start.line ?? -1, range?.start.character ?? -1, range?.end.line ?? -1, range?.end.character ?? -1].join(':')
        if (seen.has(key)) {
            return false
        }
        seen.add(key)
        return true
    })
}

function isDefinitionLocation(value: unknown): value is DefinitionLocation {
    if (value === null || typeof value !== 'object') return false
    if ('targetUri' in value) return typeof (value as { targetUri: unknown }).targetUri === 'string'
    if ('uri' in value) return typeof (value as { uri: unknown }).uri === 'string'
    return false
}

function definitionBucketForUri(requestUri: string, targetUri: string, workspaceRootUri: string | null): 'self' | 'workspace' | 'external-library' {
    if (targetUri === requestUri) {
        return 'self'
    }
    if (targetUri.includes('/node_modules/')) {
        return 'external-library'
    }
    if (workspaceRootUri === null) {
        return 'workspace'
    }
    return targetUri.startsWith(workspaceRootUri) ? 'workspace' : 'workspace'
}
