import { describe, it, expect } from 'vitest'
import { inferReplacementProbeOffsets, clampOffset, uniqueSortedOffsets } from '@src/helpers/position-utils.js'

describe('clampOffset', () => {
    it('clamps into [0, length-1] and handles empty text', () => {
        expect(clampOffset(-3, 10)).toBe(0)
        expect(clampOffset(4, 10)).toBe(4)
        expect(clampOffset(25, 10)).toBe(9)
        expect(clampOffset(5, 0)).toBe(0)
    })
})

describe('uniqueSortedOffsets', () => {
    it('dedupes and sorts numerically', () => {
        expect(uniqueSortedOffsets([10, 2, 10, 1])).toEqual([1, 2, 10])
    })
})

describe('inferReplacementProbeOffsets', () => {
    it('returns null when old and new text are identical', () => {
        expect(inferReplacementProbeOffsets('same', 'same')).toBeNull()
    })

    it('locates a middle edit via shared prefix and suffix', () => {
        const result = inferReplacementProbeOffsets('const a = 1;', 'const ab = 1;')
        expect(result).not.toBeNull()
        // Shared prefix "const a" (7 chars), shared suffix " = 1;" — the probe
        // brackets the changed region in both documents.
        expect(result!.oldOffsets).toEqual([7])
        expect(result!.newOffsets).toEqual([7])
    })

    it('brackets a multi-character replacement with start and end probes', () => {
        const result = inferReplacementProbeOffsets('abcXYZdef', 'abc12345def')
        expect(result).not.toBeNull()
        expect(result!.oldOffsets).toEqual([3, 5])
        expect(result!.newOffsets).toEqual([3, 7])
    })

    it('handles pure insertions and pure deletions', () => {
        const insertion = inferReplacementProbeOffsets('ab', 'aXb')
        expect(insertion).not.toBeNull()
        expect(insertion!.newOffsets).toContain(1)

        const deletion = inferReplacementProbeOffsets('aXb', 'ab')
        expect(deletion).not.toBeNull()
        expect(deletion!.oldOffsets).toContain(1)
    })

    it('handles replacing the entire document', () => {
        const result = inferReplacementProbeOffsets('old', 'completely different')
        expect(result).not.toBeNull()
        expect(result!.oldOffsets[0]).toBe(0)
        expect(result!.newOffsets[0]).toBe(0)
    })
})
