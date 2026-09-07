import { afterEach, beforeEach, it, expect, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { createMockConnection, createDeferred } from './helpers/harness.js'
vi.mock('@src/logger.js', () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    setLogLevel: vi.fn(),
    closeFileLogging: vi.fn().mockResolvedValue(undefined)
}))
import { setupProxy } from '@src/proxy.js'
const uri = 'file:///App.vue'
const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'already fixed' }
let upstream: ReturnType<typeof createMockConnection>, ts: ReturnType<typeof createMockConnection>, vue: ReturnType<typeof createMockConnection>
beforeEach(() => {
    vi.useFakeTimers()
    upstream = createMockConnection()
    ts = createMockConnection()
    vue = createMockConnection()
    setupProxy(upstream as unknown as MessageConnection, ts as unknown as MessageConnection, vue as unknown as MessageConnection)
    upstream.triggerNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'vue', version: 1, text: '<template><div/></template>' } })
})
afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
})
function change() {
    upstream.triggerNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: '<template><span/></template>' }] })
}
function latestPublish() {
    return upstream.sendNotification.mock.calls.filter(([method]) => method === 'textDocument/publishDiagnostics').at(-1)![1]
}
it('does not promote late old Vue diagnostics to the current document version', () => {
    change()
    vue.triggerNotification('textDocument/publishDiagnostics', { uri, version: 1, diagnostics: [diagnostic] })
    ts.triggerNotification('textDocument/publishDiagnostics', { uri, diagnostics: [] })
    expect(latestPublish()).toEqual({ uri, version: 2, diagnostics: [] })
})
it('does not retain diagnostics cached before an edit in a current publish', () => {
    ts.triggerNotification('textDocument/publishDiagnostics', { uri, diagnostics: [diagnostic] })
    change()
    vue.triggerNotification('textDocument/publishDiagnostics', { uri, version: 2, diagnostics: [] })
    expect(latestPublish()).toEqual({ uri, version: 2, diagnostics: [] })
})
it('does not replace current cached diagnostics with an older publish', () => {
    change()
    vue.triggerNotification('textDocument/publishDiagnostics', { uri, version: 2, diagnostics: [diagnostic] })
    vue.triggerNotification('textDocument/publishDiagnostics', { uri, version: 1, diagnostics: [] })
    ts.triggerNotification('textDocument/publishDiagnostics', { uri, diagnostics: [] })
    expect(latestPublish()).toEqual({ uri, version: 2, diagnostics: [diagnostic] })
})
it('excludes cached pre-edit Vue diagnostics from a current pull', async () => {
    vue.triggerNotification('textDocument/publishDiagnostics', { uri, version: 1, diagnostics: [diagnostic] })
    change()
    ts.sendRequest.mockResolvedValue({ body: [] })
    expect(await upstream.triggerRequest('textDocument/diagnostic', { textDocument: { uri } })).toEqual({ kind: 'full', items: [] })
})
it('rejects a pull if the document changes while commands are in flight', async () => {
    const pending = createDeferred<unknown>()
    ts.sendRequest.mockReturnValue(pending.promise)
    const request = upstream.triggerRequest('textDocument/diagnostic', { textDocument: { uri } })
    change()
    pending.resolve({ body: [] })
    await expect(request).rejects.toMatchObject({ code: -32801 })
})
it('resets diagnostic versions when a late close publish precedes reopening', () => {
    upstream.triggerNotification('textDocument/didClose', { textDocument: { uri } })
    vue.triggerNotification('textDocument/publishDiagnostics', { uri, version: 5, diagnostics: [diagnostic] })
    upstream.triggerNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'vue', version: 1, text: '<template/>' } })
    ts.triggerNotification('textDocument/publishDiagnostics', { uri, diagnostics: [] })
    expect(latestPublish()).toEqual({ uri, version: 1, diagnostics: [] })
})
it('rejects a late previous-open publish newer than the reopened document version', () => {
    upstream.triggerNotification('textDocument/didClose', { textDocument: { uri } })
    upstream.triggerNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'vue', version: 1, text: '<template/>' } })
    vue.triggerNotification('textDocument/publishDiagnostics', { uri, version: 5, diagnostics: [diagnostic] })
    ts.triggerNotification('textDocument/publishDiagnostics', { uri, diagnostics: [] })
    expect(latestPublish()).toEqual({ uri, version: 1, diagnostics: [] })
})
it('merges equivalent URI spellings and clears every spelling on close', () => {
    const first = 'file:///App%20Test.vue',
        alias = 'file:///App Test.vue'
    upstream.triggerNotification('textDocument/didOpen', { textDocument: { uri: first, languageId: 'vue', version: 1, text: '<template/>' } })
    vue.triggerNotification('textDocument/publishDiagnostics', { uri: first, version: 1, diagnostics: [diagnostic] })
    ts.triggerNotification('textDocument/publishDiagnostics', { uri: alias, diagnostics: [] })
    expect(latestPublish()).toEqual({ uri: alias, version: 1, diagnostics: [diagnostic] })
    upstream.triggerNotification('textDocument/didClose', { textDocument: { uri: alias } })
    ts.triggerNotification('textDocument/publishDiagnostics', { uri: first, diagnostics: [] })
    expect(latestPublish()).toEqual({ uri: first, diagnostics: [] })
})
