import { describe, it, expect } from 'vitest'
import { findStoreToRefsBindingAtPosition, findPiniaStoreReturnedSymbol } from '@src/helpers/pinia.js'

const VUE_STORE_TO_REFS_FIXTURE = `<template>
  <div>{{ count }}</div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useCounterStore } from '@/stores/counter'

const counterStore = useCounterStore()
const { count, doubled: doubledLocal } = storeToRefs(counterStore)
</script>
`

const SETUP_STORE_FIXTURE = `import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useCounterStore = defineStore('counter', () => {
    const count = ref(0)
    const doubled = computed(() => count.value * 2)
    function increment() {
        count.value += 1
    }
    return { count, doubled, increment }
})
`

const OPTIONS_STORE_FIXTURE = `import { defineStore } from 'pinia'

export const useUiStore = defineStore('ui', {
    state: () => ({ activeTab: 'details' }),
    actions: {
        goToTab(slug: string) {
            this.activeTab = slug
        }
    }
})
`

describe('findStoreToRefsBindingAtPosition', () => {
    // Line 9 is `const { count, doubled: doubledLocal } = storeToRefs(counterStore)`.
    it('resolves a plain destructured binding to its store factory', () => {
        const match = findStoreToRefsBindingAtPosition(VUE_STORE_TO_REFS_FIXTURE, { line: 9, character: 9 })
        expect(match).toEqual({
            localName: 'count',
            propertyName: 'count',
            storeFactoryName: 'useCounterStore'
        })
    })

    it('resolves an aliased binding to the store property name', () => {
        const match = findStoreToRefsBindingAtPosition(VUE_STORE_TO_REFS_FIXTURE, { line: 9, character: 26 })
        expect(match).toEqual({
            localName: 'doubledLocal',
            propertyName: 'doubled',
            storeFactoryName: 'useCounterStore'
        })
    })

    it('returns null outside a storeToRefs destructuring', () => {
        expect(findStoreToRefsBindingAtPosition(VUE_STORE_TO_REFS_FIXTURE, { line: 8, character: 8 })).toBeNull()
        expect(findStoreToRefsBindingAtPosition('const { a } = other()', { line: 0, character: 8 })).toBeNull()
    })
})

describe('findPiniaStoreReturnedSymbol', () => {
    const storeUri = 'file:///workspace/stores/counter.ts'

    it('finds a returned ref in a setup store', () => {
        const match = findPiniaStoreReturnedSymbol(SETUP_STORE_FIXTURE, storeUri, 'useCounterStore', 'count')
        expect(match).not.toBeNull()
        expect(match!.name).toBe('count')
        expect(match!.uri).toBe(storeUri)
        expect(match!.selectionRange.start.line).toBe(4)
    })

    it('finds a returned function at its declaration', () => {
        const match = findPiniaStoreReturnedSymbol(SETUP_STORE_FIXTURE, storeUri, 'useCounterStore', 'increment')
        expect(match).not.toBeNull()
        expect(match!.name).toBe('increment')
        expect(match!.selectionRange.start.line).toBe(6)
    })

    it('resolves concise-arrow-body options-store state members', () => {
        // `state: () => ({ ... })` is the canonical Pinia idiom.
        const match = findPiniaStoreReturnedSymbol(OPTIONS_STORE_FIXTURE, 'file:///workspace/stores/ui.ts', 'useUiStore', 'activeTab')
        expect(match).not.toBeNull()
        expect(match!.name).toBe('activeTab')
    })

    it('does not resolve options-store actions (current limitation)', () => {
        expect(findPiniaStoreReturnedSymbol(OPTIONS_STORE_FIXTURE, 'file:///workspace/stores/ui.ts', 'useUiStore', 'goToTab')).toBeNull()
    })

    it('returns null for a property the store does not return', () => {
        expect(findPiniaStoreReturnedSymbol(SETUP_STORE_FIXTURE, storeUri, 'useCounterStore', 'missing')).toBeNull()
    })

    it('returns null when the factory name does not match', () => {
        expect(findPiniaStoreReturnedSymbol(SETUP_STORE_FIXTURE, storeUri, 'useOtherStore', 'count')).toBeNull()
    })
})
