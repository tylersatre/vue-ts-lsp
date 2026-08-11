import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { createProxyContext, type ProxyContext } from '@src/proxy-context.js'
import { recoverVtsls, recoverVueLs } from '@src/proxy-recovery.js'
import { setupVtslsHandlers, setupVueLsHandlers } from '@src/proxy-handlers.js'

type MockConnection = {
    sendRequest: ReturnType<typeof vi.fn>
    sendNotification: ReturnType<typeof vi.fn>
    onRequest: ReturnType<typeof vi.fn>
    onNotification: ReturnType<typeof vi.fn>
    onClose: ReturnType<typeof vi.fn>
    listen: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    triggerClose: () => void
    triggerNotification: (method: string, params?: unknown) => void
}

function createMockConnection(): MockConnection {
    const closeHandlers: Array<() => void> = []
    const notificationHandlers = new Map<string, (params: unknown) => void>()
    return {
        sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
        sendNotification: vi.fn(),
        onRequest: vi.fn(),
        onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
            notificationHandlers.set(method, handler)
        }),
        onClose: vi.fn((handler: () => void) => {
            closeHandlers.push(handler)
            return { dispose: () => {} }
        }),
        listen: vi.fn(),
        dispose: vi.fn(),
        triggerClose: () => {
            for (const handler of closeHandlers) handler()
        },
        triggerNotification: (method: string, params?: unknown) => notificationHandlers.get(method)?.(params)
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

function createVtslsRecoveryContext(options?: {
    maxRestarts?: number
    windowMs?: number
    stabilityWindowMs?: number
    recoveredConn?: MockConnection
    killVtsls?: () => void
    delayMs?: number
    requestTimeoutMs?: number
}): {
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
            delayMs: options?.delayMs ?? 0,
            maxRestarts: options?.maxRestarts,
            windowMs: options?.windowMs,
            stabilityWindowMs: options?.stabilityWindowMs,
            requestTimeoutMs: options?.requestTimeoutMs
        }
    )
    ctx.savedInitParams = SAVED_INIT_PARAMS
    ctx.savedVueTypescriptPluginLocation = '/mock/plugin'
    return { ctx, oldVtsls, recoveredConn, spawnVtsls, spawnedKill }
}

afterEach(() => {
    vi.useRealTimers()
})

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

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('retry cap reached')

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

    it('rejects and disposes a candidate that closes after accepting initialize but before replying', async () => {
        const { ctx, oldVtsls, recoveredConn, spawnedKill } = createVtslsRecoveryContext({ maxRestarts: 1 })
        recoveredConn.sendRequest.mockReturnValue(new Promise(() => {}))

        const recovery = recoverVtsls(ctx, 'connection closed', () => {})
        await tick()
        recoveredConn.triggerClose()

        await expect(recovery).rejects.toThrow('closed during initialization')
        expect(ctx.currentVtsls).toBe(oldVtsls)
        expect(spawnedKill).toHaveBeenCalledOnce()
        expect(recoveredConn.dispose).toHaveBeenCalledOnce()
    })

    it('times out and disposes a candidate that stays open without replying to initialize', async () => {
        vi.useFakeTimers()
        const { ctx, oldVtsls, recoveredConn, spawnedKill } = createVtslsRecoveryContext({ maxRestarts: 1, requestTimeoutMs: 25 })
        recoveredConn.sendRequest.mockReturnValue(new Promise(() => {}))

        const recovery = recoverVtsls(ctx, 'connection closed', () => {})
        const rejection = expect(recovery).rejects.toThrow('initialize timed out after 25ms')
        await vi.runAllTimersAsync()
        await rejection

        expect(ctx.currentVtsls).toBe(oldVtsls)
        expect(spawnedKill).toHaveBeenCalledOnce()
        expect(recoveredConn.dispose).toHaveBeenCalledOnce()
    })

    it('does not publish a candidate that replies and then closes before publication', async () => {
        const { ctx, oldVtsls, recoveredConn } = createVtslsRecoveryContext({ maxRestarts: 1 })
        recoveredConn.sendNotification.mockImplementation((method: string) => {
            if (method === 'initialized') recoveredConn.triggerClose()
        })

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('closed before publication')

        expect(ctx.currentVtsls).toBe(oldVtsls)
    })

    it('shares one successful recovery and publishes the initialized candidate exactly once', async () => {
        const { ctx, oldVtsls, recoveredConn, spawnVtsls } = createVtslsRecoveryContext()
        let current = oldVtsls as unknown as MessageConnection
        let publications = 0
        Object.defineProperty(ctx, 'currentVtsls', {
            configurable: true,
            get: () => current,
            set: (conn: MessageConnection) => {
                publications += 1
                current = conn
            }
        })

        const first = recoverVtsls(ctx, 'connection closed', () => {})
        const second = recoverVtsls(ctx, 'duplicate close', () => {})
        await Promise.all([first, second])

        expect(first).toBe(second)
        expect(spawnVtsls).toHaveBeenCalledOnce()
        expect(ctx.currentVtsls).toBe(recoveredConn)
        expect(publications).toBe(1)
    })

    it('gives up after consecutive failed attempts even when the retry window has slid', async () => {
        // RetryTracker's 30s sliding window cannot bound a chain whose attempts each
        // take longer than windowMs/maxRestarts — timestamps expire before the cap
        // trips. windowMs: 1 makes the window useless here on purpose: only the
        // consecutive-failure bound can stop the chain.
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 2, windowMs: 1 })
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))

        await expect(recoverVtsls(ctx, 'connection closed', () => {})).rejects.toThrow('initialize failed')

        expect(spawnVtsls).toHaveBeenCalledTimes(2)
        expect((ctx.upstream as unknown as MockConnection).sendNotification).toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({ message: expect.stringContaining('crashed too many times') })
        )
    })

    it('a failed attempt below the cap does not poison later recoveries', async () => {
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 2, windowMs: 1 })
        const healthyConn = createMockConnection()
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))
        spawnVtsls.mockReturnValueOnce({ conn: recoveredConn, kill: vi.fn() }).mockReturnValue({ conn: healthyConn, kill: vi.fn() })

        await recoverVtsls(ctx, 'connection closed', () => {})
        expect(ctx.currentVtsls).toBe(healthyConn)

        await new Promise((resolve) => setTimeout(resolve, 20))
        const nextConn = createMockConnection()
        spawnVtsls.mockReturnValue({ conn: nextConn, kill: vi.fn() })
        await recoverVtsls(ctx, 'connection closed', () => {})
        expect(ctx.currentVtsls).toBe(nextConn)
    })

    it('a close caused by a forced-kill restart does not consume the crash budget', async () => {
        // Timeout-triggered restarts kill the current child themselves; that close is
        // the recovery's own doing and must not count toward "crashed too many times".
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 1, windowMs: 1 })
        const replacement = createMockConnection()
        spawnVtsls.mockReset()
        // The published child's kill closes its connection synchronously, like a real SIGTERM would (eventually).
        const killFirst = vi.fn(() => {
            for (const [handler] of recoveredConn.onClose.mock.calls as Array<[() => void]>) {
                handler()
            }
        })
        spawnVtsls.mockReturnValueOnce({ conn: recoveredConn, kill: killFirst }).mockReturnValueOnce({ conn: replacement, kill: vi.fn() })

        await recoverVtsls(ctx, 'connection closed', () => {})
        expect(ctx.currentVtsls).toBe(recoveredConn)

        // Let the 1ms sliding window forget the first recovery — on a fast machine
        // both recoveries can otherwise land in the same millisecond and the second
        // is refused by RetryTracker, which is not what this test is about.
        await new Promise((resolve) => setTimeout(resolve, 5))

        await recoverVtsls(ctx, 'request timeout: textDocument/definition', () => {}, true)
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(ctx.currentVtsls).toBe(replacement)
        expect(ctx.vtslsConsecutiveRecoveryFailures).toBe(0)
        expect((ctx.upstream as unknown as MockConnection).sendNotification).not.toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({ message: expect.stringContaining('crashed too many times') })
        )
    })

    it('schedules another attempt after a failed recovery instead of dead-ending', async () => {
        // The old connection's onClose has already fired by the time recovery runs, so
        // nothing external will ever trigger another attempt — recovery must re-arm itself.
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext()
        const secondConn = createMockConnection()
        recoveredConn.sendRequest.mockRejectedValue(new Error('initialize failed'))
        spawnVtsls.mockReturnValueOnce({ conn: recoveredConn, kill: vi.fn() }).mockReturnValueOnce({ conn: secondConn, kill: vi.fn() })

        await recoverVtsls(ctx, 'connection closed', () => {})

        expect(spawnVtsls).toHaveBeenCalledTimes(2)
        expect(ctx.currentVtsls).toBe(secondConn)
    })

    it('gives up when replacements keep crashing shortly after successful recovery', async () => {
        // A child that initializes fine but dies e.g. 15s later defeats both the
        // sliding retry window (cycle > windowMs/maxRestarts) and any counter that
        // resets on publish. Only crashes after a stability period may reset.
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 2, windowMs: 1 })
        const conns = [recoveredConn, createMockConnection(), createMockConnection()]
        spawnVtsls.mockReset()
        for (const conn of conns) {
            spawnVtsls.mockReturnValueOnce({ conn, kill: vi.fn() })
        }

        await recoverVtsls(ctx, 'connection closed', () => {})
        expect(ctx.currentVtsls).toBe(conns[0])

        for (let i = 0; i < 2; i++) {
            conns[i]!.triggerClose()
            await new Promise((resolve) => setTimeout(resolve, 20))
        }

        expect(spawnVtsls).toHaveBeenCalledTimes(2)
        expect((ctx.upstream as unknown as MockConnection).sendNotification).toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({ message: expect.stringContaining('crashed too many times') })
        )
    })

    it('a crash after the stability window resets the give-up budget', async () => {
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 1, windowMs: 1, stabilityWindowMs: 30 })
        const secondConn = createMockConnection()
        spawnVtsls.mockReset()
        spawnVtsls.mockReturnValueOnce({ conn: recoveredConn, kill: vi.fn() }).mockReturnValueOnce({ conn: secondConn, kill: vi.fn() })

        await recoverVtsls(ctx, 'connection closed', () => {})
        expect(ctx.currentVtsls).toBe(recoveredConn)

        // The replacement stays healthy past the stability window before crashing.
        await new Promise((resolve) => setTimeout(resolve, 40))
        recoveredConn.triggerClose()
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(ctx.currentVtsls).toBe(secondConn)
        expect((ctx.upstream as unknown as MockConnection).sendNotification).not.toHaveBeenCalledWith(
            'window/showMessage',
            expect.objectContaining({ message: expect.stringContaining('crashed too many times') })
        )
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

    it('keeps an intentionally killed connection marked until its delayed close is observed', async () => {
        const { ctx, recoveredConn, spawnVtsls } = createVtslsRecoveryContext({ maxRestarts: 2, windowMs: 1 })
        const failedReplacement = createMockConnection()
        const healthyReplacement = createMockConnection()
        const healthyInit = createDeferred<unknown>()
        failedReplacement.sendRequest.mockRejectedValue(new Error('replacement initialize failed'))
        healthyReplacement.sendRequest.mockReturnValue(healthyInit.promise)

        const killPublished = vi.fn()
        spawnVtsls.mockReset()
        spawnVtsls
            .mockReturnValueOnce({ conn: recoveredConn, kill: killPublished })
            .mockReturnValueOnce({ conn: failedReplacement, kill: vi.fn() })
            .mockReturnValueOnce({ conn: healthyReplacement, kill: vi.fn() })

        await recoverVtsls(ctx, 'connection closed', () => {})
        await new Promise((resolve) => setTimeout(resolve, 5))
        const forcedRecovery = recoverVtsls(ctx, 'request timeout: textDocument/definition', () => {}, true)
        await tick()
        await tick()

        expect(killPublished).toHaveBeenCalledOnce()
        expect(spawnVtsls).toHaveBeenCalledTimes(3)
        recoveredConn.triggerClose()
        healthyInit.resolve({ capabilities: {} })
        await forcedRecovery
        await tick()

        expect(ctx.currentVtsls).toBe(healthyReplacement)
        expect(ctx.vtslsConsecutiveRecoveryFailures).toBe(1)
        expect(spawnVtsls).toHaveBeenCalledTimes(3)
    })

    it('ignores and does not retain diagnostics from the superseded connection during the force-kill delay', async () => {
        vi.useFakeTimers()
        const { ctx, oldVtsls } = createVtslsRecoveryContext({ delayMs: 50 })
        const vueLs = ctx.currentVueLs as unknown as MockConnection
        setupVtslsHandlers(ctx, oldVtsls as unknown as MessageConnection)
        setupVueLsHandlers(ctx, vueLs as unknown as MessageConnection)
        ctx.documentStore.open('file:///workspace/App.vue', 'vue', 1, '<template/>')

        oldVtsls.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///workspace/App.vue',
            diagnostics: [{ message: 'before recovery', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        })
        ;(ctx.upstream as unknown as MockConnection).sendNotification.mockClear()

        const recovery = recoverVtsls(ctx, 'request timeout: textDocument/definition', () => {}, true)
        oldVtsls.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///workspace/App.vue',
            diagnostics: [{ message: 'late stale result', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        })
        expect((ctx.upstream as unknown as MockConnection).sendNotification).not.toHaveBeenCalledWith('textDocument/publishDiagnostics', expect.anything())

        vueLs.triggerNotification('textDocument/publishDiagnostics', {
            uri: 'file:///workspace/App.vue',
            diagnostics: [{ message: 'current Vue result', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        })
        expect((ctx.upstream as unknown as MockConnection).sendNotification).toHaveBeenCalledWith(
            'textDocument/publishDiagnostics',
            expect.objectContaining({ diagnostics: [expect.objectContaining({ message: 'current Vue result' })] })
        )

        await vi.runAllTimersAsync()
        await recovery
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

    it('fails closed without spawning vue_ls when the bounded vtsls recovery chain gives up', async () => {
        const { ctx, recoveredConn } = createVueLsRecoveryContext()
        ctx.vtslsRecoveryPromise = Promise.reject(new Error('vtsls init boom'))
        ctx.vtslsRecoveryPromise.catch(() => {})

        await expect(recoverVueLs(ctx, 'connection closed', () => {})).rejects.toThrow('vtsls init boom')

        expect(recoveredConn.sendRequest).not.toHaveBeenCalled()
        expect(ctx.currentVueLs).not.toBe(recoveredConn)
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
