import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

vi.mock('node:child_process', () => ({
    spawn: vi.fn()
}))

const { spawn } = await import('node:child_process')
const { spawnServer, vtslsCommand, vueLsCommand } = await import('@src/spawn.js')

function createMockChild(): ChildProcess {
    const child = new EventEmitter() as unknown as ChildProcess
    ;(child as unknown as Record<string, unknown>).stdout = new PassThrough()
    ;(child as unknown as Record<string, unknown>).stdin = new PassThrough()
    ;(child as unknown as Record<string, unknown>).stderr = new PassThrough()
    return child
}

describe('spawnServer', () => {
    let exitSpy: unknown
    let stderrSpy: unknown

    beforeEach(() => {
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
            throw new Error('process.exit called')
        })
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns an object with conn and kill properties', () => {
        const mockChild = createMockChild()
        vi.mocked(spawn).mockReturnValue(mockChild)

        const result = spawnServer('some-binary', ['--stdio'])

        expect(result).toBeDefined()
        expect(typeof result.conn.sendRequest).toBe('function')
        expect(typeof result.conn.sendNotification).toBe('function')
        expect(typeof result.conn.onRequest).toBe('function')
        expect(typeof result.conn.onNotification).toBe('function')
        expect(typeof result.conn.listen).toBe('function')
        expect(typeof result.kill).toBe('function')
    })

    it('kill sends SIGTERM to child process', () => {
        const mockChild = createMockChild()
        ;(mockChild as unknown as Record<string, unknown>).kill = vi.fn()
        vi.mocked(spawn).mockReturnValue(mockChild)

        const { kill } = spawnServer('some-binary', ['--stdio'])
        kill()

        expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('spawns the child process with the provided command and args', () => {
        const mockChild = createMockChild()
        vi.mocked(spawn).mockReturnValue(mockChild)

        spawnServer('vtsls', ['--stdio'])

        expect(spawn).toHaveBeenCalledWith('vtsls', ['--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe']
        })
    })

    it('logs child stderr to process.stderr', () => {
        const mockChild = createMockChild()
        vi.mocked(spawn).mockReturnValue(mockChild)

        spawnServer('some-binary', ['--stdio'])

        const stderrStream = (mockChild as unknown as Record<string, PassThrough>).stderr
        stderrStream.emit('data', Buffer.from('error from child\n'))

        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('error from child'))
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('some-binary'))
    })

    it('calls process.exit(1) when child emits an error', () => {
        const mockChild = createMockChild()
        vi.mocked(spawn).mockReturnValue(mockChild)

        spawnServer('nonexistent-binary', ['--stdio'])

        expect(() => {
            mockChild.emit('error', new Error('spawn nonexistent-binary ENOENT'))
        }).toThrow('process.exit called')

        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('logs an error message before exiting on spawn failure', () => {
        const mockChild = createMockChild()
        vi.mocked(spawn).mockReturnValue(mockChild)

        spawnServer('missing-binary', ['--stdio'])

        expect(() => {
            mockChild.emit('error', new Error('spawn missing-binary ENOENT'))
        }).toThrow('process.exit called')

        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to spawn missing-binary'))
    })
})

describe('vtslsCommand', () => {
    it('resolves vtsls binary path with --stdio', () => {
        const { command, args } = vtslsCommand()
        expect(command).toBe(process.execPath)
        expect(args).toHaveLength(2)
        expect(args[0]).toMatch(/vtsls\.js$/)
        expect(args[1]).toBe('--stdio')
    })
})

describe('vueLsCommand', () => {
    it('resolves vue-language-server binary path with --stdio', () => {
        const { command, args } = vueLsCommand()
        expect(command).toBe(process.execPath)
        expect(args).toHaveLength(2)
        expect(args[0]).toMatch(/vue-language-server\.js$/)
        expect(args[1]).toBe('--stdio')
    })
})
