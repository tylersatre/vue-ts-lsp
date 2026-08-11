import { normalizeUriIdentity } from './helpers/uri.js'

export interface DocumentInfo {
    content: string
    version: number
    languageId: string
}

interface ContentChange {
    range?: {
        start: { line: number; character: number }
        end: { line: number; character: number }
    }
    text: string
}

export class DocumentStore {
    private readonly docs = new Map<string, { uri: string; info: DocumentInfo }>()

    open(uri: string, languageId: string, version: number, content: string): void {
        const identity = normalizeUriIdentity(uri)
        const protocolUri = this.docs.get(identity)?.uri ?? uri
        this.docs.set(identity, { uri: protocolUri, info: { content, version, languageId } })
    }

    change(uri: string, version: number, changes: ContentChange[]): void {
        const stored = this.docs.get(normalizeUriIdentity(uri))
        if (stored === undefined) return
        let content = stored.info.content
        for (const change of changes) {
            content = applyContentChange(content, change)
        }
        stored.info.content = content
        stored.info.version = version
    }

    close(uri: string): void {
        this.docs.delete(normalizeUriIdentity(uri))
    }

    get(uri: string): DocumentInfo | undefined {
        return this.docs.get(normalizeUriIdentity(uri))?.info
    }

    /** The URI spelling originally used to open this document downstream. */
    getProtocolUri(uri: string): string | undefined {
        return this.docs.get(normalizeUriIdentity(uri))?.uri
    }

    getAll(): ReadonlyMap<string, DocumentInfo> {
        return new Map(Array.from(this.docs.values(), ({ uri, info }) => [uri, info]))
    }
}

function applyContentChange(content: string, change: ContentChange): string {
    if (change.range === undefined) {
        return change.text
    }
    const lines = content.split('\n')
    const startOffset = lineCharToOffset(lines, change.range.start.line, change.range.start.character)
    const endOffset = lineCharToOffset(lines, change.range.end.line, change.range.end.character)
    return content.slice(0, startOffset) + change.text + content.slice(endOffset)
}

export function computeDocumentEnd(content: string): {
    line: number
    character: number
} {
    const lines = content.split('\n')
    const lastLine = lines.length - 1
    const lastLineLength = lines[lastLine]!.length
    return { line: lastLine, character: lastLineLength }
}

function lineCharToOffset(lines: string[], line: number, character: number): number {
    let offset = 0
    for (let i = 0; i < line && i < lines.length; i++) {
        offset += lines[i]!.length + 1
    }
    return offset + character
}
