import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'

vi.mock('@src/logger.js', () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    setLogLevel: vi.fn()
}))

import * as logger from '@src/logger.js'
const { safeSendNotification } = await import('@src/proxy-communication.js')

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('safeSendNotification', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('forwards method and params to the connection', () => {
        const conn = { sendNotification: vi.fn().mockResolvedValue(undefined) }
        safeSendNotification(conn as unknown as MessageConnection, 'textDocument/didChange', { some: 'params' })
        expect(conn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', { some: 'params' })
    })

    it('logs and swallows an asynchronous write failure (EPIPE to a dead child)', async () => {
        const conn = { sendNotification: vi.fn().mockRejectedValue(new Error('write EPIPE')) }
        safeSendNotification(conn as unknown as MessageConnection, 'textDocument/didChange', {})
        await tick()
        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('textDocument/didChange'))
        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('write EPIPE'))
    })

    it('logs and swallows a synchronous throw (disposed connection)', () => {
        const conn = {
            sendNotification: vi.fn(() => {
                throw new Error('connection disposed')
            })
        }
        expect(() => safeSendNotification(conn as unknown as MessageConnection, 'tsserver/response', [1, null])).not.toThrow()
        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('connection disposed'))
    })

    it('uses the label in the failure log when provided', async () => {
        const conn = { sendNotification: vi.fn().mockRejectedValue(new Error('write EPIPE')) }
        safeSendNotification(conn as unknown as MessageConnection, 'tsserver/response', [42, null], 'tsserver/response #42')
        await tick()
        expect(logger.warn).toHaveBeenCalledWith('proxy', expect.stringContaining('tsserver/response #42'))
    })

    it('handles a connection whose sendNotification returns void (mock connections)', () => {
        const conn = { sendNotification: vi.fn() }
        expect(() => safeSendNotification(conn as unknown as MessageConnection, 'initialized', {})).not.toThrow()
        expect(logger.warn).not.toHaveBeenCalled()
    })
})

const { tryRequest } = await import('@src/proxy-communication.js')
const { createProxyContext } = await import('@src/proxy-context.js')
const { DownstreamRequestTimeoutError } = await import('@src/proxy-types.js')

describe('tryRequest', () => {
    function createCtx(vtsls: { sendRequest: ReturnType<typeof vi.fn> }) {
        const conn = () =>
            ({
                sendRequest: vi.fn().mockResolvedValue(null),
                sendNotification: vi.fn(),
                onRequest: vi.fn(),
                onNotification: vi.fn(),
                onClose: vi.fn(),
                listen: vi.fn(),
                dispose: vi.fn()
            }) as unknown as MessageConnection
        return createProxyContext(conn(), { ...(conn() as object), sendRequest: vtsls.sendRequest } as unknown as MessageConnection, conn())
    }

    it('returns the downstream result on success', async () => {
        const sendRequest = vi.fn().mockResolvedValue({ ok: true })
        const ctx = createCtx({ sendRequest })
        await expect(tryRequest(ctx, 'vtsls', 'textDocument/definition', { p: 1 }, 50)).resolves.toEqual({ result: { ok: true }, timedOut: false })
    })

    it('swallows a downstream timeout into { result: null, timedOut: true }', async () => {
        const sendRequest = vi.fn().mockReturnValue(new Promise(() => {}))
        const ctx = createCtx({ sendRequest })
        await expect(tryRequest(ctx, 'vtsls', 'textDocument/hover', {}, 10)).resolves.toEqual({ result: null, timedOut: true })
    })

    it('rethrows non-timeout errors', async () => {
        const sendRequest = vi.fn().mockRejectedValue(new Error('boom'))
        const ctx = createCtx({ sendRequest })
        await expect(tryRequest(ctx, 'vtsls', 'textDocument/hover', {}, 50)).rejects.toThrow('boom')
        expect(DownstreamRequestTimeoutError).toBeDefined()
    })
})
