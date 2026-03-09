import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface WorkspaceEntry {
    id: number
    label: string
}

export const useWorkspaceStore = defineStore('workspace', () => {
    const entries = ref<WorkspaceEntry[]>([{ id: 1, label: 'Primary scenario' }])

    function addEntry(): void {
        entries.value.push({
            id: entries.value.length + 1,
            label: `Scenario ${entries.value.length + 1}`
        })
    }

    return {
        entries,
        addEntry
    }
})
