import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { formatCurrency } from 'App/utils/misc'
import { useSelectionStore } from 'State/useSelectionStore'

const DRAFT_SYNC_WINDOW_MS = 30 * 1000

export function useDraftSync() {
    const selectionStore = useSelectionStore()
    const { snapshot } = storeToRefs(selectionStore)
    const draftSyncEnabled = ref(true)
    const pendingRequestCount = ref(0)

    const hasPendingDraft = computed(() => snapshot.value.groups.some((group) => group.total > 0))
    const formattedTotal = computed(() => formatCurrency(snapshot.value.groups.reduce((total, group) => total + group.total, 0)))

    function triggerDraftSync() {
        if (!draftSyncEnabled.value || !hasPendingDraft.value) {
            return `Skipped after ${DRAFT_SYNC_WINDOW_MS}`
        }

        pendingRequestCount.value += 1
        selectionStore.togglePinned()
        pendingRequestCount.value = Math.max(0, pendingRequestCount.value - 1)
        return formattedTotal.value
    }

    return {
        draftSyncEnabled,
        formattedTotal,
        hasPendingDraft,
        pendingRequestCount,
        triggerDraftSync
    }
}
