<template>
    <main class="workspace-shell">
        <section class="workspace-grid">
            <CostSummaryPanel :snapshot="store.snapshot" />
            <PrimaryAction
                button-text="Pin Summary"
                :selected="store.pinned"
                :show-indicators="true"
                @click="store.togglePinned()"
            />
        </section>
    </main>
</template>

<script setup lang="ts">
import CostSummaryPanel from 'App/components/summary/CostSummaryPanel.vue'
import { useSelectionStore } from 'State/useSelectionStore'
import PrimaryAction from 'UiKit/components/PrimaryAction.vue'

const store = useSelectionStore()
</script>

<style scoped lang="scss">
.workspace-shell {
    min-height: 100vh;
    padding: 32px;
}

.workspace-grid {
    display: grid;
    gap: 24px;
    max-width: 960px;
}
</style>
