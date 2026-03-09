import { describe, it, expect } from 'vitest'
import { routeRequest } from '@src/router.js'

function uri(filename: string) {
    return { textDocument: { uri: `file:///workspace/${filename}` } }
}

describe('routeRequest - workspace/symbol', () => {
    it('routes workspace/symbol to vtsls regardless of params', () => {
        expect(routeRequest('workspace/symbol', null)).toBe('vtsls')
        expect(routeRequest('workspace/symbol', {})).toBe('vtsls')
        expect(routeRequest('workspace/symbol', { query: 'foo' })).toBe('vtsls')
    })
})

describe('routeRequest - .ts/.js/.tsx/.jsx files', () => {
    const tsRelatedMethods = [
        'textDocument/definition',
        'textDocument/hover',
        'textDocument/references',
        'textDocument/implementation',
        'textDocument/documentSymbol',
        'textDocument/prepareCallHierarchy',
        'callHierarchy/incomingCalls',
        'callHierarchy/outgoingCalls'
    ]

    for (const ext of ['.ts', '.js', '.tsx', '.jsx']) {
        for (const method of tsRelatedMethods) {
            it(`routes ${method} for ${ext} file to vtsls`, () => {
                expect(routeRequest(method, uri(`Component${ext}`))).toBe('vtsls')
            })
        }

        it(`routes unknown method for ${ext} file to vtsls`, () => {
            expect(routeRequest('textDocument/formatting', uri(`file${ext}`))).toBe('vtsls')
        })
    }
})

describe('routeRequest - .vue files with TS-related methods', () => {
    const tsVueMethods = [
        'textDocument/definition',
        'textDocument/implementation',
        'textDocument/hover',
        'textDocument/references',
        'textDocument/prepareCallHierarchy',
        'callHierarchy/incomingCalls',
        'callHierarchy/outgoingCalls'
    ]

    for (const method of tsVueMethods) {
        it(`routes ${method} for .vue file to vtsls`, () => {
            expect(routeRequest(method, uri('App.vue'))).toBe('vtsls')
        })
    }
})

describe('routeRequest - .vue files with non-TS methods', () => {
    const nonTsMethods = [
        'textDocument/documentSymbol',
        'textDocument/formatting',
        'textDocument/rangeFormatting',
        'textDocument/completion',
        'textDocument/rename',
        'textDocument/codeLens',
        'textDocument/foldingRange',
        'textDocument/colorPresentation'
    ]

    for (const method of nonTsMethods) {
        it(`routes ${method} for .vue file to vue_ls`, () => {
            expect(routeRequest(method, uri('App.vue'))).toBe('vue_ls')
        })
    }
})

describe('routeRequest - edge cases', () => {
    it('falls back to vtsls when params is null', () => {
        expect(routeRequest('textDocument/definition', null)).toBe('vtsls')
    })

    it('falls back to vtsls when params has no textDocument', () => {
        expect(
            routeRequest('textDocument/definition', {
                position: { line: 0, character: 0 }
            })
        ).toBe('vtsls')
    })

    it('falls back to vtsls when textDocument has no uri', () => {
        expect(routeRequest('textDocument/definition', { textDocument: {} })).toBe('vtsls')
    })

    it('falls back to vtsls when uri is not a string', () => {
        expect(routeRequest('textDocument/definition', { textDocument: { uri: 42 } })).toBe('vtsls')
    })

    it('falls back to vtsls for unknown extension', () => {
        expect(routeRequest('textDocument/hover', uri('style.css'))).toBe('vtsls')
    })

    it('falls back to vtsls for file with no extension', () => {
        expect(routeRequest('textDocument/hover', uri('Makefile'))).toBe('vtsls')
    })

    it('falls back to vtsls for unrecognized method with no URI', () => {
        expect(routeRequest('unknown/method', null)).toBe('vtsls')
    })

    it('falls back to vtsls for a query-string .vue URI', () => {
        const params = {
            textDocument: { uri: 'file:///workspace/App.vue?version=1' }
        }
        expect(routeRequest('textDocument/completion', params)).toBe('vtsls')
    })

    it('handles URI that is just a filename (no slashes)', () => {
        const params = { textDocument: { uri: 'App.vue' } }
        expect(routeRequest('textDocument/hover', params)).toBe('vtsls')
    })
})
