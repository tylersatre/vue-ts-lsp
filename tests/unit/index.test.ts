import { describe, it, expect, vi, afterEach } from 'vitest'
import { hasExplicitLogLevelArg, installUnhandledRejectionGuard, parseArgs } from '@src/index.js'

describe('parseArgs', () => {
    it('defaults to logLevel:error', () => {
        expect(parseArgs([])).toMatchObject({ logLevel: 'error' })
    })

    it('parses --log-level=warn', () => {
        expect(parseArgs(['--log-level=warn'])).toMatchObject({ logLevel: 'warn' })
    })

    it('parses --log-level info (space-separated)', () => {
        expect(parseArgs(['--log-level', 'info'])).toMatchObject({
            logLevel: 'info'
        })
    })

    it('parses --log-level=debug', () => {
        expect(parseArgs(['--log-level=debug'])).toMatchObject({
            logLevel: 'debug'
        })
    })

    it('parses --log-level=error', () => {
        expect(parseArgs(['--log-level=error'])).toMatchObject({
            logLevel: 'error'
        })
    })

    it('ignores invalid log level, keeps default', () => {
        expect(parseArgs(['--log-level=verbose'])).toMatchObject({
            logLevel: 'error'
        })
    })

    it('ignores invalid space-separated log level', () => {
        expect(parseArgs(['--log-level', 'trace'])).toMatchObject({
            logLevel: 'error'
        })
    })

    it('returns both fields correctly with no args', () => {
        expect(parseArgs([])).toEqual({ logLevel: 'error' })
    })
})

describe('hasExplicitLogLevelArg', () => {
    it('returns true for valid equals-form log levels', () => {
        expect(hasExplicitLogLevelArg(['--log-level=debug'])).toBe(true)
    })

    it('returns true for valid space-separated log levels', () => {
        expect(hasExplicitLogLevelArg(['--log-level', 'warn'])).toBe(true)
    })

    it('returns false when no log-level flag is provided', () => {
        expect(hasExplicitLogLevelArg([])).toBe(false)
    })

    it('returns false for invalid log-level flags', () => {
        expect(hasExplicitLogLevelArg(['--log-level=trace'])).toBe(false)
        expect(hasExplicitLogLevelArg(['--log-level', 'verbose'])).toBe(false)
    })
})

describe('installUnhandledRejectionGuard', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('registers a handler that logs to stderr without exiting the process', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit called')
        })
        let handler: ((reason: unknown) => void) | undefined
        const onSpy = vi.spyOn(process, 'on').mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
            if (event === 'unhandledRejection') {
                handler = listener
            }
            return process
        })

        installUnhandledRejectionGuard()

        expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function))
        expect(handler).toBeDefined()
        expect(() => handler!(new Error('write EPIPE'))).not.toThrow()
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('write EPIPE'))
        expect(exitSpy).not.toHaveBeenCalled()
    })
})
