import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'

vi.mock('vscode-jsonrpc/node.js', () => {
    const mockConnection = {
        sendRequest: vi.fn(),
        sendNotification: vi.fn(),
        sendResponse: vi.fn(),
        onRequest: vi.fn(),
        onNotification: vi.fn(),
        listen: vi.fn(),
        dispose: vi.fn()
    }
    return {
        createMessageConnection: vi.fn(() => mockConnection),
        StreamMessageReader: vi.fn(),
        StreamMessageWriter: vi.fn()
    }
})

const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = await import('vscode-jsonrpc/node.js')
const { createUpstreamConnection } = await import('@src/upstream.js')

describe('createUpstreamConnection', () => {
    afterEach(() => {
        vi.clearAllMocks()
    })

    it('returns a MessageConnection with expected methods', () => {
        const connection = createUpstreamConnection()

        expect(connection).toBeDefined()
        expect(typeof connection.sendRequest).toBe('function')
        expect(typeof connection.sendNotification).toBe('function')
        expect(typeof connection.onRequest).toBe('function')
        expect(typeof connection.onNotification).toBe('function')
        expect(typeof connection.listen).toBe('function')
    })

    it('creates StreamMessageReader with process.stdin', () => {
        createUpstreamConnection()

        expect(StreamMessageReader).toHaveBeenCalledWith(process.stdin)
    })

    it('creates StreamMessageWriter with process.stdout', () => {
        createUpstreamConnection()

        expect(StreamMessageWriter).toHaveBeenCalledWith(process.stdout)
    })

    it('calls createMessageConnection with reader and writer', () => {
        createUpstreamConnection()

        const readerInstance = vi.mocked(StreamMessageReader).mock.instances[0]
        const writerInstance = vi.mocked(StreamMessageWriter).mock.instances[0]

        expect(createMessageConnection).toHaveBeenCalledWith(readerInstance, writerInstance)
    })

    it('calls listen() on the connection', () => {
        const connection = createUpstreamConnection()

        expect(connection.listen).toHaveBeenCalled()
    })

    it('does not write to stdout during connection creation', () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

        createUpstreamConnection()

        expect(stdoutSpy).not.toHaveBeenCalled()
        stdoutSpy.mockRestore()
    })

    it('uses mock streams independently of process.stdin/stdout internals', () => {
        const mockStdin = new PassThrough()
        const mockStdout = new PassThrough()
        const originalStdin = process.stdin
        const originalStdout = process.stdout

        Object.defineProperty(process, 'stdin', {
            value: mockStdin,
            configurable: true
        })
        Object.defineProperty(process, 'stdout', {
            value: mockStdout,
            configurable: true
        })

        const connection = createUpstreamConnection()

        expect(connection).toBeDefined()
        expect(StreamMessageReader).toHaveBeenCalledWith(mockStdin)
        expect(StreamMessageWriter).toHaveBeenCalledWith(mockStdout)

        Object.defineProperty(process, 'stdin', {
            value: originalStdin,
            configurable: true
        })
        Object.defineProperty(process, 'stdout', {
            value: originalStdout,
            configurable: true
        })
    })
})
