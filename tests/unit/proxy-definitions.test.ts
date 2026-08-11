import { describe, it, expect } from 'vitest'
import { offsetToPositionForRange, isVueShimUri, hasVueShimDefinition } from '@src/proxy-definitions.js'

describe('offsetToPositionForRange', () => {
    it('converts offsets to line/character positions', () => {
        const text = 'ab\ncde\nf'
        expect(offsetToPositionForRange(text, 0)).toEqual({ line: 0, character: 0 })
        expect(offsetToPositionForRange(text, 3)).toEqual({ line: 1, character: 0 })
        expect(offsetToPositionForRange(text, 5)).toEqual({ line: 1, character: 2 })
    })

    it('clamps offsets outside the document', () => {
        expect(offsetToPositionForRange('ab', -5)).toEqual({ line: 0, character: 0 })
        expect(offsetToPositionForRange('ab', 99)).toEqual({ line: 0, character: 2 })
    })
})

describe('isVueShimUri', () => {
    it('matches both shim naming conventions, including URI-encoded paths', () => {
        expect(isVueShimUri('file:///src/vue-shims.d.ts')).toBe(true)
        expect(isVueShimUri('file:///src/shims-vue.d.ts')).toBe(true)
        expect(isVueShimUri('file:///src%2Fshims-vue.d.ts')).toBe(true)
    })

    it('rejects regular declaration files', () => {
        expect(isVueShimUri('file:///src/global.d.ts')).toBe(false)
        expect(isVueShimUri('file:///src/App.vue')).toBe(false)
    })
})

describe('hasVueShimDefinition', () => {
    const location = (uri: string) => ({ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } })

    it('detects shim targets in single results and arrays', () => {
        expect(hasVueShimDefinition(location('file:///src/vue-shims.d.ts'))).toBe(true)
        expect(hasVueShimDefinition([location('file:///real/Component.vue'), location('file:///shims-vue.d.ts')])).toBe(true)
    })

    it('returns false for real definitions, null, and empty arrays', () => {
        expect(hasVueShimDefinition(location('file:///real/Component.vue'))).toBe(false)
        expect(hasVueShimDefinition(null)).toBe(false)
        expect(hasVueShimDefinition([])).toBe(false)
    })
})
