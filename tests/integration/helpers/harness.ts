import { vi } from 'vitest'

export type MockConnection = {
    sendRequest: ReturnType<typeof vi.fn>
    sendNotification: ReturnType<typeof vi.fn>
    onRequest: ReturnType<typeof vi.fn>
    onNotification: ReturnType<typeof vi.fn>
    onClose: ReturnType<typeof vi.fn>
    listen: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    triggerRequest: (method: string, params?: unknown) => Promise<unknown>
    triggerNotification: (method: string, params?: unknown) => void
    triggerClose: () => void
}

export function createDeferred<T>(): {
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

export function createMockConnection(): MockConnection {
    const requestHandlers = new Map<string, (params: unknown) => unknown>()
    const notificationHandlers = new Map<string, (params: unknown) => void>()
    const closeHandlers: Array<() => void> = []

    return {
        sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
        sendNotification: vi.fn(),
        onRequest: vi.fn((method: string, handler: (params: unknown) => unknown) => {
            requestHandlers.set(method, handler)
        }),
        onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
            notificationHandlers.set(method, handler)
        }),
        onClose: vi.fn((handler: () => void) => {
            closeHandlers.push(handler)
            return { dispose: () => {} }
        }),
        listen: vi.fn(),
        dispose: vi.fn(),
        triggerRequest: async (method: string, params?: unknown) => requestHandlers.get(method)?.(params),
        triggerNotification: (method: string, params?: unknown) => notificationHandlers.get(method)?.(params),
        triggerClose: () => {
            for (const handler of closeHandlers) handler()
        }
    }
}
