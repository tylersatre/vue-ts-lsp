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
    severity?: 1 | 2 | 3 | 4
    source?: string
    code?: string | number
}

export type ServerKey = 'vtsls' | 'vue_ls'

/** Identity for merge/dedupe across servers — extend here (e.g. code/source) in ONE place. */
export function diagnosticKey(diagnostic: Diagnostic): string {
    return `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.range.end.line}:${diagnostic.range.end.character}:${diagnostic.message}`
}

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

    remove(uri: string): void {
        this.store.delete(uri)
    }

    /** Drops one server's entries everywhere — its knowledge is stale after a crash restart. */
    clearServer(server: ServerKey): void {
        for (const diagnosticsByServer of this.store.values()) {
            diagnosticsByServer.delete(server)
        }
    }

    private merge(uri: string): Diagnostic[] {
        const diagnosticsByServer = this.store.get(uri)
        if (diagnosticsByServer === undefined) return []

        const seen = new Set<string>()
        const result: Diagnostic[] = []

        for (const diagnostics of diagnosticsByServer.values()) {
            for (const diagnostic of diagnostics) {
                const key = diagnosticKey(diagnostic)
                if (!seen.has(key)) {
                    seen.add(key)
                    result.push(diagnostic)
                }
            }
        }

        return result
    }
}
