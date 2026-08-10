import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TextDocumentSyncKind } from 'vscode-languageserver-protocol'
import type { MessageConnection } from 'vscode-jsonrpc/node'

vi.mock('node:module', () => ({
    createRequire: vi.fn(() =>
        Object.assign(vi.fn(), {
            resolve: () => '/mock/vue-language-server/dist/index.cjs'
        })
    )
}))

import * as logger from '@src/logger.js'
vi.mock('@src/logger.js', () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    setLogLevel: vi.fn(),
    closeFileLogging: vi.fn().mockResolvedValue(undefined)
}))

import { createMockConnection, createDeferred, type MockConnection } from './helpers/harness.js'

const { setupProxy } = await import('@src/proxy.js')

const VUE_FIXTURE = `<template>
  <div class="container">
    <button @click="handleClick" v-if="isVisible">
      {{ label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  label: string
  initialCount?: number
}>()

const emit = defineEmits<{
  (e: 'click', count: number): void
}>()

const count = ref(props.initialCount ?? 0)
const isVisible = computed(() => count.value >= 0)

function handleClick() {
  count.value++
  emit('click', count.value)
}
</script>

<style scoped>
.container {
  padding: 1rem;
}
</style>`

const TS_FIXTURE = `import { ref, computed } from 'vue'
import type { Ref } from 'vue'

export interface AppState {
  count: number
  label: string
}

export function createState(initial: number): AppState {
  return { count: initial, label: 'default' }
}

function helper(value: number): number {
  return value * 2
}`

describe('didChange full-document replacement patching', () => {
    let upstream: MockConnection
    let vtslsConn: MockConnection
    let vueLsConn: MockConnection

    const initParams = {
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: {}
    }

    beforeEach(async () => {
        upstream = createMockConnection()
        vtslsConn = createMockConnection()
        vueLsConn = createMockConnection()

        setupProxy(upstream as unknown as MessageConnection, vtslsConn as unknown as MessageConnection, vueLsConn as unknown as MessageConnection)
        await upstream.triggerRequest('initialize', initParams)
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()
        vi.mocked(logger.debug).mockClear()
    })

    it('patches full-doc replacement with a range based on original content before forwarding to vtsls', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()

        const newContent = TS_FIXTURE + '\nexport const extra = true;'
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        const call = vtslsConn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
        expect(call).toBeDefined()
        const params = call![1] as {
            contentChanges: Array<{ range?: unknown; text: string }>
        }
        expect(params.contentChanges[0].range).toBeDefined()

        const range = params.contentChanges[0].range as {
            start: { line: number; character: number }
            end: { line: number; character: number }
        }
        expect(range.start).toEqual({ line: 0, character: 0 })

        const originalLines = TS_FIXTURE.split('\n')
        expect(range.end).toEqual({
            line: originalLines.length - 1,
            character: originalLines[originalLines.length - 1]!.length
        })
    })

    it('passes incremental changes through unchanged', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()

        const incrementalParams = {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 6 }
                    },
                    text: 'import'
                }
            ]
        }
        upstream.triggerNotification('textDocument/didChange', incrementalParams)

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didChange', incrementalParams)
    })

    it('patches full-doc replacement for .vue files and forwards to both servers', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///App.vue',
                languageId: 'vue',
                version: 1,
                text: VUE_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()
        vueLsConn.sendNotification.mockClear()

        const newContent = VUE_FIXTURE.replace('padding: 1rem;', 'padding: 1rem;\n  margin: 0;')
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///App.vue', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        const oldLines = VUE_FIXTURE.split('\n')
        const expectedEnd = {
            line: oldLines.length - 1,
            character: oldLines[oldLines.length - 1]!.length
        }

        for (const conn of [vtslsConn, vueLsConn]) {
            const call = conn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
            expect(call).toBeDefined()
            const params = call![1] as { contentChanges: Array<{ range?: unknown }> }
            const range = params.contentChanges[0].range as {
                start: { line: number; character: number }
                end: { line: number; character: number }
            }
            expect(range.start).toEqual({ line: 0, character: 0 })
            expect(range.end).toEqual(expectedEnd)
        }
    })

    it('keeps DocumentStore content in sync after patching forwarded changes', () => {
        const freshUp = createMockConnection()
        const freshVtsls = createMockConnection()
        const freshVueLs = createMockConnection()
        const store = setupProxy(
            freshUp as unknown as MessageConnection,
            freshVtsls as unknown as MessageConnection,
            freshVueLs as unknown as MessageConnection
        )

        freshUp.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        const newContent = TS_FIXTURE + '\n// added'
        freshUp.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        expect(store.get('file:///foo.ts')?.content).toBe(newContent)
    })

    it('logs when patching a full-doc replacement', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vi.mocked(logger.debug).mockClear()

        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: TS_FIXTURE + '\n' }]
        })

        expect(logger.debug).toHaveBeenCalledWith('proxy', expect.stringContaining('patched full-doc replacement'))
    })

    it('converts unknown-URI full-text didChange into a synthesized didOpen', () => {
        const params = {
            textDocument: { uri: 'file:///unknown.ts', version: 1 },
            contentChanges: [{ text: 'const x = 1;' }]
        }
        expect(() => {
            upstream.triggerNotification('textDocument/didChange', params)
        }).not.toThrow()

        expect(vtslsConn.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
            textDocument: { uri: 'file:///unknown.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' }
        })
    })

    it('uses the original content bounds when a file shrinks', () => {
        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///foo.ts',
                languageId: 'typescript',
                version: 1,
                text: TS_FIXTURE
            }
        })
        vtslsConn.sendNotification.mockClear()

        const shortContent = 'export const x = 1;'
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///foo.ts', version: 2 },
            contentChanges: [{ text: shortContent }]
        })

        const call = vtslsConn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
        const params = call![1] as { contentChanges: Array<{ range?: unknown }> }
        const range = params.contentChanges[0].range as {
            start: { line: number; character: number }
            end: { line: number; character: number }
        }

        const originalLines = TS_FIXTURE.split('\n')
        expect(range.end).toEqual({
            line: originalLines.length - 1,
            character: originalLines[originalLines.length - 1]!.length
        })
    })

    it('uses original bounds for the 392-line crash repro', () => {
        const originalLines = Array.from({ length: 391 }, (_, i) => `// line ${i + 1}`)
        originalLines.push('}')
        const originalContent = originalLines.join('\n') + '\n'

        upstream.triggerNotification('textDocument/didOpen', {
            textDocument: {
                uri: 'file:///misc.ts',
                languageId: 'typescript',
                version: 1,
                text: originalContent
            }
        })
        vtslsConn.sendNotification.mockClear()

        const newContent = originalContent + 'const badVar = true;\n'
        upstream.triggerNotification('textDocument/didChange', {
            textDocument: { uri: 'file:///misc.ts', version: 2 },
            contentChanges: [{ text: newContent }]
        })

        const call = vtslsConn.sendNotification.mock.calls.find((c) => c[0] === 'textDocument/didChange')
        const params = call![1] as { contentChanges: Array<{ range?: unknown }> }
        const range = params.contentChanges[0].range as {
            start: { line: number; character: number }
            end: { line: number; character: number }
        }

        expect(range.end).toEqual({ line: 392, character: 0 })
        expect(range.end.line).not.toBe(393)
    })
})
