import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setLogLevel, getLogLevel, error, warn, info, debug, initFileLogging, closeFileLogging } from '@src/logger.js'

function waitForLogFlush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50))
}

function removeFileIfPresent(filePath: string): void {
    try {
        fs.unlinkSync(filePath)
    } catch {}
}

describe('logger', () => {
    let stderrSpy: unknown
    let stdoutSpy: unknown

    beforeEach(() => {
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        setLogLevel('error')
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('setLogLevel / getLogLevel', () => {
        it('defaults to error', () => {
            expect(getLogLevel()).toBe('error')
        })

        it('updates the level', () => {
            setLogLevel('debug')
            expect(getLogLevel()).toBe('debug')
            setLogLevel('error')
            expect(getLogLevel()).toBe('error')
        })
    })

    describe('log level filtering', () => {
        it('error level: only error messages logged', () => {
            setLogLevel('error')
            error('proxy', 'an error')
            warn('proxy', 'a warning')
            info('proxy', 'an info')
            debug('proxy', 'a debug')
            expect(stderrSpy).toHaveBeenCalledTimes(1)
        })

        it('warn level: error and warn messages logged', () => {
            setLogLevel('warn')
            error('proxy', 'an error')
            warn('proxy', 'a warning')
            info('proxy', 'an info')
            debug('proxy', 'a debug')
            expect(stderrSpy).toHaveBeenCalledTimes(2)
        })

        it('info level: error, warn, info messages logged', () => {
            setLogLevel('info')
            error('proxy', 'an error')
            warn('proxy', 'a warning')
            info('proxy', 'an info')
            debug('proxy', 'a debug')
            expect(stderrSpy).toHaveBeenCalledTimes(3)
        })

        it('debug level: all messages logged', () => {
            setLogLevel('debug')
            error('proxy', 'an error')
            warn('proxy', 'a warning')
            info('proxy', 'an info')
            debug('proxy', 'a debug')
            expect(stderrSpy).toHaveBeenCalledTimes(4)
        })

        it('suppresses debug message when level is info', () => {
            setLogLevel('info')
            debug('proxy', 'should not appear')
            expect(stderrSpy).not.toHaveBeenCalled()
        })

        it('suppresses info and below when level is warn', () => {
            setLogLevel('warn')
            info('proxy', 'no')
            debug('proxy', 'no')
            expect(stderrSpy).not.toHaveBeenCalled()
        })
    })

    describe('log entry format', () => {
        it('includes timestamp in ISO format', () => {
            setLogLevel('error')
            error('proxy', 'test message')
            const output = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
            expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
        })

        it('includes level label in uppercase', () => {
            setLogLevel('debug')
            debug('proxy', 'test')
            const output = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
            expect(output).toContain('[DEBUG]')
        })

        it('includes source', () => {
            setLogLevel('info')
            info('vtsls', 'hello')
            const output = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
            expect(output).toContain('[vtsls]')
        })

        it('includes the message', () => {
            setLogLevel('error')
            error('proxy', 'something went wrong')
            const output = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
            expect(output).toContain('something went wrong')
        })

        it('ends with a newline', () => {
            setLogLevel('warn')
            warn('proxy', 'test')
            const output = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
            expect(output).toMatch(/\n$/)
        })

        it('formats as [timestamp] [LEVEL] [source] message', () => {
            setLogLevel('info')
            info('proxy', 'my message')
            const output = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
            expect(output).toMatch(/^\[.+\] \[INFO\] \[proxy\] my message\n$/)
        })
    })

    describe('stdout is never written', () => {
        it('error writes to stderr only', () => {
            setLogLevel('error')
            error('proxy', 'msg')
            expect(stdoutSpy).not.toHaveBeenCalled()
            expect(stderrSpy).toHaveBeenCalledTimes(1)
        })

        it('warn writes to stderr only', () => {
            setLogLevel('warn')
            warn('proxy', 'msg')
            expect(stdoutSpy).not.toHaveBeenCalled()
            expect(stderrSpy).toHaveBeenCalledTimes(1)
        })

        it('info writes to stderr only', () => {
            setLogLevel('info')
            info('proxy', 'msg')
            expect(stdoutSpy).not.toHaveBeenCalled()
            expect(stderrSpy).toHaveBeenCalledTimes(1)
        })

        it('debug writes to stderr only', () => {
            setLogLevel('debug')
            debug('proxy', 'msg')
            expect(stdoutSpy).not.toHaveBeenCalled()
            expect(stderrSpy).toHaveBeenCalledTimes(1)
        })

        it('suppressed messages write nothing at all (not even to stdout)', () => {
            setLogLevel('error')
            info('proxy', 'suppressed')
            debug('proxy', 'also suppressed')
            expect(stdoutSpy).not.toHaveBeenCalled()
            expect(stderrSpy).not.toHaveBeenCalled()
        })
    })

    describe('multiple sources', () => {
        it('logs with different source labels', () => {
            setLogLevel('info')
            info('proxy', 'proxy msg')
            info('vtsls', 'vtsls msg')
            info('vue_ls', 'vue_ls msg')
            const calls = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls
            expect(calls[0][0]).toContain('[proxy]')
            expect(calls[1][0]).toContain('[vtsls]')
            expect(calls[2][0]).toContain('[vue_ls]')
        })
    })

    describe('file logging', () => {
        let tmpLogFile: string

        beforeEach(() => {
            tmpLogFile = path.join(os.tmpdir(), `vue-ts-lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
        })

        afterEach(() => {
            closeFileLogging()
            removeFileIfPresent(tmpLogFile)
        })

        it('writes log entries to the file', async () => {
            initFileLogging(tmpLogFile)
            setLogLevel('error')
            error('proxy', 'file test')
            closeFileLogging()
            await waitForLogFlush()
            const content = fs.readFileSync(tmpLogFile, 'utf-8')
            expect(content).toContain('[ERROR]')
            expect(content).toContain('[proxy]')
            expect(content).toContain('file test')
        })

        it('respects log level filtering for file output', async () => {
            initFileLogging(tmpLogFile)
            setLogLevel('error')
            info('proxy', 'should not appear')
            closeFileLogging()
            await waitForLogFlush()
            const content = fs.readFileSync(tmpLogFile, 'utf-8')
            expect(content).toBe('')
        })

        it('writes the same content to file and stderr', async () => {
            initFileLogging(tmpLogFile)
            setLogLevel('info')
            info('proxy', 'dual write')
            const stderrOutput = (stderrSpy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
            closeFileLogging()
            await waitForLogFlush()
            const fileContent = fs.readFileSync(tmpLogFile, 'utf-8')
            expect(fileContent).toBe(stderrOutput)
        })

        it('stops writing after closeFileLogging', async () => {
            initFileLogging(tmpLogFile)
            setLogLevel('error')
            error('proxy', 'before close')
            closeFileLogging()
            await waitForLogFlush()
            error('proxy', 'after close')
            const content = fs.readFileSync(tmpLogFile, 'utf-8')
            expect(content).toContain('before close')
            expect(content).not.toContain('after close')
        })

        it('does not write to stdout with file logging active', () => {
            initFileLogging(tmpLogFile)
            setLogLevel('debug')
            error('proxy', 'msg')
            warn('proxy', 'msg')
            info('proxy', 'msg')
            debug('proxy', 'msg')
            expect(stdoutSpy).not.toHaveBeenCalled()
        })

        it('creates the directory if it does not exist', () => {
            const nestedPath = path.join(os.tmpdir(), `vue-ts-lsp-test-${Date.now()}`, 'nested', 'test.log')
            const tempRunDir = path.dirname(path.dirname(nestedPath))
            initFileLogging(nestedPath)
            closeFileLogging()
            expect(fs.existsSync(path.dirname(nestedPath))).toBe(true)
            fs.rmSync(tempRunDir, { recursive: true, force: true })
        })
    })
})
