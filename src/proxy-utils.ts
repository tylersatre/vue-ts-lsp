import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { InitializeParams, Position, Range } from 'vscode-languageserver-protocol'
import { computeDocumentEnd } from './documents.js'
import type {
    ContentChange,
    LspLocation,
    CallHierarchyItemLike,
    TsserverDisplayPartLike,
    TsserverJSDocTagLike,
    TsserverQuickInfoBodyLike,
    IncomingCallLike,
    SpawnedConnection,
    SpawnedConnectionResult
} from './proxy-types.js'

export function resolveVueTypescriptPluginLocation(): string {
    const require = createRequire(import.meta.url)
    const entryPoint = require.resolve('@vue/language-server')
    return path.dirname(entryPoint)
}

export function buildVtslsSettings(vueTypescriptPluginLocation: string) {
    return {
        vtsls: {
            autoUseWorkspaceTsdk: true,
            tsserver: {
                globalPlugins: [
                    {
                        name: '@vue/typescript-plugin',
                        location: vueTypescriptPluginLocation,
                        languages: ['vue'],
                        configNamespace: 'typescript',
                        enableForWorkspaceTypeScriptVersions: true
                    }
                ]
            }
        },
        typescript: {
            tsserver: {
                maxTsServerMemory: 8192,
                log: 'verbose'
            }
        }
    }
}

export function buildVueLsSettings() {
    return {
        vue: { hybridMode: true }
    }
}

export function buildVtslsInitParams(params: InitializeParams, pluginLocation: string) {
    return {
        rootUri: params.rootUri,
        workspaceFolders: params.workspaceFolders,
        capabilities: {
            ...params.capabilities,
            workspace: {
                ...((params.capabilities?.workspace as Record<string, unknown>) ?? {}),
                configuration: true
            }
        },
        initializationOptions: {
            settings: buildVtslsSettings(pluginLocation)
        }
    }
}

export function buildVueLsInitParams(params: InitializeParams) {
    return {
        rootUri: params.rootUri,
        workspaceFolders: params.workspaceFolders,
        capabilities: {
            ...params.capabilities,
            workspace: {
                ...((params.capabilities?.workspace as Record<string, unknown>) ?? {}),
                configuration: true
            }
        },
        initializationOptions: buildVueLsSettings()
    }
}

export function summarizePayload(value: unknown): string {
    if (value === null || value === undefined) return String(value)
    const json = JSON.stringify(value)
    return json.length > 500 ? json.slice(0, 500) + '\u2026' : json
}

export function hoverResultLooksLoading(result: unknown): boolean {
    return hoverValueLooksLoading(result)
}

export function hoverValueLooksLoading(value: unknown): boolean {
    if (typeof value === 'string') {
        const normalized = value.toLowerCase()
        return normalized.includes('(loading...)') || normalized.includes('loading...')
    }

    if (Array.isArray(value)) {
        return value.some((entry) => hoverValueLooksLoading(entry))
    }

    if (value === null || value === undefined || typeof value !== 'object') {
        return false
    }

    if ('value' in value && hoverValueLooksLoading((value as { value: unknown }).value)) {
        return true
    }

    if ('contents' in value && hoverValueLooksLoading((value as { contents: unknown }).contents)) {
        return true
    }

    return false
}

export function isVueUri(uri: string): boolean {
    const lastSlash = uri.lastIndexOf('/')
    const filename = lastSlash >= 0 ? uri.slice(lastSlash + 1) : uri
    const dot = filename.lastIndexOf('.')
    return dot >= 0 && filename.slice(dot) === '.vue'
}

export function isScriptLikeUri(uri: string): boolean {
    const lastSlash = uri.lastIndexOf('/')
    const filename = lastSlash >= 0 ? uri.slice(lastSlash + 1) : uri
    return /\.(?:[cm]?[jt]sx?)$/i.test(filename)
}

export function uriToFilePath(uri: string): string | null {
    try {
        return fileURLToPath(uri)
    } catch {
        return null
    }
}

export function basenameFromUri(uri: string): string {
    const filePath = uriToFilePath(uri)
    if (filePath !== null) {
        return path.basename(filePath)
    }
    const lastSlash = uri.lastIndexOf('/')
    return lastSlash >= 0 ? uri.slice(lastSlash + 1) : uri
}

export function languageIdForUri(uri: string): string {
    if (isVueUri(uri)) return 'vue'
    if (/\.tsx$/i.test(uri)) return 'typescriptreact'
    if (/\.jsx$/i.test(uri)) return 'javascriptreact'
    if (/\.[cm]?js$/i.test(uri)) return 'javascript'
    return 'typescript'
}

export function isPosition(value: unknown): value is Position {
    return (
        value !== null &&
        typeof value === 'object' &&
        'line' in value &&
        'character' in value &&
        typeof (value as { line: unknown }).line === 'number' &&
        typeof (value as { character: unknown }).character === 'number'
    )
}

export function isRange(value: unknown): value is Range {
    return (
        value !== null &&
        typeof value === 'object' &&
        'start' in value &&
        'end' in value &&
        isPosition((value as { start: unknown }).start) &&
        isPosition((value as { end: unknown }).end)
    )
}

export function isLocation(value: unknown): value is LspLocation {
    return (
        value !== null &&
        typeof value === 'object' &&
        'uri' in value &&
        typeof (value as { uri: unknown }).uri === 'string' &&
        'range' in value &&
        isRange((value as { range: unknown }).range)
    )
}

export function isCallHierarchyItem(value: unknown): value is CallHierarchyItemLike {
    return (
        value !== null &&
        typeof value === 'object' &&
        'uri' in value &&
        typeof (value as { uri: unknown }).uri === 'string' &&
        'name' in value &&
        typeof (value as { name: unknown }).name === 'string' &&
        'kind' in value &&
        typeof (value as { kind: unknown }).kind === 'number' &&
        'range' in value &&
        isRange((value as { range: unknown }).range) &&
        'selectionRange' in value &&
        isRange((value as { selectionRange: unknown }).selectionRange)
    )
}

export function itemKey(item: CallHierarchyItemLike): string {
    return [
        item.uri,
        item.name,
        item.selectionRange.start.line,
        item.selectionRange.start.character,
        item.selectionRange.end.line,
        item.selectionRange.end.character
    ].join(':')
}

export function buildSyntheticItem(uri: string, name: string, kind: number, range: Range): CallHierarchyItemLike {
    return {
        uri,
        name,
        kind,
        range,
        selectionRange: range,
        detail: ''
    }
}

export function isTsserverDisplayPartLike(value: unknown): value is TsserverDisplayPartLike {
    return value !== null && typeof value === 'object' && 'text' in value && typeof (value as { text: unknown }).text === 'string'
}

export function flattenTsserverText(value: unknown): string {
    if (typeof value === 'string') {
        return value
    }

    if (!Array.isArray(value)) {
        return ''
    }

    return value
        .filter(isTsserverDisplayPartLike)
        .map((part) => part.text)
        .join('')
}

export function isTsserverJSDocTagLike(value: unknown): value is TsserverJSDocTagLike {
    return value !== null && typeof value === 'object' && 'name' in value && typeof (value as { name: unknown }).name === 'string'
}

export function isTsserverQuickInfoBodyLike(value: unknown): value is TsserverQuickInfoBodyLike {
    return value !== null && typeof value === 'object' && 'displayString' in value && typeof (value as { displayString: unknown }).displayString === 'string'
}

export function extractTsserverResponseBody(response: unknown): unknown {
    return response !== null && response !== undefined && typeof response === 'object' && 'body' in response ? (response as { body: unknown }).body : null
}

export function quickInfoToHover(body: TsserverQuickInfoBodyLike): {
    contents: { kind: 'markdown'; value: string }
} {
    const sections: string[] = []
    sections.push(`\`\`\`ts\n${body.displayString}\n\`\`\``)

    const documentation = flattenTsserverText(body.documentation)
    if (documentation.length > 0) {
        sections.push(documentation)
    }

    if (Array.isArray(body.tags)) {
        const tags = body.tags.filter(isTsserverJSDocTagLike).map((tag) => {
            const text = flattenTsserverText(tag.text)
            return text.length > 0 ? `@${tag.name} ${text}` : `@${tag.name}`
        })
        if (tags.length > 0) {
            sections.push(tags.join('\n'))
        }
    }

    return {
        contents: {
            kind: 'markdown',
            value: sections.join('\n\n')
        }
    }
}

export function isIncomingCallLike(value: unknown): value is IncomingCallLike {
    return (
        value !== null &&
        typeof value === 'object' &&
        'from' in value &&
        isCallHierarchyItem((value as { from: unknown }).from) &&
        'fromSpans' in value &&
        Array.isArray((value as { fromSpans: unknown }).fromSpans) &&
        (value as { fromSpans: unknown[] }).fromSpans.every(isRange)
    )
}

export function rangeKey(range: Range): string {
    return [range.start.line, range.start.character, range.end.line, range.end.character].join(':')
}

export function mergeIncomingCallResults(initialResult: unknown, fallback: unknown[]): unknown {
    if (!Array.isArray(initialResult) || fallback.length === 0) {
        return initialResult
    }

    const merged = [...initialResult]
    const byKey = new Map<string, IncomingCallLike>()

    for (const entry of merged) {
        if (isIncomingCallLike(entry)) {
            byKey.set(itemKey(entry.from), entry)
        }
    }

    for (const entry of fallback) {
        if (!isIncomingCallLike(entry)) {
            merged.push(entry)
            continue
        }

        const key = itemKey(entry.from)
        const existing = byKey.get(key)
        if (existing === undefined) {
            merged.push(entry)
            byKey.set(key, entry)
            continue
        }

        const spanKeys = new Set(existing.fromSpans.map(rangeKey))
        for (const span of entry.fromSpans) {
            const key = rangeKey(span)
            if (spanKeys.has(key)) {
                continue
            }
            existing.fromSpans.push(span)
            spanKeys.add(key)
        }
    }

    return merged
}

/** Adds an explicit range to full-document replacements so vtsls uses the original document bounds. */
export function patchFullDocReplacements(contentChanges: ContentChange[], oldContent: string): ContentChange[] {
    let needsPatch = false
    for (const change of contentChanges) {
        if (change.range === undefined) {
            needsPatch = true
            break
        }
    }
    if (!needsPatch) return contentChanges

    const end = computeDocumentEnd(oldContent)
    return contentChanges.map((change) => {
        if (change.range !== undefined) return change
        return {
            ...change,
            range: { start: { line: 0, character: 0 }, end }
        }
    })
}

export function normalizeSpawnedConnection(spawned: SpawnedConnection): SpawnedConnectionResult {
    if (spawned !== null && typeof spawned === 'object' && 'conn' in spawned && (spawned as { conn?: unknown }).conn !== undefined) {
        const typedSpawned = spawned as SpawnedConnectionResult
        return {
            conn: typedSpawned.conn,
            kill: typedSpawned.kill
        }
    }

    return {
        conn: spawned as MessageConnection
    }
}
