import { normalizeUriIdentity } from './helpers/uri.js'

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
    private readonly store = new Map<string, { version?: number; byServer: Map<ServerKey, Diagnostic[]> }>()

    update(uri: string, server: ServerKey, diagnostics: Diagnostic[], version?: number): Diagnostic[] {
        uri = normalizeUriIdentity(uri)
        let entry = this.store.get(uri)
        if (entry === undefined) {
            entry = { version, byServer: new Map<ServerKey, Diagnostic[]>() }
            this.store.set(uri, entry)
        } else if (version !== undefined) {
            if (entry.version !== undefined && version < entry.version) return this.merge(uri)
            // A publish for new content cannot reuse another server's older snapshot.
            if (entry.version !== version) entry.byServer.clear()
            entry.version = version
        }
        entry.byServer.set(server, diagnostics)
        return this.merge(uri)
    }

    getVersion(uri: string): number | undefined {
        return this.store.get(normalizeUriIdentity(uri))?.version
    }

    remove(uri: string): void {
        this.store.delete(normalizeUriIdentity(uri))
    }

    /** Drops one server's entries everywhere — its knowledge is stale after a crash restart. */
    clearServer(server: ServerKey): void {
        for (const entry of this.store.values()) {
            entry.byServer.delete(server)
        }
    }

    private merge(uri: string): Diagnostic[] {
        const diagnosticsByServer = this.store.get(uri)?.byServer
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
