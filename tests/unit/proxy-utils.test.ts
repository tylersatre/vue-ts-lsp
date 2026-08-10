import { describe, it, expect, afterEach } from 'vitest'
import { buildVtslsSettings } from '@src/proxy-utils.js'

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
