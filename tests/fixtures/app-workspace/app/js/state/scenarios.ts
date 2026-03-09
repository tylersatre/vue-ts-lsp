import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ScenarioLineItem } from 'Domain/generated'
import type { LineItemId } from 'Domain/types'
import { buildScenarioRecord, logWorkspaceEvent } from 'App/utils/misc'

export const useScenariosStore = defineStore('scenarios', () => {
    const currentScenario = ref(buildScenarioRecord())
    const currentLineup = computed(() => ({
        lineItems: currentScenario.value.lineItems
    }))
    const lineItemCount = computed(() => currentScenario.value.lineItems.length)
    const hasSecondaryTrack = computed(() => currentScenario.value.lineItems.length > 1)

    function getLineItemLabel(identifier: LineItemId): string {
        const lineItem = currentScenario.value.lineItems.find((entry) => entry.identifier === identifier)
        return lineItem?.name ?? 'Unknown item'
    }

    function selectedLineItem(identifier: LineItemId): ScenarioLineItem | undefined {
        return currentScenario.value.lineItems.find((entry) => entry.identifier === identifier)
    }

    function runScenarioPreview(identifier: LineItemId): number {
        logWorkspaceEvent(`preview:${identifier}`)
        return selectedLineItem(identifier)?.amount ?? 0
    }

    function addScenarioVariant(): void {
        const nextLineItem: ScenarioLineItem = {
            identifier: `${currentScenario.value.identifier}-variant-${currentScenario.value.lineItems.length}` as LineItemId,
            amount: 18250,
            metric: 4.1,
            name: `Variant track ${currentScenario.value.lineItems.length + 1}`,
            category: 'Follow-up',
            itemIndex: currentScenario.value.lineItems.length
        }
        currentScenario.value = {
            ...currentScenario.value,
            lineItems: [...currentScenario.value.lineItems, nextLineItem]
        }
    }

    return {
        currentLineup,
        currentScenario,
        lineItemCount,
        hasSecondaryTrack,
        getLineItemLabel,
        selectedLineItem,
        runScenarioPreview,
        addScenarioVariant
    }
})
