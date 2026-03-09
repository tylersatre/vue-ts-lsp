import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Range } from 'vscode-languageserver-protocol'
import * as logger from './logger.js'

type DefinitionLocation =
    | { uri: string; range: Range }
    | {
          targetUri: string
          targetRange?: Range
          targetSelectionRange?: Range
          originSelectionRange?: Range
      }

export interface DefinitionMirrorRewrite {
    sourceUri: string
    mirrorUri: string
}

export interface RewrittenDefinitionResult {
    result: unknown
    rewrites: DefinitionMirrorRewrite[]
}

const DEFAULT_DEFINITION_MIRROR_ROOT = path.join(os.homedir(), '.cache', 'vue-ts-lsp', 'definition-mirrors')

export function getDefinitionMirrorRoot(): string {
    return process.env.VUE_TS_LSP_DEFINITION_MIRROR_ROOT ?? DEFAULT_DEFINITION_MIRROR_ROOT
}

export function buildDefinitionMirrorPath(targetPath: string, cacheRoot = getDefinitionMirrorRoot()): string {
    const normalizedTargetPath = path.resolve(targetPath)
    const relativeTargetPath = normalizedTargetPath.replace(/^[/\\]+/, '').replace(/:/g, '_')
    const parsedTargetPath = path.parse(relativeTargetPath)
    const mirrorExtension = pickMirrorExtension(normalizedTargetPath)

    return path.join(cacheRoot, parsedTargetPath.dir, `${parsedTargetPath.name}.__mirror${mirrorExtension}`)
}

export function isDefinitionMirrorUri(uri: string, cacheRoot = getDefinitionMirrorRoot()): boolean {
    try {
        const filePath = path.resolve(fileURLToPath(uri))
        const resolvedCacheRoot = path.resolve(cacheRoot)
        return filePath === resolvedCacheRoot || filePath.startsWith(resolvedCacheRoot + path.sep)
    } catch {
        return false
    }
}

export function rewriteExternalDefinitionResult(result: unknown, cacheRoot = getDefinitionMirrorRoot()): RewrittenDefinitionResult {
    if (Array.isArray(result)) {
        const rewrites: DefinitionMirrorRewrite[] = []
        const rewritten = result.map((entry) => {
            const next = rewriteDefinitionLocation(entry, cacheRoot)
            rewrites.push(...next.rewrites)
            return next.location
        })
        return { result: rewritten, rewrites }
    }

    if (!isDefinitionLocation(result)) {
        return { result, rewrites: [] }
    }

    const rewritten = rewriteDefinitionLocation(result, cacheRoot)
    return {
        result: rewritten.location,
        rewrites: rewritten.rewrites
    }
}

function rewriteDefinitionLocation(location: unknown, cacheRoot: string): { location: unknown; rewrites: DefinitionMirrorRewrite[] } {
    if (!isDefinitionLocation(location)) {
        return { location, rewrites: [] }
    }

    const sourceUri = 'targetUri' in location ? location.targetUri : location.uri
    if (!sourceUri.startsWith('file://') || !decodeURIComponent(sourceUri).includes('/node_modules/') || isDefinitionMirrorUri(sourceUri, cacheRoot)) {
        return { location, rewrites: [] }
    }

    const mirrorUri = ensureDefinitionMirrorUri(sourceUri, cacheRoot)
    if (mirrorUri === null) {
        return { location, rewrites: [] }
    }

    return {
        location: 'targetUri' in location ? { ...location, targetUri: mirrorUri } : { ...location, uri: mirrorUri },
        rewrites: [{ sourceUri, mirrorUri }]
    }
}

function ensureDefinitionMirrorUri(sourceUri: string, cacheRoot: string): string | null {
    try {
        const sourcePath = fileURLToPath(sourceUri)
        const mirrorPath = buildDefinitionMirrorPath(sourcePath, cacheRoot)
        fs.mkdirSync(path.dirname(mirrorPath), { recursive: true })

        const sourceStats = fs.statSync(sourcePath)
        let needsCopy = true
        try {
            const mirrorStats = fs.statSync(mirrorPath)
            needsCopy = mirrorStats.size !== sourceStats.size || mirrorStats.mtimeMs < sourceStats.mtimeMs
        } catch {
            needsCopy = true
        }

        if (needsCopy) {
            fs.copyFileSync(sourcePath, mirrorPath)
        }

        return pathToFileURL(mirrorPath).href
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('definition-mirrors', `failed to create mirror for ${sourceUri}: ${msg}`)
        return null
    }
}

function isDefinitionLocation(value: unknown): value is DefinitionLocation {
    return (
        value !== null &&
        typeof value === 'object' &&
        (('uri' in value && typeof (value as { uri: unknown }).uri === 'string') ||
            ('targetUri' in value && typeof (value as { targetUri: unknown }).targetUri === 'string'))
    )
}

function pickMirrorExtension(targetPath: string): '.ts' | '.tsx' | '.js' | '.jsx' {
    const lowerTargetPath = targetPath.toLowerCase()

    if (lowerTargetPath.endsWith('.tsx')) return '.tsx'
    if (lowerTargetPath.endsWith('.jsx')) return '.jsx'
    if (
        lowerTargetPath.endsWith('.d.ts') ||
        lowerTargetPath.endsWith('.d.mts') ||
        lowerTargetPath.endsWith('.d.cts') ||
        lowerTargetPath.endsWith('.ts') ||
        lowerTargetPath.endsWith('.mts') ||
        lowerTargetPath.endsWith('.cts')
    ) {
        return '.ts'
    }

    return '.js'
}
