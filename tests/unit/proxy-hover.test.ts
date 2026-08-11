import { describe, it, expect } from 'vitest'
import { getLineAtPosition, isMacroHoverFallbackCandidate, hoverNeedsFallback } from '@src/proxy-hover.js'

describe('getLineAtPosition', () => {
    it('returns the line at the position', () => {
        expect(getLineAtPosition('a\nb\nc', { line: 1, character: 0 })).toBe('b')
    })

    it('returns an empty string past the end of the document', () => {
        expect(getLineAtPosition('a\nb', { line: 9, character: 0 })).toBe('')
    })
})

describe('isMacroHoverFallbackCandidate', () => {
    it.each([
        'const props = defineProps<{ x: number }>()',
        'const emit = defineEmits<{ change: [] }>()',
        'defineSlots<{ default: void }>()',
        'const model = defineModel<string>()',
        'const props = withDefaults(defineProps<P>(), {})',
        'const { count } = storeToRefs(store)'
    ])('matches macro line %s', (line) => {
        expect(isMacroHoverFallbackCandidate(line, { line: 0, character: 0 })).toBe(true)
    })

    it('rejects ordinary code and near-miss identifiers', () => {
        expect(isMacroHoverFallbackCandidate('const definePropsish = 1', { line: 0, character: 0 })).toBe(false)
        expect(isMacroHoverFallbackCandidate('const x = compute(a, b)', { line: 0, character: 0 })).toBe(false)
    })

    it('only inspects the line under the cursor', () => {
        const text = 'const props = defineProps<P>()\nconst x = 1'
        expect(isMacroHoverFallbackCandidate(text, { line: 1, character: 0 })).toBe(false)
    })
})

describe('hoverNeedsFallback', () => {
    it('needs a fallback for null and loading results', () => {
        expect(hoverNeedsFallback(null, false)).toBe(true)
        expect(hoverNeedsFallback({ contents: '(loading...)' }, false)).toBe(true)
    })

    it('accepts a settled hover', () => {
        expect(hoverNeedsFallback({ contents: 'const x: number' }, false)).toBe(false)
    })

    it('treats any-typed hovers as poor only when asked to', () => {
        const anyHover = { contents: { kind: 'markdown', value: '```ts\nconst x: any\n```' } }
        expect(hoverNeedsFallback(anyHover, false)).toBe(false)
        expect(hoverNeedsFallback(anyHover, true)).toBe(true)
    })
})
