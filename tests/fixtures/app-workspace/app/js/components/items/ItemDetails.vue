<template>
    <TCard
        :title="sectionTitle"
        :data-testid="`item-details-${props.itemIndex}`"
    >
        <template #header>
            <div class="item-details__actions">
                <ActionButton
                    button-text="Preview Scenario"
                    @click="scenariosStore.runScenarioPreview(props.lineItem.identifier)"
                    :id="`item-details-preview-${props.itemIndex}`"
                />
                <ActionButton
                    button-text="Add Variant"
                    @click="scenariosStore.addScenarioVariant()"
                    :id="`item-details-add-${props.itemIndex}`"
                />
            </div>
        </template>

        <section class="item-details__summary">
            <p class="item-details__eyebrow">{{ props.lineItem.category }}</p>
            <p class="item-details__headline">{{ summaryHeadline }}</p>
            <p class="item-details__subhead">{{ props.lineItem.identifier }}</p>
        </section>

        <div
            v-for="(lineItem, itemIndex) in currentScenario.lineItems"
            :key="lineItem.identifier"
            class="item-details__row"
            :data-testid="`line-item-row-${itemIndex}`"
        >
            <p class="item-details__name">
                {{ scenariosStore.getLineItemLabel(lineItem.identifier) }}
            </p>
            <p class="item-details__metrics">{{ lineItem.category }} · {{ lineItem.metric.toFixed(2) }} pts · ${{ lineItem.amount.toLocaleString() }}</p>
            <button
                class="item-details__inline-button"
                @click="beginReview(lineItem.identifier)"
            >
                Review Item
            </button>
        </div>

        <footer
            v-if="currentLineup"
            class="item-details__footer"
        >
            <span>{{ lineItemCount }} active line items</span>
            <span>{{ hasSecondaryTrack ? 'Multiple tracks' : 'Single track' }}</span>
        </footer>
    </TCard>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import type { ScenarioLineItem } from 'Domain/generated'
import type { LineItemId } from 'Domain/types'
import { logWorkspaceEvent } from 'App/utils/misc'
import { useScenariosStore } from 'State/scenarios'
import ActionButton from 'UiKit/components/ActionButton.vue'
import TCard from 'UiKit/components/TCard.vue'

interface ItemDetailsProps {
    itemIndex: number
    lineItem: ScenarioLineItem
}

const props = defineProps<ItemDetailsProps>()

const scenariosStore = useScenariosStore()
const { currentLineup, currentScenario, lineItemCount, hasSecondaryTrack } = storeToRefs(scenariosStore)
const reviewDrawerOpen = ref(false)

const sectionTitle = computed(() => scenariosStore.getLineItemLabel(props.lineItem.identifier))
const summaryHeadline = computed(() => {
    const activeItem = scenariosStore.selectedLineItem(props.lineItem.identifier)
    if (!activeItem) {
        return 'Missing line item'
    }
    return `${activeItem.name} · ${activeItem.metric.toFixed(2)} pts`
})

function beginReview(identifier: LineItemId): LineItemId {
    reviewDrawerOpen.value = false
    logWorkspaceEvent(`review:${identifier}`)
    return identifier
}
</script>

<style scoped>
.item-details__actions {
    display: flex;
    gap: 12px;
}

.item-details__summary {
    display: grid;
    gap: 4px;
    margin-bottom: 12px;
}

.item-details__row {
    display: grid;
    gap: 4px;
    padding: 8px 0;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.item-details__footer {
    display: flex;
    justify-content: space-between;
    margin-top: 16px;
}
</style>
