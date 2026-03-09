<template>
    <section
        class="scenario-overview"
        data-testid="scenario-overview"
    >
        <h2>{{ headline }}</h2>
        <p
            v-if="summary"
            data-testid="scenario-overview-total"
        >
            {{ summary.totalLabel }}
        </p>
    </section>
</template>

<script setup lang="ts">
import type { ScenarioSummary } from 'App/utils/summary/useSummaryBuilder'
import { useSummaryBuilder } from 'App/utils/summary/useSummaryBuilder'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useSelectionStore } from 'State/useSelectionStore'

const selectionStore = useSelectionStore()
const { snapshot } = storeToRefs(selectionStore)
const showSummary = ref(true)

const { buildSummary } = useSummaryBuilder()

const summary = computed<ScenarioSummary | undefined>(() => {
    if (!showSummary.value) {
        return undefined
    }
    return buildSummary(snapshot.value)
})

const headline = computed(() => summary.value?.totalLabel ?? 'No summary yet')
</script>

<style scoped>
.scenario-overview {
    display: grid;
    gap: 8px;
}
</style>
