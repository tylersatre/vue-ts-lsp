import { describe, it, expect } from 'vitest'
import { DocumentStore, computeDocumentEnd } from '@src/documents.js'

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

describe('DocumentStore', () => {
    it('open adds document to store', () => {
        const store = new DocumentStore()
        store.open('file:///foo.ts', 'typescript', 1, 'const x = 1;')
        expect(store.get('file:///foo.ts')).toEqual({
            content: 'const x = 1;',
            version: 1,
            languageId: 'typescript'
        })
    })

    it('open overwrites existing document', () => {
        const store = new DocumentStore()
        store.open('file:///foo.ts', 'typescript', 1, 'old')
        store.open('file:///foo.ts', 'typescript', 2, 'new')
        expect(store.get('file:///foo.ts')?.content).toBe('new')
        expect(store.get('file:///foo.ts')?.version).toBe(2)
    })

    it('close removes document from store', () => {
        const store = new DocumentStore()
        store.open('file:///foo.ts', 'typescript', 1, '')
        store.close('file:///foo.ts')
        expect(store.get('file:///foo.ts')).toBeUndefined()
    })

    it('close with unknown URI is a no-op', () => {
        const store = new DocumentStore()
        expect(() => store.close('file:///unknown.ts')).not.toThrow()
    })

    it('change updates content with full document replacement (no range)', () => {
        const store = new DocumentStore()
        store.open('file:///foo.ts', 'typescript', 1, 'const x = 1;')
        store.change('file:///foo.ts', 2, [{ text: 'const x = 2;' }])
        expect(store.get('file:///foo.ts')).toEqual({
            content: 'const x = 2;',
            version: 2,
            languageId: 'typescript'
        })
    })

    it('change updates version', () => {
        const store = new DocumentStore()
        store.open('file:///foo.ts', 'typescript', 1, 'hello')
        store.change('file:///foo.ts', 5, [{ text: 'hello' }])
        expect(store.get('file:///foo.ts')?.version).toBe(5)
    })

    it('change applies incremental patch', () => {
        const store = new DocumentStore()
        store.open('file:///foo.ts', 'typescript', 1, 'const x = 1;\nconst y = 2;')
        store.change('file:///foo.ts', 2, [
            {
                range: {
                    start: { line: 0, character: 10 },
                    end: { line: 0, character: 11 }
                },
                text: '42'
            }
        ])
        expect(store.get('file:///foo.ts')?.content).toBe('const x = 42;\nconst y = 2;')
    })

    it('change applies multiple incremental patches sequentially', () => {
        const store = new DocumentStore()
        store.open('file:///foo.ts', 'typescript', 1, 'abc')
        store.change('file:///foo.ts', 2, [
            {
                range: {
                    start: { line: 0, character: 2 },
                    end: { line: 0, character: 3 }
                },
                text: 'Z'
            },
            {
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 }
                },
                text: 'X'
            }
        ])
        expect(store.get('file:///foo.ts')?.content).toBe('XbZ')
    })

    it('change with unknown URI is a no-op', () => {
        const store = new DocumentStore()
        expect(() => store.change('file:///unknown.ts', 1, [{ text: 'x' }])).not.toThrow()
    })

    it('getAll returns all open documents', () => {
        const store = new DocumentStore()
        store.open('file:///a.ts', 'typescript', 1, 'a')
        store.open('file:///b.vue', 'vue', 2, 'b')
        const all = store.getAll()
        expect(all.size).toBe(2)
        expect(all.get('file:///a.ts')?.content).toBe('a')
        expect(all.get('file:///b.vue')?.content).toBe('b')
    })

    it('getAll excludes closed documents', () => {
        const store = new DocumentStore()
        store.open('file:///a.ts', 'typescript', 1, 'a')
        store.open('file:///b.ts', 'typescript', 1, 'b')
        store.close('file:///a.ts')
        expect(store.getAll().size).toBe(1)
    })
})

describe('computeDocumentEnd', () => {
    it('single-line content', () => {
        expect(computeDocumentEnd('const x = 1;')).toEqual({
            line: 0,
            character: 12
        })
    })

    it('multi-line content', () => {
        expect(computeDocumentEnd('line1\nline2\nline3')).toEqual({
            line: 2,
            character: 5
        })
    })

    it('content ending with newline', () => {
        expect(computeDocumentEnd('line1\nline2\n')).toEqual({
            line: 2,
            character: 0
        })
    })

    it('empty content', () => {
        expect(computeDocumentEnd('')).toEqual({ line: 0, character: 0 })
    })

    it('realistic .vue content', () => {
        const lines = VUE_FIXTURE.split('\n')
        const lastLine = lines[lines.length - 1]!
        expect(computeDocumentEnd(VUE_FIXTURE)).toEqual({
            line: lines.length - 1,
            character: lastLine.length
        })
    })
})
