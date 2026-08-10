import { describe, it, expect, afterEach } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
    buildVtslsSettings,
    quickInfoToHover,
    mergeIncomingCallResults,
    flattenTsserverText,
    languageIdForUri,
    isScriptLikeUri,
    hoverValueLooksLoading,
    normalizeSpawnedConnection
} from '@src/proxy-utils.js'

function tsserverLogSetting(settings: ReturnType<typeof buildVtslsSettings>): string {
    return (settings as { typescript: { tsserver: { log: string } } }).typescript.tsserver.log
}

describe('buildVtslsSettings tsserver logging', () => {
    afterEach(() => {
        delete process.env['VUE_TS_LSP_TSSERVER_LOG']
    })

    it('defaults tsserver logging to off', () => {
        expect(tsserverLogSetting(buildVtslsSettings('/plugin'))).toBe('off')
    })

    it('honors VUE_TS_LSP_TSSERVER_LOG for debugging', () => {
        process.env['VUE_TS_LSP_TSSERVER_LOG'] = 'verbose'
        expect(tsserverLogSetting(buildVtslsSettings('/plugin'))).toBe('verbose')
    })

    it('accepts the other tsserver log levels', () => {
        for (const level of ['off', 'terse', 'normal', 'requestTime', 'verbose']) {
            process.env['VUE_TS_LSP_TSSERVER_LOG'] = level
            expect(tsserverLogSetting(buildVtslsSettings('/plugin'))).toBe(level)
        }
    })

    it('falls back to off for invalid values', () => {
        process.env['VUE_TS_LSP_TSSERVER_LOG'] = 'shouty'
        expect(tsserverLogSetting(buildVtslsSettings('/plugin'))).toBe('off')
    })
})

describe('isScriptLikeUri', () => {
    it('accepts ts/tsx/js/jsx and the cjs/mjs/cts/mts variants', () => {
        for (const ext of ['ts', 'tsx', 'js', 'jsx', 'cts', 'mts', 'cjs', 'mjs']) {
            expect(isScriptLikeUri(`file:///a/b/mod.${ext}`)).toBe(true)
        }
    })

    it('rejects vue, css, json, and extensionless URIs', () => {
        expect(isScriptLikeUri('file:///a/App.vue')).toBe(false)
        expect(isScriptLikeUri('file:///a/style.css')).toBe(false)
        expect(isScriptLikeUri('file:///a/data.json')).toBe(false)
        expect(isScriptLikeUri('file:///a/Makefile')).toBe(false)
    })

    it('only looks at the filename, not directory names', () => {
        expect(isScriptLikeUri('file:///weird.ts/readme.md')).toBe(false)
    })
})

describe('languageIdForUri', () => {
    it('maps each extension to its language id', () => {
        expect(languageIdForUri('file:///App.vue')).toBe('vue')
        expect(languageIdForUri('file:///a.tsx')).toBe('typescriptreact')
        expect(languageIdForUri('file:///a.jsx')).toBe('javascriptreact')
        expect(languageIdForUri('file:///a.js')).toBe('javascript')
        expect(languageIdForUri('file:///a.cjs')).toBe('javascript')
        expect(languageIdForUri('file:///a.mjs')).toBe('javascript')
        expect(languageIdForUri('file:///a.ts')).toBe('typescript')
        expect(languageIdForUri('file:///a.mts')).toBe('typescript')
    })
})

describe('hoverValueLooksLoading', () => {
    it('detects the loading marker in strings, arrays, and nested hover shapes', () => {
        expect(hoverValueLooksLoading('module "(loading...)"')).toBe(true)
        expect(hoverValueLooksLoading(['fine', 'still Loading...'])).toBe(true)
        expect(hoverValueLooksLoading({ contents: { kind: 'markdown', value: '(loading...)' } })).toBe(true)
        expect(hoverValueLooksLoading({ value: 'loading...' })).toBe(true)
    })

    it('returns false for settled hovers and non-objects', () => {
        expect(hoverValueLooksLoading('const x: number')).toBe(false)
        expect(hoverValueLooksLoading(null)).toBe(false)
        expect(hoverValueLooksLoading(42)).toBe(false)
        expect(hoverValueLooksLoading({ contents: 'const x: number' })).toBe(false)
    })
})

describe('flattenTsserverText', () => {
    it('passes strings through and joins display parts', () => {
        expect(flattenTsserverText('plain')).toBe('plain')
        expect(
            flattenTsserverText([
                { text: 'const', kind: 'keyword' },
                { text: ' x', kind: 'localName' }
            ])
        ).toBe('const x')
    })

    it('ignores malformed entries and non-arrays', () => {
        expect(flattenTsserverText([{ text: 'ok' }, { notText: 'skip' }, null])).toBe('ok')
        expect(flattenTsserverText(undefined)).toBe('')
        expect(flattenTsserverText({ text: 'not-an-array' })).toBe('')
    })
})

describe('quickInfoToHover', () => {
    it('renders displayString as a ts code fence', () => {
        const hover = quickInfoToHover({ displayString: 'const x: number' })
        expect(hover.contents.kind).toBe('markdown')
        expect(hover.contents.value).toBe('```ts\nconst x: number\n```')
    })

    it('appends documentation and JSDoc tags as sections', () => {
        const hover = quickInfoToHover({
            displayString: 'function f(): void',
            documentation: [{ text: 'Does things.' }],
            tags: [
                { name: 'deprecated', text: [{ text: 'use g' }] },
                { name: 'internal' }
            ]
        })
        expect(hover.contents.value).toBe('```ts\nfunction f(): void\n```\n\nDoes things.\n\n@deprecated use g\n@internal')
    })
})

describe('mergeIncomingCallResults', () => {
    const item = (uri: string) => ({ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, name: 'f', kind: 12, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } })
    const span = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 5 } })

    it('returns the initial result untouched when it is not an array or fallback is empty', () => {
        expect(mergeIncomingCallResults(null, [{ from: item('file:///a.ts'), fromSpans: [] }])).toBeNull()
        const initial = [{ from: item('file:///a.ts'), fromSpans: [span(1)] }]
        expect(mergeIncomingCallResults(initial, [])).toBe(initial)
    })

    it('appends fallback calls from new callers', () => {
        const initial = [{ from: item('file:///a.ts'), fromSpans: [span(1)] }]
        const merged = mergeIncomingCallResults(initial, [{ from: item('file:///b.ts'), fromSpans: [span(2)] }]) as unknown[]
        expect(merged).toHaveLength(2)
    })

    it('merges fromSpans into an existing caller in place (documented aliasing)', () => {
        const existingEntry = { from: item('file:///a.ts'), fromSpans: [span(1)] }
        const merged = mergeIncomingCallResults([existingEntry], [{ from: item('file:///a.ts'), fromSpans: [span(1), span(3)] }]) as Array<{
            fromSpans: unknown[]
        }>

        expect(merged).toHaveLength(1)
        expect(merged[0]!.fromSpans).toHaveLength(2)
        // The merge intentionally mutates the entry borrowed from the initial result —
        // this pin exists so any future change to that contract is deliberate.
        expect(existingEntry.fromSpans).toHaveLength(2)
    })
})

describe('normalizeSpawnedConnection', () => {
    it('unwraps a {conn, kill} result', () => {
        const conn = { listen: () => {} } as unknown as MessageConnection
        const kill = () => {}
        expect(normalizeSpawnedConnection({ conn, kill })).toEqual({ conn, kill })
    })

    it('wraps a bare connection', () => {
        const conn = { listen: () => {} } as unknown as MessageConnection
        expect(normalizeSpawnedConnection(conn)).toEqual({ conn })
    })
})
