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
    private readonly docs = new Map<string, DocumentInfo>()

    open(uri: string, languageId: string, version: number, content: string): void {
        this.docs.set(uri, { content, version, languageId })
    }

    change(uri: string, version: number, changes: ContentChange[]): void {
        const document = this.docs.get(uri)
        if (document === undefined) return
        let content = document.content
        for (const change of changes) {
            content = applyContentChange(content, change)
        }
        document.content = content
        document.version = version
    }

    close(uri: string): void {
        this.docs.delete(uri)
    }

    get(uri: string): DocumentInfo | undefined {
        return this.docs.get(uri)
    }

    getAll(): ReadonlyMap<string, DocumentInfo> {
        return this.docs
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
