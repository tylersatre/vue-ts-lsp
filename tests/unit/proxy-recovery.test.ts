import { describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import { createProxyContext } from '@src/proxy-context.js'
import { recoverVueLs } from '@src/proxy-recovery.js'

type MockConnection = {
    sendRequest: ReturnType<typeof vi.fn>
    sendNotification: ReturnType<typeof vi.fn>
    onRequest: ReturnType<typeof vi.fn>
    onNotification: ReturnType<typeof vi.fn>
    onClose: ReturnType<typeof vi.fn>
    listen: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
}

function createMockConnection(): MockConnection {
    return {
        sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
        sendNotification: vi.fn(),
        onRequest: vi.fn(),
        onNotification: vi.fn(),
        onClose: vi.fn(),
        listen: vi.fn(),
        dispose: vi.fn()
    }
}

function createDeferred<T>(): {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
} {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve
        reject = innerReject
    })
    return { promise, resolve, reject }
}

describe('recoverVueLs', () => {
    it('waits for an active vtsls recovery before re-initializing vue_ls', async () => {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const vueLsConn = createMockConnection()
        const recoveredVueLs = createMockConnection()
        const pendingVtslsRecovery = createDeferred<void>()
        const spawnVueLs = vi.fn().mockReturnValue(recoveredVueLs)

        const ctx = createProxyContext(
            upstream as unknown as MessageConnection,
            vtslsConn as unknown as MessageConnection,
            vueLsConn as unknown as MessageConnection,
            {
                spawnVueLs: () => spawnVueLs() as unknown as MessageConnection,
                delayMs: 0
            }
        )

        ctx.savedInitParams = {
            processId: null,
            rootUri: 'file:///workspace',
            workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
            capabilities: {}
        }
        ctx.vtslsRecoveryPromise = pendingVtslsRecovery.promise

        const recovery = recoverVueLs(ctx, 'connection closed', () => {})
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(spawnVueLs).not.toHaveBeenCalled()

        pendingVtslsRecovery.resolve()
        await recovery

        expect(spawnVueLs).toHaveBeenCalledOnce()
        expect(recoveredVueLs.listen).toHaveBeenCalledOnce()
        expect(recoveredVueLs.sendRequest).toHaveBeenCalledWith('initialize', expect.anything())
    })
})
