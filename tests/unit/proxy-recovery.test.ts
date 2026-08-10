import { describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { createProxyContext, type ProxyContext } from '@src/proxy-context.js'
import { recoverVtsls, recoverVueLs } from '@src/proxy-recovery.js'

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

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

const SAVED_INIT_PARAMS = {
    processId: null,
    rootUri: 'file:///workspace',
    workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
    capabilities: {}
}

function createVtslsRecoveryContext(options?: { maxRestarts?: number; windowMs?: number; recoveredConn?: MockConnection; killVtsls?: () => void }): {
    ctx: ProxyContext
    oldVtsls: MockConnection
    recoveredConn: MockConnection
    spawnVtsls: ReturnType<typeof vi.fn>
    spawnedKill: ReturnType<typeof vi.fn>
} {
    const upstream = createMockConnection()
    const oldVtsls = createMockConnection()
    const vueLsConn = createMockConnection()
    const recoveredConn = options?.recoveredConn ?? createMockConnection()
    const spawnedKill = vi.fn()
    const spawnVtsls = vi.fn().mockReturnValue({ conn: recoveredConn, kill: spawnedKill })

    const ctx = createProxyContext(
        upstream as unknown as MessageConnection,
        oldVtsls as unknown as MessageConnection,
        vueLsConn as unknown as MessageConnection,
        {
            spawnVtsls: () => spawnVtsls() as { conn: MessageConnection; kill: () => void },
            killVtsls: options?.killVtsls,
            delayMs: 0,
            maxRestarts: options?.maxRestarts,
            windowMs: options?.windowMs
        }
    )
    ctx.savedInitParams = SAVED_INIT_PARAMS
    ctx.savedVueTypescriptPluginLocation = '/mock/plugin'
    return { ctx, oldVtsls, recoveredConn, spawnVtsls, spawnedKill }
}

function didOpenCallsFor(conn: MockConnection, uri: string): unknown[][] {
    return conn.sendNotification.mock.calls.filter(
        (call) => call[0] === 'textDocument/didOpen' && (call[1] as { textDocument: { uri: string } }).textDocument.uri === uri
    )
}

describe('recoverVtsls', () => {
    it('replays every open document on the recovered connection', async () => {
        const { ctx, recoveredConn } = createVtslsRecoveryContext()
        ctx.documentStore.open('file:///workspace/a.ts', 'typescript', 1, 'const a = 1;')
        ctx.documentStore.open('file:///workspace/b.vue', 'vue', 3, '<template/>')

        await recoverVtsls(ctx, 'connection closed', () => {})

        expect(recoveredConn.sendRequest).toHaveBeenCalledWith('initialize', expect.anything())
        expect(didOpenCallsFor(recoveredConn, 'file:///workspace/a.ts')).toHaveLength(1)
        expect(didOpenCallsFor(recoveredConn, 'file:///workspace/b.vue')).toHaveLength(1)
        expect(ctx.currentVtsls).toBe(recoveredConn)
    })

    it('does not publish the recovered connection until initialize and replay complete', async () => {
        const { ctx, oldVtsls, recoveredConn } = createVtslsRecoveryContext()
        const initDeferred = createDeferred<unknown>()
        recoveredConn.sendRequest.mockReturnValue(initDeferred.promise)
        ctx.documentStore.open('file:///workspace/a.ts', 'typescript', 1, 'const a = 1;')

        const recovery = recoverVtsls(ctx, 'connection closed', () => {})
        await tick()

        // While the fresh child is still initializing, upstream notifications must keep
        // routing to the previous connection object, not the uninitialized one.
        expect(ctx.currentVtsls).toBe(oldVtsls)

        initDeferred.resolve({ capabilities: {} })
        await recovery

        expect(ctx.currentVtsls).toBe(recoveredConn)
        expect(didOpenCallsFor(recoveredConn, 'file:///workspace/a.ts')).toHaveLength(1)
    })

    it('never sends a mid-recovery didChange to the uninitialized connection and replays the changed content', async () => {
        const { ctx, recoveredConn } = createVtslsRecoveryContext()
        const initDeferred = createDeferred<unknown>()
        recoveredConn.sendRequest.mockReturnValue(initDeferred.promise)
        ctx.documentStore.open('file:///workspace/a.ts', 'typescript', 1, 'const a = 1;')

        const recovery = recoverVtsls(ctx, 'connection closed', () => {})
        await tick()

        // Simulate what the didChange lifecycle handler does mid-recovery: update the
        // store and forward to whatever connection ctx currently points at.
        ctx.documentStore.change('file:///workspace/a.ts', 2, [{ text: 'const a = 2;' }])
        ctx.currentVtsls.sendNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///workspace/a.ts', version: 2 },
            contentChanges: [{ text: 'const a = 2;' }]
        })

        initDeferred.resolve({ capabilities: {} })
        await recovery

        const didChangeCalls = recoveredConn.sendNotification.mock.calls.filter((call) => call[0] === 'textDocument/didChange')
        expect(didChangeCalls).toHaveLength(0)
        const replayed = didOpenCallsFor(recoveredConn, 'file:///workspace/a.ts')
        expect(replayed).toHaveLength(1)
        expect((replayed[0]![1] as { textDocument: { text: string } }).textDocument.text).toBe('const a = 2;')
    })

    it('replays a document opened mid-recovery exactly once on the recovered connection', async () => {
        const { ctx, recoveredConn } = createVtslsRecoveryContext()
        const initDeferred = createDeferred<unknown>()
        recoveredConn.sendRequest.mockReturnValue(initDeferred.promise)

        const recovery = recoverVtsls(ctx, 'connection closed', () => {})
        await tick()

        // Simulate what the didOpen lifecycle handler does mid-recovery.
        ctx.documentStore.open('file:///workspace/new.ts', 'typescript', 1, 'const fresh = true;')
        ctx.currentVtsls.sendNotification('textDocument/didOpen', {
            textDocument: { uri: 'file:///workspace/new.ts', languageId: 'typescript', version: 1, text: 'const fresh = true;' }
        })

        initDeferred.resolve({ capabilities: {} })
        await recovery

        expect(didOpenCallsFor(recoveredConn, 'file:///workspace/new.ts')).toHaveLength(1)
    })

    it('shows a message and does not spawn when the retry cap is reached', async () => {
        const { ctx, oldVtsls, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 0 })

        await recoverVtsls(ctx, 'connection closed', () => {})

        expect(spawnVtsls).not.toHaveBeenCalled()
        expect(ctx.currentVtsls).toBe(oldVtsls)
        expect((ctx.upstream as unknown as MockConnection).sendNotification).toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({ message: expect.stringContaining('crashed too many times') })
        )
    })

    it('kills and disposes the spawned child, leaving the old connection published, when initialize fails', async () => {
        const { ctx, oldVtsls, recoveredConn, spawnedKill } = createVtslsRecoveryContext({ maxRestarts: 1 })
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('initialize failed')

        expect(ctx.currentVtsls).toBe(oldVtsls)
        expect(spawnedKill).toHaveBeenCalled()
        expect(recoveredConn.dispose).toHaveBeenCalled()
    })

    it('gives up after consecutive failed attempts even when the retry window has slid', async () => {
        // RetryTracker's 30s sliding window cannot bound a chain whose attempts each
        // take longer than windowMs/maxRestarts — timestamps expire before the cap
        // trips. windowMs: 1 makes the window useless here on purpose: only the
        // consecutive-failure bound can stop the chain.
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 2, windowMs: 1 })
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('initialize failed')
        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(spawnVtsls).toHaveBeenCalledTimes(2)
        expect((ctx.upstream as unknown as MockConnection).sendNotification).toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({ message: expect.stringContaining('crashed too many times') })
        )
    })

    it('resets the consecutive-failure count once a recovery succeeds', async () => {
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 2, windowMs: 1 })
        const healthyConn = createMockConnection()
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))
        spawnVtsls.mockReturnValueOnce({ conn: recoveredConn, kill: vi.fn() }).mockReturnValue({ conn: healthyConn, kill: vi.fn() })

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('initialize failed')
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(ctx.currentVtsls).toBe(healthyConn)

        // A later crash starts from a clean slate: the earlier failure must not count.
        const nextConn = createMockConnection()
        spawnVtsls.mockReturnValue({ conn: nextConn, kill: vi.fn() })
        await recoverVtsls(ctx, 'connection closed', () => {})
        expect(ctx.currentVtsls).toBe(nextConn)
    })

    it('schedules another attempt after a failed recovery instead of dead-ending', async () => {
        // The old connection's onClose has already fired by the time recovery runs, so
        // nothing external will ever trigger another attempt — recovery must re-arm itself.
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext()
        const secondConn = createMockConnection()
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))
        spawnVtsls.mockReturnValueOnce({ conn: recoveredConn, kill: vi.fn() }).mockReturnValueOnce({ conn: secondConn, kill: vi.fn() })

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('initialize failed')
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(spawnVtsls).toHaveBeenCalledTimes(2)
        expect(ctx.currentVtsls).toBe(secondConn)
    })

    it('stops retrying failed recoveries once the retry cap is reached', async () => {
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 1 })
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('initialize failed')
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(spawnVtsls).toHaveBeenCalledTimes(1)
        expect((ctx.upstream as unknown as MockConnection).sendNotification).toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({ message: expect.stringContaining('crashed too many times') })
        )
    })
})

describe('recoverVueLs', () => {
    function createVueLsRecoveryContext(): { ctx: ProxyContext; oldVueLs: MockConnection; recoveredConn: MockConnection } {
        const upstream = createMockConnection()
        const vtslsConn = createMockConnection()
        const oldVueLs = createMockConnection()
        const recoveredConn = createMockConnection()
        const ctx = createProxyContext(
            upstream as unknown as MessageConnection,
            vtslsConn as unknown as MessageConnection,
            oldVueLs as unknown as MessageConnection,
            {
                spawnVueLs: () => recoveredConn as unknown as MessageConnection,
                delayMs: 0
            }
        )
        ctx.savedInitParams = SAVED_INIT_PARAMS
        return { ctx, oldVueLs, recoveredConn }
    }

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

    it('replays only .vue documents on the recovered connection', async () => {
        const { ctx, recoveredConn } = createVueLsRecoveryContext()
        ctx.documentStore.open('file:///workspace/a.ts', 'typescript', 1, 'const a = 1;')
        ctx.documentStore.open('file:///workspace/b.vue', 'vue', 1, '<template/>')

        await recoverVueLs(ctx, 'connection closed', () => {})

        expect(didOpenCallsFor(recoveredConn, 'file:///workspace/b.vue')).toHaveLength(1)
        expect(didOpenCallsFor(recoveredConn, 'file:///workspace/a.ts')).toHaveLength(0)
        expect(ctx.currentVueLs).toBe(recoveredConn)
    })

    it('still recovers vue_ls when the awaited vtsls recovery fails', async () => {
        const { ctx, recoveredConn } = createVueLsRecoveryContext()
        ctx.vtslsRecoveryPromise = Promise.reject(new Error('vtsls init boom'))
        ctx.vtslsRecoveryPromise.catch(() => {})

        await recoverVueLs(ctx, 'connection closed', () => {})

        expect(recoveredConn.sendRequest).toHaveBeenCalledWith('initialize', expect.anything())
        expect(ctx.currentVueLs).toBe(recoveredConn)
    })

    it('does not publish the recovered vue_ls connection until initialize and replay complete', async () => {
        const { ctx, oldVueLs, recoveredConn } = createVueLsRecoveryContext()
        const initDeferred = createDeferred<unknown>()
        recoveredConn.sendRequest.mockReturnValue(initDeferred.promise)

        const recovery = recoverVueLs(ctx, 'connection closed', () => {})
        await tick()

        expect(ctx.currentVueLs).toBe(oldVueLs)

        initDeferred.resolve({ capabilities: {} })
        await recovery

        expect(ctx.currentVueLs).toBe(recoveredConn)
    })
})
