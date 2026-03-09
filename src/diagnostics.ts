export interface DiagnosticPosition {
    line: number
    character: number
}

export interface DiagnosticRange {
    start: DiagnosticPosition
    end: DiagnosticPosition
}

export interface Diagnostic {
    range: DiagnosticRange
    message: string
}

export type ServerKey = 'vtsls' | 'vue_ls'

/** Merges vtsls and vue_ls diagnostics for the same URI and drops exact duplicates. */
export class DiagnosticsStore {
    private readonly store = new Map<string, Map<ServerKey, Diagnostic[]>>()

    update(uri: string, server: ServerKey, diagnostics: Diagnostic[]): Diagnostic[] {
        let diagnosticsByServer = this.store.get(uri)
        if (diagnosticsByServer === undefined) {
            diagnosticsByServer = new Map<ServerKey, Diagnostic[]>()
            this.store.set(uri, diagnosticsByServer)
        }
        diagnosticsByServer.set(server, diagnostics)
        return this.merge(uri)
    }

    private merge(uri: string): Diagnostic[] {
        const diagnosticsByServer = this.store.get(uri)
        if (diagnosticsByServer === undefined) return []

        const seen = new Set<string>()
        const result: Diagnostic[] = []

        for (const diagnostics of diagnosticsByServer.values()) {
            for (const diagnostic of diagnostics) {
                const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.range.end.line}:${diagnostic.range.end.character}:${diagnostic.message}`
                if (!seen.has(key)) {
                    seen.add(key)
                    result.push(diagnostic)
                }
            }
        }

        return result
    }
}
