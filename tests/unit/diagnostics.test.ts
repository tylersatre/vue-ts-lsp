import { describe, it, expect, beforeEach } from 'vitest'
import { DiagnosticsStore, type Diagnostic } from '@src/diagnostics.js'

function makeDiag(startLine: number, startChar: number, endLine: number, endChar: number, message: string): Diagnostic {
    return {
        range: {
            start: { line: startLine, character: startChar },
            end: { line: endLine, character: endChar }
        },
        message
    }
}

describe('DiagnosticsStore', () => {
    let store: DiagnosticsStore

    beforeEach(() => {
        store = new DiagnosticsStore()
    })

    it('returns diagnostics from one server when the other has none', () => {
        const diag = makeDiag(0, 0, 0, 5, 'Error from vue_ls')
        const result = store.update('file:///App.vue', 'vue_ls', [diag])
        expect(result).toEqual([diag])
    })

    it('merges diagnostics from both servers', () => {
        const vtslsDiag = makeDiag(0, 0, 0, 5, 'Error from vtsls')
        const vueLsDiag = makeDiag(1, 2, 1, 8, 'Error from vue_ls')
        store.update('file:///App.vue', 'vtsls', [vtslsDiag])
        const result = store.update('file:///App.vue', 'vue_ls', [vueLsDiag])
        expect(result).toHaveLength(2)
        expect(result).toContainEqual(vtslsDiag)
        expect(result).toContainEqual(vueLsDiag)
    })

    it('deduplicates identical diagnostics from both servers', () => {
        const diag = makeDiag(0, 0, 0, 5, 'Same error')
        store.update('file:///App.vue', 'vtsls', [diag])
        const result = store.update('file:///App.vue', 'vue_ls', [diag])
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(diag)
    })

    it('does not deduplicate when only the message differs', () => {
        const diag1 = makeDiag(0, 0, 0, 5, 'Error A')
        const diag2 = makeDiag(0, 0, 0, 5, 'Error B')
        store.update('file:///App.vue', 'vtsls', [diag1])
        const result = store.update('file:///App.vue', 'vue_ls', [diag2])
        expect(result).toHaveLength(2)
    })

    it('does not deduplicate when only the range differs', () => {
        const diag1 = makeDiag(0, 0, 0, 5, 'Same message')
        const diag2 = makeDiag(1, 0, 1, 5, 'Same message')
        store.update('file:///App.vue', 'vtsls', [diag1])
        const result = store.update('file:///App.vue', 'vue_ls', [diag2])
        expect(result).toHaveLength(2)
    })

    it('clears one server diagnostics without affecting the other', () => {
        const vtslsDiag = makeDiag(0, 0, 0, 5, 'vtsls error')
        const vueLsDiag = makeDiag(1, 2, 1, 8, 'vue_ls error')
        store.update('file:///App.vue', 'vtsls', [vtslsDiag])
        store.update('file:///App.vue', 'vue_ls', [vueLsDiag])

        const result = store.update('file:///App.vue', 'vtsls', [])
        expect(result).toEqual([vueLsDiag])
    })

    it('returns empty array when all servers clear diagnostics', () => {
        const diag = makeDiag(0, 0, 0, 5, 'Error')
        store.update('file:///App.vue', 'vtsls', [diag])
        store.update('file:///App.vue', 'vue_ls', [diag])

        store.update('file:///App.vue', 'vtsls', [])
        const result = store.update('file:///App.vue', 'vue_ls', [])
        expect(result).toEqual([])
    })

    it('handles multiple URIs independently', () => {
        const diagApp = makeDiag(0, 0, 0, 5, 'Error in App')
        const diagButton = makeDiag(0, 0, 0, 5, 'Error in Button')
        store.update('file:///App.vue', 'vtsls', [diagApp])
        store.update('file:///Button.vue', 'vtsls', [diagButton])

        const resultApp = store.update('file:///App.vue', 'vue_ls', [])
        const resultButton = store.update('file:///Button.vue', 'vue_ls', [])

        expect(resultApp).toEqual([diagApp])
        expect(resultButton).toEqual([diagButton])
    })

    it('deduplicates multiple identical diagnostics within a single server update', () => {
        const diag = makeDiag(0, 0, 0, 5, 'Duplicate')
        const result = store.update('file:///App.vue', 'vtsls', [diag, diag])
        expect(result).toHaveLength(1)
    })
})
