import type { VisibilityMap } from 'Domain/types'
import { buildScenarioSnapshot } from 'App/utils/misc'
import { defineStore } from 'pinia'

export const useSelectionStore = defineStore('selection', {
    state: () => ({
        snapshot: buildScenarioSnapshot(),
        expandedGroups: {
            setup: true,
            support: true
        } as VisibilityMap,
        pinned: false
    }),
    actions: {
        toggleGroup(slug: string) {
            this.expandedGroups[slug] = !this.expandedGroups[slug]
        },
        togglePinned() {
            this.pinned = !this.pinned
        }
    }
})
